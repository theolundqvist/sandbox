// A thin shell around the web client: one window, a trusted launch screen and title bar, and the game in a view with no extra powers.
const { app, BaseWindow, WebContentsView, Menu, clipboard, dialog, ipcMain, net, protocol, session } = require("electron");
const { readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join, normalize } = require("node:path");
const { pathToFileURL } = require("node:url");

const mac = process.platform === "darwin";
const BAR = 36;
const LOCAL = "http://localhost:7777";
const RELAY = process.env.SANDBOX_RELAY ?? "https://sandbox-relay.lundqvistliss.com";
const ALLOWED = new Set(["pointerLock", "fullscreen", "clipboard-sanitized-write"]);

/** An invite or personal link passed on the command line, e.g. `sandbox http://host:7777/#invite=…`. */
const linkIn = (argv) => argv.slice(1).find((a) => /^https?:\/\//.test(a));

// A second copy can't open the saved logins, so it hands its link over to the first.
if (!app.requestSingleInstanceLock()) app.exit();
app.on("second-instance", (_event, argv) => {
  if (win.isMinimized()) win.restore();
  win.focus();
  const link = linkIn(argv);
  if (link) play(link);
});

/** The game's own front end (fonts, clips, menu styles), shipped inside the app so the start screen works offline. */
const FRONT = app.isPackaged ? join(process.resourcesPath, "client") : join(__dirname, "../engine/client");
protocol.registerSchemesAsPrivileged([{ scheme: "sandbox", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const STATE = join(app.getPath("userData"), "state.json");
/** @type {{ fullscreen?: boolean, recents: { url: string, name: string, at: number }[], hosts: Record<string, string>, mic: string[] }} Joined games by shareable address; main menus opened, by host key. */
const state = { recents: [], hosts: {}, mic: [] };
try {
  Object.assign(state, JSON.parse(readFileSync(STATE, "utf8")));
} catch {}
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

/** @type {BaseWindow} */ let win;
/** @type {WebContentsView} */ let shell;
/** @type {{ view: WebContentsView, name: string } | null} */ let game = null;
let quitting = false;

function layout() {
  const { width, height } = win.contentView.getBounds();
  const top = game && !win.isFullScreen() ? BAR : 0;
  shell.setBounds({ x: 0, y: 0, width, height: game ? top : height });
  game?.view.setBounds({ x: 0, y: top, width, height: height - top });
}

const toggleFullscreen = () => win.setFullScreen(!win.isFullScreen());
/** Reloads the game where it is; the world's key is saved in the page, so it rejoins. */
const reload = () => game?.view.webContents.reload();
const showMode = () => shell.webContents.send("mode", game && { name: game.name });

/** F11 everywhere, and Ctrl+Shift+R to reload off a Mac; a Mac's Ctrl+Cmd+F and Cmd+R come from the menu. With no menu elsewhere, Ctrl+W, Ctrl+R, F5, Alt and friends reach the game as plain keys. */
function keys(event, input) {
  if (input.type !== "keyDown") return;
  if (input.key === "F11") {
    event.preventDefault();
    toggleFullscreen();
  } else if (!mac && input.code === "KeyR" && input.control && input.shift && !input.alt) {
    event.preventDefault();
    reload();
  }
}

/** The world's address: the host's origin, plus /r/<room> when it is reached through the relay. */
const worldBase = (url) => url.origin + (url.pathname.match(/^\/r\/[a-z0-9-]+/)?.[0] ?? "");

async function remember(base) {
  const info = await session.defaultSession.fetch(`${base}/api/info`).then((r) => r.json()).catch(() => null);
  const name = info?.name ?? new URL(base).host;
  state.recents = [{ url: base, name, at: Date.now() }, ...state.recents.filter((r) => r.url !== base)].slice(0, 8);
  save();
  if (game) {
    game.name = name;
    showMode();
  }
}

function play(raw) {
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return "That doesn't look like a link.";
  }
  if (!/^https?:$/.test(url.protocol)) return "Paste the http:// or https:// link your host sent.";
  leave();
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  view.setBackgroundColor("#0b0b0c");
  game = { view, name: url.host };
  const fail = (reason) => {
    if (game?.view !== view) return;
    console.log(`Couldn't reach ${url.href}: ${reason}`);
    leave();
    shell.webContents.send("down", { url: url.href, host: url.host });
  };
  // A host that drops packets never answers; don't leave a blank window for the minute Chromium waits.
  const timer = setTimeout(() => fail("no answer"), 15000);
  const wc = view.webContents;
  // Lets the web client skip its "get the desktop app" offer.
  wc.setUserAgent(`${wc.getUserAgent()} SandboxDesktop`);
  const stayHome = (event, to) => {
    if (new URL(to).origin !== url.origin) event.preventDefault();
  };
  wc.on("will-navigate", stayHome);
  wc.on("will-redirect", stayHome);
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("before-input-event", keys);
  wc.on("did-navigate", (_, to, status) => {
    clearTimeout(timer);
    if (status >= 400) return fail(`HTTP ${status}`);
    const u = new URL(to);
    const key = new URLSearchParams(u.hash.slice(1)).get("key");
    if (u.pathname.endsWith("/menu")) {
      if (key) hostSeen(key, worldBase(u));
    } else void remember(worldBase(u));
  });
  wc.on("did-fail-load", (_, code, description, _url, mainFrame) => {
    if (mainFrame && code !== -3) fail(description);
  });
  win.contentView.addChildView(view);
  layout();
  showMode();
  void wc.loadURL(url.href);
  wc.focus();
  return null;
}

/** A main menu this app opened; a launcher keeps one host key, so its local and relay addresses count once. */
function hostSeen(key, base) {
  if (state.hosts[key] === base) return;
  state.hosts[key] = base;
  save();
}

const ask = (url, key, ms = 1500) => fetch(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(ms) });

/** The start screen's games: each known launcher's saved games, opened through its relay address when it shares, and the games joined. */
async function games() {
  const local = await ask(`${LOCAL}/api/local-key`, null, 800).then((r) => (r.ok ? r.json() : null), () => null);
  if (local) hostSeen(local.key, LOCAL);
  const menus = await Promise.all(
    Object.entries(state.hosts).map(async ([key, base]) => {
      const res = await ask(`${base}/api/menu/state`, key).catch(() => null);
      if (res?.status === 401) {
        delete state.hosts[key];
        save();
      }
      return res?.ok ? { key, base, s: await res.json() } : null;
    }),
  );
  const hosted = [];
  const mine = new Set();
  let newGame = null;
  for (const m of menus) {
    if (!m) continue;
    const share = m.s.tunnel?.url ?? m.base;
    mine.add(m.base).add(share);
    if (m.base === LOCAL) newGame = `${share}/menu#key=${m.key}&screen=create`;
    for (const w of m.s.worlds) hosted.push({ name: w.name, at: w.played, live: m.s.running?.id === w.id, url: `${share}/menu#key=${m.key}&world=${w.id}` });
  }
  const copied = (await clipboard.readText()).trim().slice(0, 2000);
  return {
    hosted,
    joined: state.recents.filter((r) => !mine.has(r.url)),
    newGame,
    copied,
  };
}

function leave() {
  if (!game) return;
  win.contentView.removeChildView(game.view);
  game.view.webContents.close();
  game = null;
  layout();
  showMode();
  shell.webContents.focus();
}

async function askMic(origin) {
  if (state.mic.includes(origin)) return true;
  const { response } = await dialog.showMessageBox(win, { type: "question", buttons: ["Allow", "Not now"], defaultId: 0, cancelId: 1, message: "Let this world use your microphone?", detail: `${origin} uses it for push to talk while you hold T.` });
  if (response !== 0) return false;
  state.mic.push(origin);
  save();
  return true;
}

function createWindow() {
  win = new BaseWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: "Sandbox",
    backgroundColor: "#0b0b0c",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 14, y: 11 },
    titleBarOverlay: mac ? undefined : { color: "#0b0b0c", symbolColor: "#e9e4d8", height: BAR },
    fullscreen: !!state.fullscreen,
  });
  shell = new WebContentsView({ webPreferences: { preload: join(__dirname, "preload.cjs"), sandbox: true, contextIsolation: true } });
  shell.setBackgroundColor("#0b0b0c");
  shell.webContents.on("before-input-event", keys);
  shell.webContents.on("will-navigate", (event) => event.preventDefault());
  shell.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.contentView.addChildView(shell);
  void shell.webContents.loadURL("sandbox://app/shell.html");
  const link = linkIn(process.argv);
  if (link) shell.webContents.once("did-finish-load", () => play(link));
  layout();
  win.contentView.on("bounds-changed", layout);
  for (const change of ["enter-full-screen", "leave-full-screen"])
    win.on(change, () => {
      state.fullscreen = win.isFullScreen();
      save();
      layout();
    });
  win.on("focus", () => (game ? game.view : shell).webContents.focus());
  win.on("close", (event) => {
    if (!game || quitting) return;
    event.preventDefault();
    const answer = dialog.showMessageBoxSync(win, { type: "question", buttons: ["Quit", "Keep playing"], defaultId: 1, cancelId: 1, message: "Quit Sandbox?", detail: `You're in ${game.name}.` });
    if (answer === 0) {
      quitting = true;
      win.close();
    }
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    mac
      ? Menu.buildFromTemplate([
          { role: "appMenu", submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
          { role: "editMenu" },
          { label: "View", submenu: [{ label: "Reload", accelerator: "Cmd+R", click: reload }, { label: "Toggle Full Screen", accelerator: "Ctrl+Cmd+F", click: toggleFullscreen }] },
        ])
      : null,
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => ALLOWED.has(permission) || (permission === "media" && state.mic.includes(URL.parse(origin)?.origin)));
  session.defaultSession.setPermissionRequestHandler((_wc, permission, grant, details) => {
    if (ALLOWED.has(permission)) return grant(true);
    if (permission === "media" && "mediaTypes" in details && details.mediaTypes?.every((t) => t === "audio")) return void askMic(new URL(details.requestingUrl).origin).then(grant);
    grant(false);
  });

  const fromShell = (event) => event.sender === shell.webContents;
  ipcMain.handle("state", (event) => (fromShell(event) ? games() : null));
  ipcMain.handle("open", (event, url) => (fromShell(event) ? play(String(url)) : null));
  ipcMain.handle("forget", (event, url) => {
    if (!fromShell(event)) return;
    state.recents = state.recents.filter((r) => r.url !== url);
    save();
  });
  ipcMain.on("leave", (event) => fromShell(event) && leave());
  ipcMain.on("quit", (event) => fromShell(event) && app.quit());

  protocol.handle("sandbox", (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path.startsWith("/relay/join/")) return net.fetch(`${RELAY}/join/${encodeURIComponent(path.slice(12))}`);
    if (path === "/shell.html") return net.fetch(pathToFileURL(join(__dirname, "shell.html")).href);
    if (path === "/clips/") return Response.json(readdirSync(join(FRONT, "clips")).filter((f) => f.endsWith(".mp4")));
    const file = normalize(join(FRONT, path));
    return file.startsWith(FRONT) ? net.fetch(pathToFileURL(file).href) : new Response("not found", { status: 404 });
  });
  createWindow();
});

app.on("before-quit", () => {
  if (mac) quitting = true;
});
app.on("window-all-closed", () => app.quit());
