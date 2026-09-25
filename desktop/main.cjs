// A thin shell around the web client: one window, a trusted launch screen and title bar, and the game in a view with no extra powers.
const { app, BaseWindow, WebContentsView, Menu, clipboard, dialog, ipcMain, session } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const mac = process.platform === "darwin";
const BAR = 36;
const LOCAL = "http://localhost:7777";
const ALLOWED = new Set(["pointerLock", "fullscreen", "clipboard-sanitized-write"]);

// A second copy can't open the saved logins, so it hands over to the first.
if (!app.requestSingleInstanceLock()) app.exit();
app.on("second-instance", () => {
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const STATE = join(app.getPath("userData"), "state.json");
/** @type {{ fullscreen?: boolean, recents: { url: string, name: string, at: number }[], mic: string[] }} */
const state = { recents: [], mic: [] };
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
const showMode = () => shell.webContents.send("mode", game && { name: game.name });

/** F11 everywhere; Ctrl+Cmd+F on a Mac comes from the menu. With no menu elsewhere, Ctrl+W, Ctrl+R, F5, Alt and friends reach the game as plain keys. */
function keys(event, input) {
  if (input.type === "keyDown" && input.key === "F11") {
    event.preventDefault();
    toggleFullscreen();
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
  game = { view, name: url.host };
  const wc = view.webContents;
  const stayHome = (event, to) => {
    if (new URL(to).origin !== url.origin) event.preventDefault();
  };
  wc.on("will-navigate", stayHome);
  wc.on("will-redirect", stayHome);
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("before-input-event", keys);
  wc.on("did-navigate", (_, to) => {
    const u = new URL(to);
    if (u.pathname !== "/menu") void remember(worldBase(u));
  });
  wc.on("did-fail-load", (_, code, description, _url, mainFrame) => {
    if (!mainFrame || code === -3 || game?.view !== view) return;
    leave();
    shell.webContents.send("error", `Couldn't reach ${url.host} (${description}). Is the world running?`);
  });
  win.contentView.addChildView(view);
  layout();
  showMode();
  void wc.loadURL(url.href);
  wc.focus();
  return null;
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
  void shell.webContents.loadFile(join(__dirname, "shell.html"));
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
          { label: "View", submenu: [{ label: "Toggle Full Screen", accelerator: "Ctrl+Cmd+F", click: toggleFullscreen }] },
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
  ipcMain.handle("state", async (event) => {
    if (!fromShell(event)) return null;
    const local = await session.defaultSession.fetch(`${LOCAL}/menu`, { method: "HEAD", signal: AbortSignal.timeout(800) }).then((r) => r.ok, () => false);
    const copied = (await clipboard.readText()).trim();
    return { recents: state.recents, local: local ? `${LOCAL}/menu` : null, copied: /^\S+#(invite|key)=\S+$/.test(copied) ? copied : null };
  });
  ipcMain.handle("open", (event, url) => (fromShell(event) ? play(String(url)) : null));
  ipcMain.on("leave", (event) => fromShell(event) && leave());
  ipcMain.on("quit", (event) => fromShell(event) && app.quit());

  createWindow();
});

app.on("before-quit", () => {
  if (mac) quitting = true;
});
app.on("window-all-closed", () => app.quit());
