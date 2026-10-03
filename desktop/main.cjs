// A thin shell around the web client: one window, a trusted launch screen and title bar, and the game in a view with no extra powers.
const { app, BaseWindow, WebContentsView, Menu, clipboard, dialog, ipcMain, net, protocol, safeStorage, session, shell: desktop } = require("electron");
const { execFile, spawn } = require("node:child_process");
const { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { homedir, userInfo } = require("node:os");
const { delimiter, join, normalize } = require("node:path");
const { pathToFileURL } = require("node:url");

const mac = process.platform === "darwin";
const windows = process.platform === "win32";
const BAR = 36;
const RELAY = process.env.SANDBOX_RELAY ?? "https://sandbox-relay.lundqvistliss.com";
const COMMUNITY = process.env.SANDBOX_COMMUNITY ?? "https://sandbox.api.lundqvistliss.com";
const RELEASES = process.env.SANDBOX_UPDATES ?? "https://api.github.com/repos/theolundqvist/sandbox/releases/latest";
/** The installer and the build from the release being installed, so a broken master never breaks an update. */
const INSTALLER = (version) => process.env.SANDBOX_INSTALLER ?? `https://raw.githubusercontent.com/theolundqvist/sandbox/v${version}/desktop/install${windows ? ".ps1" : ""}`;
const DOWNLOADS = (version) => process.env.SANDBOX_RELEASE ?? `https://github.com/theolundqvist/sandbox/releases/download/v${version}`;
const ALLOWED = new Set(["pointerLock", "fullscreen", "clipboard-sanitized-write"]);
/** Pages a game may open in the browser: where the host gets a speech key, from each provider in engine/voice.ts, and where a player downloads an agent app from the Agent page. */
const OUTSIDE = /^https:\/\/((console\.groq\.com|platform\.openai\.com|aistudio\.google\.com|elevenlabs\.io|console\.deepgram\.com)\/|(claude|chatgpt)\.com\/download$)/;
/** The Agent page's Open in ChatGPT, which only types the prompt into a new Codex chat. */
const AGENT_LINK = /^codex:\/\/new\?prompt=/;
/** The agents this app starts in its own terminal, each from its maker's installer, in the world's folder where its allow rule for the world's command sits. The game asks only by id; what runs is decided here. */
const AGENTS = {
  "claude-code": { name: "Claude Code", maker: "Anthropic", bin: "claude", install: "curl -fsSL https://claude.ai/install.sh | bash" },
  codex: { name: "Codex", maker: "OpenAI", bin: "codex", install: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" },
};

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

/** The engine this app hosts worlds with: its launcher, run by the bun shipped inside the app, with its worlds in the app's data folder. */
const ENGINE = app.isPackaged ? join(process.resourcesPath, "engine") : join(__dirname, "..");
const BUN = app.isPackaged ? join(ENGINE, windows ? "bun.exe" : "bun") : "bun";
/** The game's own front end (fonts, stills, menu styles), which the start screen uses too, so it works offline. */
const FRONT = join(ENGINE, "engine/client");
protocol.registerSchemesAsPrivileged([{ scheme: "sandbox", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const STATE = join(app.getPath("userData"), "state.json");
/** @type {{ fullscreen?: boolean, name?: string, recents: { url: string, name: string, at: number }[], hosts: Record<string, string>, mic: string[], last?: string, port?: number, reopen?: { hosting: boolean, url: string | null }, updatedTo?: string }} The name this player joins every world as; joined worlds by shareable address; main menus opened, by host key; the world last played, as its address in Worlds; the port this app hosts on; what to bring back after an update restarts the app, and the version it installed. */
const state = { recents: [], hosts: {}, mic: [] };
try {
  Object.assign(state, JSON.parse(readFileSync(STATE, "utf8")));
} catch {}
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

/** Names are what worlds accept: 2–16 lowercase letters, digits, - or _. */
const NAME = /^[a-z0-9][a-z0-9_-]{1,15}$/;
/** The name asked for on first launch starts as this computer's user name. */
const suggestedName = () => {
  const name = userInfo().username.toLowerCase().replace(/[^a-z0-9_-]/g, "").replace(/^[_-]+/, "").slice(0, 16);
  return NAME.test(name) ? name : "";
};

/** @type {BaseWindow} */ let win;
/** @type {WebContentsView} */ let shell;
/** @type {{ view: WebContentsView, name: string } | null} */ let game = null;
/** @type {{ view: WebContentsView, name: string, pty: import("node-pty").IPty | null, start(cols: number, rows: number): void } | null} The agent running in the terminal pane beside the game. */ let agent = null;
let quitting = false;

function layout() {
  const { width, height } = win.contentView.getBounds();
  const top = game && !win.isFullScreen() ? BAR : 0;
  const pane = agent ? Math.round(Math.min(Math.max(width * 0.4, 420), 640)) : 0;
  shell.setBounds({ x: 0, y: 0, width, height: game ? top : height });
  game?.view.setBounds({ x: 0, y: top, width: width - pane, height: height - top });
  agent?.view.setBounds({ x: width - pane, y: top, width: pane, height: height - top });
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

/** Saves a world the player went into, and unless they only watch its timelapse, makes it the last one played: a world this computer hosts by its entry in Worlds, a joined one by its address. */
async function remember(base, played = true) {
  const info = await session.defaultSession.fetch(`${base}/api/info`).then((r) => r.json()).catch(() => null);
  const name = info?.name ?? state.recents.find((r) => r.url === base)?.name ?? new URL(base).host;
  state.recents = [{ url: base, name, at: Date.now() }, ...state.recents.filter((r) => r.url !== base)].slice(0, 8);
  const host = server?.base === base ? "local" : Object.entries(state.hosts).find(([key, b]) => b === base && key !== ownKey())?.[0];
  if (played && (!host || info?.id)) state.last = host === "local" ? `local:${info.id}` : host ? `${base}/menu#key=${host}&world=${info.id}` : base;
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
  game = { view, name: state.recents.find((r) => r.url === worldBase(url))?.name ?? "" };
  /** Why the game didn't open: this computer is offline, the world is closed, or its host doesn't answer. It opens by itself once the world answers. */
  const fail = (reason, why = "silent") => {
    if (game?.view !== view) return;
    console.log(`Couldn't reach ${url.href}: ${reason}`);
    leave();
    const name = state.recents.find((r) => r.url === worldBase(url))?.name ?? null;
    shell.webContents.send("down", { url: url.href, name, why });
    waitFor(url);
  };
  // A host that drops packets never answers; don't leave a blank window for the minute Chromium waits.
  const timer = setTimeout(() => fail("no answer"), 15000);
  const wc = view.webContents;
  // Lets the web client skip its "get the desktop app" offer.
  wc.setUserAgent(`${wc.getUserAgent()} SandboxDesktop`);
  const stayHome = (event, to) => {
    if (new URL(to).origin === url.origin) return;
    event.preventDefault();
    if (AGENT_LINK.test(to)) void desktop.openExternal(to);
  };
  wc.on("will-navigate", stayHome);
  wc.on("will-redirect", stayHome);
  wc.setWindowOpenHandler(({ url }) => {
    if (OUTSIDE.test(url)) void desktop.openExternal(url);
    return { action: "deny" };
  });
  wc.on("before-input-event", keys);
  wc.on("did-navigate", (_, to, status) => {
    clearTimeout(timer);
    if (status >= 400) return fail(`HTTP ${status}`, status === 503 ? "closed" : "silent");
    const u = new URL(to);
    const hash = new URLSearchParams(u.hash.slice(1));
    const key = hash.get("key");
    // The relay's own pages, like its join page, are not a world.
    const relayPage = u.origin === new URL(RELAY).origin && !u.pathname.startsWith("/r/");
    if (u.pathname.endsWith("/menu")) {
      if (key) hostSeen(key, worldBase(u));
    } else if (!relayPage) void remember(worldBase(u), !hash.has("watch"));
  });
  wc.on("did-fail-load", (_, code, description, _url, mainFrame) => {
    // -106 is Chromium's ERR_INTERNET_DISCONNECTED.
    if (mainFrame && code !== -3) fail(description, code === -106 ? "offline" : "silent");
  });
  wc.on("dom-ready", () => wc.send("update", update));
  win.contentView.addChildView(view);
  layout();
  showMode();
  void wc.loadURL(url.href);
  wc.focus();
  return null;
}

/** A world that didn't open, asked every 2 seconds whether it is back. */
let waiting = null;
function waitFor(url) {
  const check = async () => {
    const back = await ask(`${worldBase(url)}/api/info`).then((r) => r.ok, () => false);
    if (waiting !== timer) return;
    if (back) play(url.href);
    else waiting = timer = setTimeout(check, 2000);
  };
  let timer = setTimeout(check, 2000);
  waiting = timer;
}

const DATA = join(app.getPath("userData"), "data");
const usage = require("./usage.cjs")(DATA, app.getVersion());
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

/** The last lines a log got after `from`, at most 5. */
function lastLines(path, from) {
  const size = statSync(path).size;
  const bytes = Buffer.alloc(Math.min(size - from, 8192));
  const fd = openSync(path, "r");
  readSync(fd, bytes, 0, bytes.length, size - bytes.length);
  closeSync(fd);
  return bytes.toString().split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-5);
}

/** Why a game server didn't start, in one sentence anyone can act on, setting aside what Retry would trip over again. */
function startFailure() {
  const settings = join(DATA, "launcher.json");
  try {
    if (existsSync(settings)) JSON.parse(readFileSync(settings, "utf8"));
  } catch {
    renameSync(settings, `${settings}.damaged`);
    return "A saved settings file is damaged. Retry starts with fresh settings.";
  }
  return "Something went wrong starting the game.";
}

/** Starts this app's game server the first time it's needed, on the port it used before when that is still free. */
function startServer() {
  if (server) return Promise.resolve(server);
  starting ??= (async () => {
    const port = (state.port && (await portFree(state.port))) || (await portFree(0));
    state.port = port;
    save();
    mkdirSync(DATA, { recursive: true });
    const logPath = join(app.getPath("userData"), "server.log");
    const log = openSync(logPath, "a");
    const from = statSync(logPath).size;
    const proc = spawn(BUN, [join(ENGINE, "engine/launcher.ts")], {
      env: { ...process.env, PORT: String(port), SANDBOX_DATA: DATA, SANDBOX_NO_OPEN: "1", SANDBOX_EXIT_WITH_STDIN: "1", SANDBOX_RELAY: RELAY, SANDBOX_VERSION: app.getVersion() },
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
    throw Object.assign(new Error("The game server didn't start."), { log: failed ? [failed.message] : lastLines(logPath, from), cause: startFailure() });
  })().finally(() => (starting = null));
  return starting;
}

/** Hosts a world of this computer's: opens its screen in the main menu here; the launcher shares whatever it hosts through the relay. */
async function hostGame(target) {
  const { base, key } = await startServer();
  const screen = { new: "screen=create", community: "screen=community" }[target] ?? `world=${target}`;
  const opened = play(`${base}/menu#key=${key}&${screen}`);
  setTimeout(beatNow, 5000);
  return opened;
}

/** Starts this app's server again after a restart: the launcher brings back the world it hosted, under the same link. */
async function resumeHosting() {
  const { base, key } = await startServer();
  for (const until = Date.now() + 10000; Date.now() < until; await new Promise((r) => setTimeout(r, 250))) {
    const s = await ask(`${base}/api/menu/state`, key).then((r) => r.json(), () => null);
    if (s?.running) return;
  }
}

async function stopServer() {
  const current = server;
  if (!current) return;
  server = null;
  const exited = new Promise((resolve) => current.proc.once("exit", resolve));
  // The launcher stops its world and exits when its stdin closes, which works where SIGTERM doesn't reach a program: Windows.
  current.proc.stdin.end();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  if (current.proc.exitCode === null && !current.proc.signalCode) current.proc.kill("SIGKILL");
}

/** The Community account's session lives only here, encrypted at rest: never in the engine's data folder, a world's environment or any page. Where the system can't encrypt it, it lasts until the app quits. */
const ACCOUNT = join(app.getPath("userData"), "account.bin");
/** @type {string | null | undefined} */ let accountToken;
function sessionToken() {
  if (accountToken === undefined) {
    try {
      accountToken = safeStorage.decryptString(readFileSync(ACCOUNT));
    } catch {
      accountToken = null;
    }
  }
  return accountToken;
}
function keepSession(token) {
  accountToken = token;
  rmSync(ACCOUNT, { force: true });
  const plain = process.platform === "linux" && safeStorage.getSelectedStorageBackend?.() === "basic_text";
  if (token && safeStorage.isEncryptionAvailable() && !plain) writeFileSync(ACCOUNT, safeStorage.encryptString(token), { mode: 0o600 });
}
/** Community's API as the signed-in account; a session it no longer knows signs this app out. */
async function community(path, { method = "GET", body } = {}) {
  const token = sessionToken();
  const res = await fetch(`${COMMUNITY}${path}`, {
    method,
    headers: { ...(body && { "content-type": "application/json" }), ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!res) throw new Error("Can't reach Community. Check your connection.");
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.status === 401 && token && path !== "/sessions") keepSession(null);
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Community answered ${res.status}. Try again.`), { status: res.status });
  return data;
}
/** A menu action on this app's own launcher. */
async function menu(action, body) {
  const { base, key } = await startServer();
  const res = await fetch(`${base}/api/menu/${action}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}
/** Worlds this computer shared before accounts move to the account signed in here; the launcher then forgets their owner tokens, which no longer do anything. */
async function claimWorlds() {
  let shared = {};
  try {
    shared = JSON.parse(readFileSync(join(DATA, "community.json"), "utf8"));
  } catch {}
  const settled = [];
  for (const [local, s] of Object.entries(shared))
    if (s.id && s.ownerToken) await community(`/worlds/${s.id}/claim`, { method: "POST", body: { ownerToken: s.ownerToken } }).then(() => settled.push(local), (e) => [403, 409].includes(e.status) && settled.push(local));
  if (settled.length) await menu("community-claimed", { ids: settled });
}
const ACCOUNT_ACTIONS = {
  account: async () => (sessionToken() ? (await community("/account").catch((e) => (e.status === 401 ? {} : Promise.reject(e)))).account ?? null : null),
  "sign-up": async ({ email, password, username }) => signedInAs(await community("/accounts", { method: "POST", body: { email, password, username } })),
  "sign-in": async ({ email, password }) => signedInAs(await community("/sessions", { method: "POST", body: { email, password } })),
  "sign-out": async () => {
    await community("/sessions", { method: "DELETE" }).catch(() => {});
    keepSession(null);
    return null;
  },
  rename: async ({ username }) => (await community("/account", { method: "PATCH", body: { username } })).account,
  "delete-account": async ({ password }) => {
    await community("/account", { method: "DELETE", body: { password } });
    keepSession(null);
    return null;
  },
};
async function signedInAs({ token, account }) {
  keepSession(token);
  await claimWorlds().catch((e) => console.log(`Couldn't claim shared worlds: ${e.message}`));
  return account;
}

/** Publishes a world the launcher staged, as the signed-in account: a new community world, or the same one again. */
async function publishStaged(id, { details, sizes, community: before }) {
  const body = { ...details, files: sizes };
  const updated = before && (await community(`/worlds/${before}`, { method: "PUT", body }).catch((e) => ([404, 410].includes(e.status) ? null : Promise.reject(e))));
  const { id: world, uploads } = updated || (await community("/worlds", { method: "POST", body }));
  await menu("publish-upload", { id, uploads });
  const published = await community(`/worlds/${world}/done`, { method: "POST" });
  await menu("published", { id, world: published });
  return published;
}
/** The game's Share: the world staged itself, and the player confirms in a dialog no world can draw. Null once it's done or the player said no, or why it couldn't. */
async function publishWorld(id) {
  const stage = await menu("staged", { id });
  if (!stage) return "Share it again.";
  const account = await ACCOUNT_ACTIONS.account();
  if (!account) return "Sign in to Community in Settings, then share again.";
  const where = stage.details.visibility === "public" ? "Anyone can find it in Community." : "Anyone with the link can play it.";
  const { response } = await dialog.showMessageBox(win, { type: "question", buttons: ["Publish", "Cancel"], defaultId: 0, cancelId: 1, message: `Publish ${stage.details.title} as ${account.username}?`, detail: where });
  if (response !== 0) return null;
  await publishStaged(id, stage);
  return null;
}
/** Takes a world this app published out of Community, once the player confirms. */
async function unpublishWorld(id) {
  const shared = (await hostState())?.worlds.find((w) => w.id === id)?.shared?.id;
  if (!shared) return "That world isn't shared.";
  const { response } = await dialog.showMessageBox(win, { type: "warning", buttons: ["Remove", "Cancel"], defaultId: 1, cancelId: 1, message: "Remove this world from Community?", detail: "Its link stops working for everyone." });
  if (response !== 0) return null;
  // A world shared before accounts and not yet claimed is still taken down by the owner token the launcher keeps.
  const legacy = await community(`/worlds/${shared}`, { method: "DELETE" }).then(() => false, (e) => ([401, 403].includes(e.status) ? true : e.status === 410 ? false : Promise.reject(e)));
  await (legacy ? menu("unshare", { id }) : menu("published", { id }));
  return null;
}
/** Only the world this app is hosting and playing may ask to publish itself. */
const hostState = () => server && ask(`${server.base}/api/menu/state`, server.key).then((r) => r.json(), () => null);
async function hostingHere(event, id) {
  return event.sender === game?.view.webContents && (await hostState())?.running?.id === id;
}

/** Plays of Community worlds hosted here: focused time as a running total each minute, rechecking the hosted world since the in-game menu can switch it. */
let focusedMs = 0;
let focusedSince = null;
const focusedNow = () => focusedMs + (focusedSince === null ? 0 : Date.now() - focusedSince);
/** @type {{ local: string, id: string, to: { token: string, host: string }, from: number } | null} */ let playing = null;
async function beat() {
  const s = game && usage.sharing() ? await hostState() : null;
  const local = s?.running?.id ?? null;
  if (playing && playing.local !== local) await sendBeat(playing).then(() => (playing = null));
  if (playing) return sendBeat(playing);
  const world = local && s.worlds.find((w) => w.id === local);
  const id = world?.shared?.id ?? world?.from;
  const to = id && (await usage.install());
  if (!to) return;
  const token = to.host === COMMUNITY && sessionToken();
  const res = await fetch(`${to.host}/plays`, {
    method: "POST",
    headers: { authorization: `Bearer ${to.token}`, "content-type": "application/json", ...(token && { "x-session": token }) },
    body: JSON.stringify({ world: id }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  if (res?.ok) playing = { local, id: (await res.json()).play, to, from: focusedNow() };
}
const sendBeat = (p) =>
  fetch(`${p.to.host}/plays/${p.id}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${p.to.token}`, "content-type": "application/json" },
    body: JSON.stringify({ seconds: Math.round((focusedNow() - p.from) / 1000) }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
let beating = Promise.resolve();
const beatNow = () => (beating = beating.then(beat, beat));

/** Community from the launch screen, as the signed-in account. Ids are checked here, since they go into the API's paths. */
const worldId = (id) => {
  if (!/^[a-z0-9]{12}$/.test(String(id))) throw new Error("That world isn't in Community.");
  return String(id);
};
const commentId = (id) => {
  if (!/^[0-9]{1,18}$/.test(String(id))) throw new Error("That comment isn't there any more.");
  return String(id);
};
/** The local world a community world was published from, if it was from here. */
const publishedFrom = async (id) => (await startServer(), await hostState())?.worlds.find((w) => w.shared?.id === id)?.id;
const COMMUNITY_ACTIONS = {
  list: ({ after, mine, sort }) => (mine ? community("/account/worlds") : community(`/worlds?sort=${sort === "new" ? "new" : "top"}${after ? `&after=${worldId(after)}` : ""}`)),
  world: ({ id }) => community(`/worlds/${worldId(id)}`),
  forks: ({ id, after }) => community(`/worlds/${worldId(id)}/forks${after ? `?after=${worldId(after)}` : ""}`),
  vote: ({ id, up }) => community(`/worlds/${worldId(id)}/vote`, { method: "PUT", body: { up: up === true } }),
  report: ({ id }) => community(`/worlds/${worldId(id)}/report`, { method: "POST" }),
  comments: ({ id, after }) => community(`/worlds/${worldId(id)}/comments${after ? `?after=${commentId(after)}` : ""}`),
  comment: ({ id, body }) => community(`/worlds/${worldId(id)}/comments`, { method: "POST", body: { body: String(body ?? "") } }),
  "remove-comment": ({ id }) => community(`/comments/${commentId(id)}`, { method: "DELETE" }),
  "report-comment": ({ id }) => community(`/comments/${commentId(id)}/report`, { method: "POST" }),
  "take-down": async ({ id }) => {
    const local = await publishedFrom(worldId(id));
    await community(`/worlds/${id}`, { method: "DELETE" });
    if (local) await menu("published", { id: local });
    return {};
  },
  /** Play hosts the world, reusing the copy it made before; Fork makes a new copy in Worlds. The launch screen has asked about trust already. */
  get: async ({ id, host }) => {
    await startServer();
    const { world } = await menu("community-get", { id: worldId(id), trust: true, host: host === true });
    if (host === true) await hostGame(world);
    return { world };
  },
  /** This computer's worlds, to pick one to publish. */
  local: async () => (await startServer(), await hostState())?.worlds.map((w) => ({ id: w.id, name: w.name, shared: w.shared })) ?? [],
  publish: async ({ id, title, description, visibility }) => {
    await startServer();
    const stage = await menu("publish-stage", { id: String(id), title, description, visibility });
    return publishStaged(String(id), stage);
  },
};

/** Players in the world this app hosts, besides the host playing it here. */
async function guests() {
  const s = await hostState();
  if (!s?.running) return null;
  return { name: s.running.name, count: s.running.players.filter((p) => p.online && p.name !== state.name).length };
}

/** The worlds this app hosts, read from its data folder so they show without starting the server. */
function ownGames(live) {
  const dir = join(DATA, "worlds");
  const ids = existsSync(dir) ? readdirSync(dir) : [];
  return ids.flatMap((id) => {
    try {
      const { name } = JSON.parse(readFileSync(join(dir, id, "config.json"), "utf8"));
      const saved = [join(dir, id, "world.sqlite"), join(dir, id, "config.json")].find(existsSync);
      const cover = join(dir, id, "cover.jpg");
      return [{ name, at: statSync(saved).mtimeMs, live: live === id, url: `local:${id}`, cover: existsSync(cover) ? `sandbox://app/cover/${id}?v=${statSync(cover).mtimeMs}` : null }];
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

/** The start screen's worlds: this app's own, each other launcher's whose main menu was opened here, through its relay address when it shares, and the worlds joined; and the one last played. */
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
    if (m.s.running) mine.add(m.s.running.link.split("/#")[0]);
    for (const w of m.s.worlds) hosted.push({ name: w.name, at: w.played, live: m.s.running?.id === w.id, url: `${m.base}/menu#key=${m.key}&world=${w.id}` });
  }
  const copied = (await clipboard.readText()).trim().slice(0, 2000);
  return {
    hosted,
    joined: state.recents.filter((r) => !mine.has(r.url) && !(server && r.url === server.base)),
    copied,
    last: state.last ?? null,
  };
}

function leave() {
  clearTimeout(waiting);
  waiting = null;
  stopAgent();
  if (!game) return;
  void beatNow();
  win.contentView.removeChildView(game.view);
  // Closing as a browser tab would lets the page finish: the host's game sends its world's picture as it goes.
  game.view.webContents.close({ waitForBeforeUnload: true });
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

/** PATH as the player's own terminal has it, which an app opened from the dock doesn't get, plus where the makers' installers put their agents. */
async function terminalPath() {
  const env = await new Promise((resolve) => execFile(process.env.SHELL || "/bin/sh", ["-ilc", "env"], { encoding: "utf8", timeout: 5000 }, (_e, stdout) => resolve(stdout ?? "")));
  const path = env.split("\n").find((l) => l.startsWith("PATH="))?.slice(5) || process.env.PATH || "";
  return [join(homedir(), ".local", "bin"), ...path.split(delimiter)].join(delimiter);
}

/** Starts an agent beside the game, once the player says yes in a dialog no game can draw: it signs in through its own terminal, so the app never sees its login. True once it runs, false when the player said no, or why it can't start. */
async function buildWith(id, key) {
  const kind = AGENTS[id];
  if (!kind || !game) return false;
  if (agent) {
    agent.view.webContents.focus();
    return true;
  }
  const base = worldBase(new URL(game.view.webContents.getURL()));
  const res = await fetch(`${base}/api/join-code?base=${encodeURIComponent(base)}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!res?.ok) return res?.status === 403 ? "The host turned agents off for this world." : "The world didn't answer. Try again.";
  const { command, folder, prompt } = await res.json();
  const PATH = await terminalPath();
  const installed = PATH.split(delimiter).some((dir) => dir && existsSync(join(dir, kind.bin)));
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: [installed ? "Start" : "Install and start", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: `Build with ${kind.name}?`,
    detail: `${installed ? "" : `Sandbox installs ${kind.name} with ${kind.maker}'s installer first. `}Sandbox sets up ${folder} for ${game.name} and starts ${kind.name} there, beside the game. When it asks whether you trust that folder, say yes. It builds as you. Stop closes it.`,
  });
  if (response !== 0 || !game || agent) return false;
  const view = new WebContentsView({ webPreferences: { preload: join(__dirname, "agent-preload.cjs"), sandbox: true, contextIsolation: true } });
  view.setBackgroundColor("#0b0b0c");
  view.webContents.on("will-navigate", (event) => event.preventDefault());
  view.webContents.setWindowOpenHandler(({ url }) => {
    // A sign-in link the agent prints opens in the browser, where the player signs in with its maker.
    if (/^https:\/\//.test(url)) void desktop.openExternal(url);
    return { action: "deny" };
  });
  view.webContents.on("before-input-event", keys);
  const script = `${installed ? "" : `${kind.install} && `}${command} && cd ${folder} && exec ${kind.bin} "$SANDBOX_PROMPT"`;
  agent = {
    view,
    name: kind.name,
    pty: null,
    start(cols, rows) {
      const pty = (this.pty = require("node-pty").spawn("/bin/sh", ["-c", script], { name: "xterm-256color", cols, rows, cwd: homedir(), env: { ...process.env, PATH, TERM: "xterm-256color", SANDBOX_PROMPT: prompt } }));
      pty.onData((data) => view.webContents.send("agent-output", data));
      pty.onExit(() => {
        if (agent?.pty === pty && !view.webContents.isDestroyed()) view.webContents.send("agent-exit");
      });
    },
  };
  win.contentView.addChildView(view);
  layout();
  view.webContents.once("did-finish-load", () => view.webContents.focus());
  void view.webContents.loadURL("sandbox://app/agent.html");
  return true;
}

/** Stop ends the agent and everything it started: its terminal leads its own process group. */
function stopAgent() {
  if (!agent) return;
  const { view, pty } = agent;
  agent = null;
  if (pty) {
    try {
      process.kill(-pty.pid, "SIGHUP");
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-pty.pid, "SIGKILL");
      } catch {}
    }, 3000).unref();
  }
  win.contentView.removeChildView(view);
  view.webContents.close();
  layout();
  game?.view.webContents.focus();
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
    titleBarOverlay: mac ? undefined : { color: "#00000000", symbolColor: "#e9e4d8", height: BAR },
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
  win.on("focus", () => {
    focusedSince ??= Date.now();
    (game ? game.view : shell).webContents.focus();
  });
  win.on("blur", () => {
    focusedMs = focusedNow();
    focusedSince = null;
  });
  if (win.isFocused()) focusedSince = Date.now();
  setInterval(beatNow, 60000);
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
  // A world exported from the main menu: ask where it goes, starting in Downloads.
  session.defaultSession.on("will-download", (_event, item) => item.setSaveDialogOptions({ title: "Save world", defaultPath: join(app.getPath("downloads"), item.getFilename()) }));

  const fromShell = (event) => event.sender === shell.webContents;
  ipcMain.handle("state", (event) => (fromShell(event) ? games() : null));
  ipcMain.handle("open", (event, url) => {
    if (!fromShell(event)) return null;
    const own = String(url).match(/^local:(.+)$/)?.[1];
    // A server that didn't start gets a screen saying why, Retry, and its last words to copy; other failures are a line under the menu.
    return own ? hostGame(own).catch((e) => (e.log ? void shell.webContents.send("down", { url, name: null, why: "server", cause: e.cause, log: e.log }) : e.message)) : play(String(url));
  });
  ipcMain.handle("forget", async (event, url) => {
    if (!fromShell(event)) return null;
    const own = String(url).match(/^local:(.+)$/)?.[1];
    if (own) {
      const { base, key } = await startServer();
      const res = await fetch(`${base}/api/menu/delete`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ id: own }) });
      return res.ok ? null : (await res.json()).error;
    }
    state.recents = state.recents.filter((r) => r.url !== url);
    save();
    return null;
  });
  ipcMain.handle("name", (event) => (fromShell(event) ? { name: state.name ?? null, suggested: suggestedName() } : null));
  ipcMain.handle("community", async (event, action, body) => {
    if (!fromShell(event) || !Object.hasOwn(COMMUNITY_ACTIONS, action)) return { error: "Unknown action" };
    return COMMUNITY_ACTIONS[action](body ?? {}).then((result) => ({ result }), (e) => ({ error: e.message, status: e.status }));
  });
  ipcMain.handle("account", async (event, action, body) => {
    if (!fromShell(event) || !Object.hasOwn(ACCOUNT_ACTIONS, action)) return { error: "Unknown action" };
    return ACCOUNT_ACTIONS[action](body ?? {}).then((account) => ({ account }), (e) => ({ error: e.message }));
  });
  ipcMain.handle("set-name", (event, raw) => {
    if (!fromShell(event)) return null;
    const name = String(raw).trim().toLowerCase();
    if (!NAME.test(name)) return "Names are 2–16 letters, digits, - or _.";
    state.name = name;
    save();
    return null;
  });
  // The game joins every world as this name, without asking again.
  ipcMain.on("player-name", (event) => (event.returnValue = event.sender === game?.view.webContents ? (state.name ?? null) : null));
  ipcMain.on("leave", (event) => (fromShell(event) || event.sender === game?.view.webContents) && leave());
  ipcMain.handle("version", () => app.getVersion());
  ipcMain.handle("update", (event) => (fromShell(event) || event.sender === game?.view.webContents) && install());
  ipcMain.on("quit", (event) => fromShell(event) && app.quit());
  ipcMain.handle("ready", (event) => fromShell(event) && ready);
  ipcMain.on("events", (event, events) => fromShell(event) && usage.add(events));
  ipcMain.handle("share-usage", (event, on) => {
    if (!fromShell(event)) return null;
    if (typeof on === "boolean") usage.share(on);
    return usage.sharing();
  });
  const fromGame = (event) => event.sender === game?.view.webContents;
  const fromAgent = (event) => event.sender === agent?.view.webContents;
  ipcMain.on("agents", (event) => (event.returnValue = fromGame(event) ? Object.entries(AGENTS).map(([id, a]) => ({ id, name: a.name })) : []));
  ipcMain.handle("build", async (event, id, key) => {
    if (!fromGame(event)) return false;
    const started = await buildWith(String(id), key);
    usage.step("agent", "build-with", { agent: Object.hasOwn(AGENTS, id) ? id : null, outcome: started === true ? "started" : started === false ? "declined" : "failed" });
    return started;
  });
  for (const [channel, fn] of [["publish", publishWorld], ["unpublish", unpublishWorld]])
    ipcMain.handle(channel, async (event, id) => ((await hostingHere(event, String(id))) ? fn(String(id)).catch((e) => e.message) : "Publish from the Sandbox app."));
  ipcMain.on("agent-name", (event) => (event.returnValue = fromAgent(event) ? agent.name : ""));
  ipcMain.on("agent-input", (event, data) => fromAgent(event) && agent.pty?.write(String(data)));
  ipcMain.on("agent-resize", (event, cols, rows) => {
    if (!fromAgent(event) || !(cols > 0 && rows > 0)) return;
    if (agent.pty) agent.pty.resize(cols, rows);
    else agent.start(cols, rows);
  });
  ipcMain.on("agent-close", (event) => fromAgent(event) && stopAgent());

  protocol.handle("sandbox", (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path === "/shell.html" || path === "/agent.html") return net.fetch(pathToFileURL(join(__dirname, path)).href);
    const xterm = { "/xterm/xterm.js": "@xterm/xterm/lib/xterm.js", "/xterm/xterm.css": "@xterm/xterm/css/xterm.css", "/xterm/addon-fit.js": "@xterm/addon-fit/lib/addon-fit.js" }[path];
    if (xterm) return net.fetch(pathToFileURL(require.resolve(xterm)).href);
    if (/^\/cover\/[a-z0-9-]+$/.test(path)) return net.fetch(pathToFileURL(join(DATA, "worlds", path.slice(7), "cover.jpg")).href);
    const file = normalize(join(FRONT, path));
    return file.startsWith(FRONT) ? net.fetch(pathToFileURL(file).href) : new Response("not found", { status: 404 });
  });
  createWindow();
  const { reopen } = state;
  if (reopen) {
    delete state.reopen;
    save();
    shell.webContents.once("did-finish-load", async () => {
      if (reopen.hosting) await resumeHosting().catch((e) => console.log(e.message));
      if (reopen.url) play(reopen.url);
    });
  }
  if (UPDATES && reopen) void checkUpdate().then(pollUpdates);
  else if (UPDATES) ready = updateFirst().then(pollUpdates);
});

const UPDATES = app.isPackaged || !!process.env.SANDBOX_UPDATES;
/** The start screen shows its menu once this settles. */
let ready = Promise.resolve();
const startScreen = (text) => shell.webContents.send("starting", text);

/** Before the menu shows, installs a newer release and opens again; offline, failing, or when the last install didn't bring it, the app opens as it is and offers Update. */
async function updateFirst() {
  const slow = setTimeout(() => startScreen("Checking for updates…"), 400);
  await Promise.race([checkUpdate(), new Promise((r) => setTimeout(r, 3000))]);
  clearTimeout(slow);
  if (update && state.updatedTo !== update) {
    startScreen(`Updating to ${update}…`);
    if (!(await install())) return new Promise(() => {});
    console.log("Opening without the update");
  }
  startScreen(null);
}

/** The newest release when it is newer than this app, polled like PR Cockpit: every 5 minutes, backing off while GitHub rate-limits. */
let update = null;
const EVERY = Number(process.env.SANDBOX_UPDATE_EVERY ?? 5 * 60 * 1000);
let checkEvery = EVERY;
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
async function checkUpdate() {
  const res = await net.fetch(RELEASES, { headers: { accept: "application/vnd.github+json" } }).catch(() => null);
  checkEvery = res?.status === 403 || res?.status === 429 ? Math.min(checkEvery * 2, 6 * 60 * 60 * 1000) : EVERY;
  const release = res?.ok ? await res.json().catch(() => null) : null;
  if (release?.tag_name) {
    const version = release.tag_name.replace(/^v/, "");
    const next = /^\d+\.\d+\.\d+$/.test(version) && newer(version, app.getVersion()) ? version : null;
    if (next !== update) {
      update = next;
      shell?.webContents.send("update", update);
      game?.view.webContents.send("update", update);
    }
  }
}
function pollUpdates() {
  setTimeout(() => checkUpdate().then(pollUpdates), checkEvery);
}

/** Updates the way the installer does, since Squirrel won't update an unsigned Mac app: the installer downloads the release, this app quits, and the installer swaps it in and opens it again. Says why when the download fails, and stays open. */
let installing = false;
async function install() {
  if (!update || installing) return null;
  const hosting = await guests();
  if (game || hosting?.count) {
    const detail = hosting?.count ? `${hosting.count === 1 ? "1 player is" : `${hosting.count} players are`} in ${hosting.name}. Updating ends the world for them.` : `You're in ${game.name}. Sandbox restarts to update, then takes you back in.`;
    const { response } = await dialog.showMessageBox(win, { type: "question", buttons: ["Update", "Not now"], defaultId: 0, cancelId: 1, message: `Update to Sandbox ${update}?`, detail });
    if (response !== 0) return null;
  }
  installing = true;
  const path = join(app.getPath("userData"), "update.log");
  const log = openSync(path, "a");
  const from = statSync(path).size;
  const [shell, args] = windows ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm '${INSTALLER(update)}' | iex`]] : ["bash", ["-c", `curl -fsSL '${INSTALLER(update)}' | bash`]];
  const child = spawn(shell, args, { detached: true, windowsHide: true, stdio: ["ignore", log, log], env: { ...process.env, SANDBOX_APP_PID: String(process.pid), SANDBOX_RELEASE: DOWNLOADS(update) } });
  child.unref();
  closeSync(log);
  const exited = new Promise((resolve) => child.once("exit", () => resolve(false)));
  const said = () => {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(statSync(path).size - from);
    readSync(fd, buf, 0, buf.length, from);
    closeSync(fd);
    return buf.toString();
  };
  let ready = false;
  while (!ready && (await Promise.race([exited, new Promise((r) => setTimeout(() => r(true), 250))]))) ready = said().includes("Quit Sandbox to continue.");
  if (!ready) {
    installing = false;
    console.log(`The update failed: ${said().trim().split("\n").at(-1) ?? ""}`);
    return "The update didn't download. Check your connection.";
  }
  state.reopen = { hosting: !!hosting, url: game?.view.webContents.getURL() || null };
  state.updatedTo = update;
  quitting = true;
  stopAgent();
  await Promise.all([beatNow(), usage.drain()]);
  await stopServer();
  save();
  app.quit();
  return null;
}

/** Asks first when that leaves a game: the host's own, or friends still in the world this app hosts. Then stops the server. */
let confirming = null;
function quit() {
  confirming ??= (async () => {
    const hosting = await guests();
    if (game || hosting?.count) {
      const detail = hosting?.count ? `${hosting.count === 1 ? "1 player is" : `${hosting.count} players are`} in ${hosting.name}. Quitting ends the world for them.` : `You're in ${game.name}.`;
      const { response } = await dialog.showMessageBox(win, { type: "question", buttons: ["Quit", hosting?.count ? "Keep hosting" : "Keep playing"], defaultId: 1, cancelId: 1, message: "Quit Sandbox?", detail });
      if (response !== 0) return;
    }
    quitting = true;
    stopAgent();
    await Promise.all([beatNow(), usage.drain()]);
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
