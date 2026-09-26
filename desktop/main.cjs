// A thin shell around the web client: one window, a trusted launch screen and title bar, and the game in a view with no extra powers.
const { app, BaseWindow, WebContentsView, Menu, clipboard, dialog, ipcMain, net, protocol, session } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { join, normalize } = require("node:path");
const { pathToFileURL } = require("node:url");

const mac = process.platform === "darwin";
const BAR = 36;
const RELAY = process.env.SANDBOX_RELAY ?? "https://sandbox-relay.lundqvistliss.com";
const ALLOWED = new Set(["pointerLock", "fullscreen", "clipboard-sanitized-write"]);

/** An invite or personal link passed on the command line, e.g. `sandbox http://host:7777/#invite=…`. */
const linkIn = (argv) => argv.slice(1).find((a) => /^https?:\/\//.test(a));

// A second copy can't open the saved logins, so it hands its link over to the first.
if (!app.requestSingleInstanceLock()) {
  console.log("Sandbox is already open");
  app.exit();
}
app.on("second-instance", (_event, argv) => {
  if (win.isMinimized()) win.restore();
  win.focus();
  const link = linkIn(argv);
  if (link) play(link);
});

/** The engine this app hosts games with: its launcher, run by the bun shipped inside the app, with its games in the app's data folder. */
const ENGINE = app.isPackaged ? join(process.resourcesPath, "engine") : join(__dirname, "..");
const BUN = app.isPackaged ? join(ENGINE, "bun") : "bun";
/** The game's own front end (fonts, clips, menu styles), which the start screen uses too, so it works offline. */
const FRONT = join(ENGINE, "engine/client");
protocol.registerSchemesAsPrivileged([{ scheme: "sandbox", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const STATE = join(app.getPath("userData"), "state.json");
/** @type {{ fullscreen?: boolean, recents: { url: string, name: string, at: number }[], hosts: Record<string, string>, mic: string[], port?: number }} Joined games by shareable address; main menus opened, by host key; the port this app hosts on. */
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
  const view = new WebContentsView({ webPreferences: { preload: join(__dirname, "game-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
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
    // The relay's own pages, like its join page, are not a game.
    const relayPage = u.origin === new URL(RELAY).origin && !u.pathname.startsWith("/r/");
    if (u.pathname.endsWith("/menu")) {
      if (key) hostSeen(key, worldBase(u));
    } else if (!relayPage) void remember(worldBase(u));
  });
  wc.on("did-fail-load", (_, code, description, _url, mainFrame) => {
    if (mainFrame && code !== -3) fail(description);
  });
  wc.on("dom-ready", () => wc.send("update", update));
  win.contentView.addChildView(view);
  layout();
  showMode();
  void wc.loadURL(url.href);
  wc.focus();
  return null;
}

const DATA = join(app.getPath("userData"), "data");
/** @type {{ proc: import("node:child_process").ChildProcess, base: string, key: string } | null} */ let server = null;
/** @type {Promise<{ base: string, key: string }> | null} */ let starting = null;

const portFree = (port) =>
  new Promise((resolve) => {
    const probe = createServer().once("error", () => resolve(0));
    probe.listen(port, () => {
      const got = probe.address().port;
      probe.close(() => resolve(got));
    });
  });

/** Starts this app's game server the first time it's needed, on the port it used before when that is still free. */
function startServer() {
  if (server) return Promise.resolve(server);
  starting ??= (async () => {
    const port = (state.port && (await portFree(state.port))) || (await portFree(0));
    state.port = port;
    save();
    mkdirSync(DATA, { recursive: true });
    const log = openSync(join(app.getPath("userData"), "server.log"), "a");
    const proc = spawn(BUN, [join(ENGINE, "engine/launcher.ts")], {
      env: { ...process.env, PORT: String(port), SANDBOX_DATA: DATA, SANDBOX_NO_OPEN: "1", SANDBOX_EXIT_WITH_STDIN: "1", SANDBOX_RELAY: RELAY },
      stdio: ["pipe", log, log],
    });
    const exited = new Promise((resolve) => proc.once("exit", resolve));
    let failed = null;
    proc.once("error", (e) => (failed = e));
    const base = `http://localhost:${port}`;
    for (const until = Date.now() + 20000; Date.now() < until; await new Promise((r) => setTimeout(r, 200))) {
      if (failed || proc.exitCode !== null || proc.signalCode) break;
      const local = await ask(`${base}/api/local-key`, null, 500).then((r) => (r.ok ? r.json() : null), () => null);
      if (!local) continue;
      server = { proc, base, key: local.key };
      void exited.then(() => {
        console.log(`The game server stopped (${proc.signalCode ?? `code ${proc.exitCode}`}).`);
        if (server?.proc === proc) server = null;
      });
      return server;
    }
    proc.kill();
    throw new Error(failed ? `Couldn't start the game server: ${failed.message}` : `The game server didn't start. ${join(app.getPath("userData"), "server.log")} says why.`);
  })().finally(() => (starting = null));
  return starting;
}

/** Hosts a game of this computer's: shares it through the relay, which gives it a join code, and opens its screen in the main menu. */
async function hostGame(target) {
  const { base, key } = await startServer();
  const menu = (action, body) => fetch(`${base}/api/menu/${action}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${key}` }, body: body && JSON.stringify(body) }).then((r) => r.json());
  let s = await menu("state");
  if (!s.tunnel) s = await menu("share", { on: true });
  // Offline, the relay never answers; the game still opens here, without a public link.
  for (const until = Date.now() + 8000; !s.tunnel?.code && Date.now() < until; await new Promise((r) => setTimeout(r, 250))) s = await menu("state");
  const share = s.tunnel?.url ?? base;
  return play(`${share}/menu#key=${key}&${target === "new" ? "screen=create" : `world=${target}`}`);
}

async function stopServer() {
  const current = server;
  if (!current) return;
  server = null;
  const exited = new Promise((resolve) => current.proc.once("exit", resolve));
  current.proc.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  if (current.proc.exitCode === null && !current.proc.signalCode) current.proc.kill("SIGKILL");
}

/** Players in the game this app hosts, besides the host playing it here. */
async function guests() {
  if (!server) return null;
  const s = await ask(`${server.base}/api/menu/state`, server.key).then((r) => r.json(), () => null);
  if (!s?.running) return null;
  const online = s.running.players.filter((p) => p.online).length;
  const here = game && [server.base, s.tunnel?.url].includes(worldBase(new URL(game.view.webContents.getURL() || "about:blank")));
  return { name: s.running.name, count: online - (here ? 1 : 0) };
}

/** The games this app hosts, read from its data folder so they show without starting the server. */
function ownGames(live) {
  const dir = join(DATA, "worlds");
  const ids = existsSync(dir) ? readdirSync(dir) : [];
  return ids.flatMap((id) => {
    try {
      const { name } = JSON.parse(readFileSync(join(dir, id, "config.json"), "utf8"));
      const saved = [join(dir, id, "world.sqlite"), join(dir, id, "config.json")].find(existsSync);
      return [{ name, at: statSync(saved).mtimeMs, live: live === id, url: `local:${id}` }];
    } catch {
      return [];
    }
  });
}

const ownKey = () => {
  try {
    return JSON.parse(readFileSync(join(DATA, "launcher.json"), "utf8")).hostKey;
  } catch {
    return null;
  }
};

/** A main menu this app opened; a launcher keeps one host key, so its local and relay addresses count once. */
function hostSeen(key, base) {
  if (state.hosts[key] === base) return;
  state.hosts[key] = base;
  save();
}

const ask = (url, key, ms = 1500) => fetch(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(ms) });

/** The start screen's games: this app's own, each other launcher's whose main menu was opened here, through its relay address when it shares, and the games joined. */
async function games() {
  const own = ownKey();
  const ownState = server && (await ask(`${server.base}/api/menu/state`, server.key).then((r) => r.json(), () => null));
  const menus = await Promise.all(
    Object.entries(state.hosts).map(async ([key, base]) => {
      if (key === own) return { key, base, s: null };
      const res = await ask(`${base}/api/menu/state`, key).catch(() => null);
      if (res?.status === 401) {
        delete state.hosts[key];
        save();
      }
      return res?.ok ? { key, base, s: await res.json() } : null;
    }),
  );
  const hosted = ownGames(ownState?.running?.id);
  const mine = new Set();
  for (const m of menus) {
    if (!m) continue;
    mine.add(m.base);
    if (!m.s) continue;
    const share = m.s.tunnel?.url ?? m.base;
    mine.add(share);
    for (const w of m.s.worlds) hosted.push({ name: w.name, at: w.played, live: m.s.running?.id === w.id, url: `${share}/menu#key=${m.key}&world=${w.id}` });
  }
  const copied = (await clipboard.readText()).trim().slice(0, 2000);
  return {
    hosted,
    joined: state.recents.filter((r) => !mine.has(r.url) && !(server && r.url === server.base)),
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
  shell.webContents.once("did-finish-load", () => console.log("Sandbox is open"));
  shell.webContents.on("did-finish-load", () => shell.webContents.send("update", update));
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
    if (quitting) return;
    event.preventDefault();
    void quit();
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
  ipcMain.handle("open", (event, url) => {
    if (!fromShell(event)) return null;
    const own = String(url).match(/^local:(.+)$/)?.[1];
    return own ? hostGame(own).catch((e) => e.message) : play(String(url));
  });
  ipcMain.handle("forget", (event, url) => {
    if (!fromShell(event)) return;
    state.recents = state.recents.filter((r) => r.url !== url);
    save();
  });
  ipcMain.on("leave", (event) => fromShell(event) && leave());
  ipcMain.handle("update", (event) => (fromShell(event) || event.sender === game?.view.webContents) && install());
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
  if (app.isPackaged) void checkUpdate();
});

/** The newest release when it is newer than this app, polled like PR Cockpit: every 5 minutes, backing off while GitHub rate-limits. */
let update = null;
let checkEvery = 5 * 60 * 1000;
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
async function checkUpdate() {
  const res = await net.fetch("https://api.github.com/repos/theolundqvist/sandbox/releases/latest", { headers: { accept: "application/vnd.github+json" } }).catch(() => null);
  checkEvery = res?.status === 403 || res?.status === 429 ? Math.min(checkEvery * 2, 6 * 60 * 60 * 1000) : 5 * 60 * 1000;
  const release = res?.ok ? await res.json().catch(() => null) : null;
  if (release?.tag_name) {
    const version = release.tag_name.replace(/^v/, "");
    const next = newer(version, app.getVersion()) ? version : null;
    if (next !== update) {
      update = next;
      shell?.webContents.send("update", update);
      game?.view.webContents.send("update", update);
    }
  }
  setTimeout(checkUpdate, checkEvery);
}

/** Updates the way the installer does, since Squirrel won't update an unsigned Mac app: this app quits, and the installer swaps in the release and opens it again. */
let installing = false;
async function install() {
  if (!update || installing) return;
  const hosting = await guests();
  if (game || hosting?.count) {
    const detail = hosting?.count ? `${hosting.count === 1 ? "1 player is" : `${hosting.count} players are`} in ${hosting.name}. Updating ends the game for them.` : `You're in ${game.name}. Sandbox restarts to update.`;
    const { response } = await dialog.showMessageBox(win, { type: "question", buttons: ["Update", "Not now"], defaultId: 0, cancelId: 1, message: `Update to Sandbox ${update}?`, detail });
    if (response !== 0) return;
  }
  installing = true;
  const log = openSync(join(app.getPath("userData"), "update.log"), "a");
  spawn("bash", ["-c", "curl -fsSL https://raw.githubusercontent.com/theolundqvist/sandbox/master/desktop/install | bash"], { detached: true, stdio: ["ignore", log, log] }).unref();
  quitting = true;
  await stopServer();
  app.quit();
}

/** Asks first when that leaves a game: the host's own, or friends still in the game this app hosts. Then stops the server. */
let confirming = null;
function quit() {
  confirming ??= (async () => {
    const hosting = await guests();
    if (game || hosting?.count) {
      const detail = hosting?.count ? `${hosting.count === 1 ? "1 player is" : `${hosting.count} players are`} in ${hosting.name}. Quitting ends the game for them.` : `You're in ${game.name}.`;
      const { response } = await dialog.showMessageBox(win, { type: "question", buttons: ["Quit", hosting?.count ? "Keep hosting" : "Keep playing"], defaultId: 1, cancelId: 1, message: "Quit Sandbox?", detail });
      if (response !== 0) return;
    }
    quitting = true;
    await stopServer();
    app.quit();
  })().finally(() => (confirming = null));
  return confirming;
}

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  void quit();
});
app.on("window-all-closed", () => app.quit());
