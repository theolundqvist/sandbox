// The real Electron app on a throwaway relay and launcher and a stand-in GitHub; run with `xvfb-run -a node --test desktop/app.test.mjs`.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { _electron, chromium } from "playwright-core";

const DESKTOP = import.meta.dirname;
const ROOT = join(DESKTOP, "..");
const ELECTRON = createRequire(import.meta.url)("electron");
const VERSION = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8")).version;
const dir = mkdtempSync(join(tmpdir(), "sandbox-app-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = () => 20000 + Math.floor(Math.random() * 20000);
const children = [];

async function until(what, check, ms = 20000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
    const got = await check().catch(() => null);
    if (got) return got;
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function bun(script, env) {
  const proc = spawn("bun", [join(ROOT, script)], { env: { ...ownEnv, ...env }, stdio: "ignore" });
  children.push(proc);
  return proc;
}

/** This machine's own service keys never reach the app under test. */
const ownEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.endsWith("_API_KEY")));
const VOICE_KEY = "sk_test_voice_key";

/** GitHub as the app sees it: the latest release, and the installer script the app runs to update; and ElevenLabs, which knows one key. */
const releases = { latest: VERSION, installer: null };
const RELEASES = port();
const github = createServer((req, res) => {
  if (req.url === "/latest") return res.end(JSON.stringify({ tag_name: `v${releases.latest}` }));
  if (req.url === "/hang") return;
  if (req.url === "/install" && releases.installer) return res.end(releases.installer);
  if (req.url === "/v1/speech-to-text") {
    res.statusCode = req.headers["xi-api-key"] === VOICE_KEY ? 400 : 401;
    return res.end("{}");
  }
  res.statusCode = 404;
  res.end("Not Found");
}).listen(RELEASES);

const RELAY = port();
const relayUrl = `http://127.0.0.1:${RELAY}`;
/** Another player's computer, hosting a world through the same relay. */
const OTHER = port();
let other;
let otherLauncher;
const startOther = () => bun("engine/launcher.ts", { PORT: String(OTHER), SANDBOX_DATA: join(dir, "other"), SANDBOX_RELAY: relayUrl, SANDBOX_NO_OPEN: "1" });

async function menu(base, key, action, body) {
  const res = await fetch(`${base}/api/menu/${action}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${key}` }, body: body && JSON.stringify(body) });
  return res.json();
}

before(async () => {
  bun("relay/relay.ts", { PORT: String(RELAY), RELAY_CLAIMS: join(dir, "claims.json") });
  otherLauncher = startOther();
  const base = `http://127.0.0.1:${OTHER}`;
  const { key } = await until("the other launcher", async () => (await fetch(`${base}/api/local-key`)).json());
  await menu(base, key, "share", { on: true });
  const s = await until("the other world's code", async () => {
    const s = await menu(base, key, "create", { name: "Snow Race" });
    return s.tunnel?.code && s;
  });
  other = { base, key, code: s.tunnel.code, url: s.tunnel.url, invite: s.running.invite };
});

after(() => {
  for (const c of children) c.kill();
  github.closeAllConnections();
  github.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Opens the app with its own settings folder; the same name reopens the same install. */
async function launch(name, env = {}) {
  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: [DESKTOP, "--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
    env: { ...ownEnv, SANDBOX_ELEVENLABS: `http://127.0.0.1:${RELEASES}`, XDG_CONFIG_HOME: join(dir, name), SANDBOX_RELAY: relayUrl, SANDBOX_UPDATES: `http://127.0.0.1:${RELEASES}/latest`, SANDBOX_INSTALLER: `http://127.0.0.1:${RELEASES}/install`, SANDBOX_UPDATE_EVERY: "500", ...env },
  });
  const shell = await until("the start screen", async () => app.windows().find((w) => w.url().startsWith("sandbox://app/shell.html")));
  await shell.locator("#title").waitFor();
  const saved = join(dir, name, "Sandbox", "state.json");
  return { app, shell, state: () => (existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) : {}) };
}

const gamePage = (app) => until("the game view", async () => app.windows().find((w) => /^https?:/.test(w.url())));
const menuShown = (shell) => shell.locator("#title .items").isVisible();
const shown = (page, sel) => page.locator(sel).isVisible();
const rows = (shell) => shell.locator("#games .item").evaluateAll((items) => items.map((b) => [...b.childNodes].map((n) => n.textContent).join(" | ")));
/** Answers the app's next question dialogs with this button, and keeps what they asked. */
const answer = (app, response) =>
  app.evaluate(({ dialog }, response) => {
    globalThis.asked = [];
    dialog.showMessageBox = async (_win, options) => (globalThis.asked.push(options), { response });
  }, response);
const asked = (app) => app.evaluate(() => globalThis.asked);

async function joinAs(page, name) {
  await page.locator("#join-name").waitFor();
  await page.fill("#join-name", name);
  await page.click("#join-go");
  await until("the game", () => page.evaluate(() => document.getElementById("join").hidden));
}

/** A friend in the world, over a socket like the game's. */
async function guest(base, invite, name) {
  const { key } = await (await fetch(`${base}/api/join`, { method: "POST", body: JSON.stringify({ invite, name }) })).json();
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws?key=${key}`);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  return ws;
}

/** Closes the app, saying yes to its Quit Sandbox? question. */
const close = (app) => app && answer(app, 0).then(() => app.close(), () => {});

const portAnswers = (p) => fetch(`http://127.0.0.1:${p}/api/local-key`).then(() => true, () => false);

describe("hosting and joining", () => {
  let app, shell, state;
  before(async () => ({ app, shell, state } = await launch("host")));
  after(() => close(app));

  test("first launch: the title menu, no update, and no worlds yet", async () => {
    await until("the menu", () => menuShown(shell));
    assert.deepEqual(await shell.locator("#title .item:visible").allTextContents(), ["Worlds", "Join game", "Host game", "Quit"]);
    await shell.click("text=Worlds");
    assert.equal(await shown(shell, "#no-games"), true);
  });

  test("every screen goes back with Esc and with Back", async () => {
    await shell.keyboard.press("Escape");
    assert.equal(await shown(shell, "#title"), true);
    await shell.click("text=Join game");
    await shell.click("#back");
    assert.equal(await shown(shell, "#title"), true);
  });

  test("Join game fills in a copied invite link or code, and nothing else", async () => {
    const cases = {
      [`${other.url}/#invite=${other.invite}`]: `${other.url}/#invite=${other.invite}`,
      "http://192.168.1.20:7777/#key=0123456789abcdef": "http://192.168.1.20:7777/#key=0123456789abcdef",
      "k7f-m2q": "K7F-M2Q",
      "https://www.reddit.com/r/gaming/comments/abc/": "",
      [`${other.url}/`]: "",
      "https://example.com/page": "",
      BANANA: "",
      PLANET: "",
      K7FM2Q: "",
      "meet at 5": "",
    };
    for (const [copied, filled] of Object.entries(cases)) {
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), copied);
      await shell.evaluate(() => {
        document.getElementById("join-link").set("");
        dispatchEvent(new Event("focus"));
      });
      if (filled) await until(`${copied} filled in`, async () => (await shell.inputValue("#join-link")) === filled, 5000).catch(() => {});
      else await sleep(1000);
      assert.equal(await shell.inputValue("#join-link"), filled, `copied ${JSON.stringify(copied)}`);
    }
    // A link is shown at text size, a code as a code.
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), `${other.url}/#invite=${other.invite}`);
    await shell.evaluate(() => dispatchEvent(new Event("focus")));
    await until("the link filled in", async () => (await shell.inputValue("#join-link")) !== "");
    assert.equal(await shell.locator("#join-link").evaluate((i) => i.classList.contains("code")), false);
    await app.evaluate(({ clipboard }) => clipboard.writeText(""));
    await shell.evaluate(() => document.getElementById("join-link").set(""));
  });

  test("a wrong code says so", async () => {
    await shell.click("text=Join game");
    await shell.fill("#join-link", "AAAAAA");
    await shell.press("#join-link", "Enter");
    await until("the error", async () => (await shell.textContent("#error")) === "No game with that code");
    await shell.keyboard.press("Escape");
  });

  test("Host game opens this computer's main menu through the relay, never Waiting for the host", async () => {
    await shell.click("text=Host game");
    const game = await gamePage(app);
    await game.locator("#create").waitFor();
    assert.equal(await shown(game, "#waiting"), false);
    assert.match(game.url(), new RegExp(`^${relayUrl}/r/[a-z0-9-]+/menu`));
  });

  test("an unnamed world gets a name of its own, and the host plays it", async () => {
    const game = await gamePage(app);
    await game.click("#create-go");
    await game.waitForURL(/\/r\/[a-z0-9-]+\/(#.*)?$/);
    await game.locator("#join-world").waitFor();
    assert.notEqual(await game.textContent("#join-world"), "Sandbox");
    await joinAs(game, "host");
  });

  test("a friend online: quitting asks first, and Keep hosting keeps the game", async () => {
    const own = state().port;
    const s = await menu(`http://127.0.0.1:${own}`, JSON.parse(readFileSync(join(dir, "host", "Sandbox", "data", "launcher.json"), "utf8")).hostKey, "state");
    const friend = await guest(`http://127.0.0.1:${own}`, s.running.invite, "friend");
    await answer(app, 1);
    await app.evaluate(({ app }) => app.quit());
    await until("the question", async () => (await asked(app))?.length);
    const [q] = await asked(app);
    assert.equal(q.message, "Quit Sandbox?");
    assert.match(q.detail, /^1 player is in /);
    await sleep(500);
    assert.equal(await portAnswers(own), true);
    friend.close();
  });

  test("the host turns voice on from the mic, with a key checked and then shown masked", async () => {
    const game = await gamePage(app);
    assert.equal(await game.textContent("#mic"), "Turn on voice");
    await game.locator("#mic").dispatchEvent("click");
    await game.locator("#voice-key").waitFor();
    assert.equal(await game.evaluate(() => document.activeElement.id), "voice-key");
    assert.equal(await shown(game, "#howto"), false);
    await game.fill("#voice-key", "sk_wrong");
    await game.press("#voice-key", "Enter");
    await until("the refusal", async () => (await game.textContent("#toasts")).includes("That key didn't work. Copy it again from elevenlabs.io."));
    await game.fill("#voice-key", VOICE_KEY);
    await game.press("#voice-key", "Enter");
    await until("voice on", async () => (await game.textContent("#mic")) === "Hold T to talk");
    assert.equal(await game.getAttribute("#voice-key", "placeholder"), "••••_key");
    assert.equal(await game.inputValue("#voice-key"), "");
    assert.equal(readFileSync(join(dir, "host", "Sandbox", "data", "secrets.json"), "utf8").includes(VOICE_KEY), true);
    await game.keyboard.press("Escape");
    await game.keyboard.press("Escape");
  });

  test("connecting an agent: the pick is remembered, and Copy copies each step in place", async () => {
    const game = await gamePage(app);
    await game.locator("#menu-button").dispatchEvent("click");
    await game.click("#rail [data-tab=claude]");
    await game.click("[data-harness=codex]");
    const install = game.locator("[data-copy=claude-install]");
    const box = await install.boundingBox();
    await install.click();
    await until("Copied", async () => (await install.textContent()) === "Copied");
    assert.deepEqual(await install.boundingBox(), box);
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), await game.textContent("#claude-install"));
    await game.locator("[data-copy=claude-command]").click();
    await until("the command copied", async () => /codex --/.test(await app.evaluate(({ clipboard }) => clipboard.readText())));
    await game.reload();
    await game.locator("#join").waitFor({ state: "hidden" });
    await game.locator("#menu-button").dispatchEvent("click");
    await game.click("#rail [data-tab=claude]");
    assert.equal(await game.getAttribute("[data-harness=codex]", "class"), "active");
    await game.keyboard.press("Escape");
    await game.keyboard.press("Escape");
  });

  test("leaving shows the hosted world, live, marked Hosted", async () => {
    await shell.click("#leave");
    await shell.click("text=Worlds");
    const [row] = await until("the hosted world", async () => (await rows(shell)).length && rows(shell));
    assert.match(row, /^.+ \| Live \| Hosted$/);
    assert.equal((await rows(shell)).length, 1);
    await shell.keyboard.press("Escape");
  });

  test("a code joins through the relay; reload stays in the room; the world is saved under its relay address", async () => {
    await shell.click("text=Join game");
    await shell.fill("#join-link", `${other.code.slice(0, 3)}-${other.code.slice(3)}`);
    await shell.press("#join-link", "Enter");
    const game = await gamePage(app);
    const clips = [];
    game.on("request", (r) => r.url().includes("/clips/") && clips.push(r.url()));
    assert.equal(game.url(), `${other.url}/#invite=${other.invite}`);
    await joinAs(game, "visitor");
    assert.equal(await game.textContent("#mic"), "Voice off");
    await game.reload();
    await game.locator("#join").waitFor({ state: "hidden" });
    assert.equal(await game.evaluate(() => document.getElementById("join").hidden), true);
    assert.match(game.url(), new RegExp(`^${other.url}/`));
    assert.deepEqual(clips, []);
    await until("the saved world", async () => state().recents.find((r) => r.url === other.url && r.name === "Snow Race"));
    await shell.click("#leave");
  });

  test("the joined world is listed as Joined, and Forget removes it", async () => {
    await shell.click("text=Worlds");
    await until("both worlds", async () => (await rows(shell)).length === 2);
    assert.ok((await rows(shell)).some((r) => /^Snow Race \| .+ \| Joined$/.test(r)));
    await shell.click("text=Snow Race");
    await shell.click("#game-forget");
    await until("one world", async () => (await rows(shell)).length === 1);
    assert.equal(state().recents.some((r) => r.url === other.url), false);
    await shell.keyboard.press("Escape");
  });

  test("an invite link opens the game; a /r/ link without its scheme becomes https", async () => {
    await shell.click("text=Join game");
    await shell.fill("#join-link", `${other.base}/#invite=${other.invite}`);
    await shell.press("#join-link", "Enter");
    const game = await gamePage(app);
    await game.locator("#join-name").waitFor();
    await shell.click("#leave");
    const bare = await shell.evaluate(async () => (await import("/front.js")).joinLink("sandbox-relay.example.com/r/ab12cd/", "/relay"));
    assert.equal(bare, "https://sandbox-relay.example.com/r/ab12cd/");
  });

  test("too many wrong codes are refused for a minute", async () => {
    await shell.click("text=Join game");
    let error = "";
    for (let i = 0; i < 12 && error !== "Too many tries. Wait a minute."; i++) {
      await shell.fill("#join-link", "BBBBBB");
      await shell.press("#join-link", "Enter");
      await sleep(200);
      error = await shell.textContent("#error");
    }
    assert.equal(error, "Too many tries. Wait a minute.");
    await shell.keyboard.press("Escape");
  });

  test("quitting stops the game server", async () => {
    const own = state().port;
    await answer(app, 0);
    await shell.click("#quit");
    await until("the server to stop", async () => !(await portAnswers(own)));
  });
});

describe("the relay down", () => {
  let app, shell;
  before(async () => ({ app, shell } = await launch("offline", { SANDBOX_RELAY: `http://127.0.0.1:${port()}` })));
  after(() => close(app));

  test("a code can't be looked up", async () => {
    await shell.click("text=Join game");
    await shell.fill("#join-link", "K7F-M2Q");
    await shell.press("#join-link", "Enter");
    await until("the error", async () => (await shell.textContent("#error")) === "Can't look up codes right now. Check your connection, or ask for the invite link.");
    await shell.keyboard.press("Escape");
  });

  test("Host game still opens the main menu, on this computer", async () => {
    await shell.click("text=Host game");
    const game = await gamePage(app);
    await game.locator("#create").waitFor();
    assert.match(game.url(), /^http:\/\/localhost:\d+\/menu/);
  });

  test("the host's invite is a Wi-Fi link, and the main menu says why", async () => {
    const game = await gamePage(app);
    await game.fill("#create-name", "Home World");
    await game.click("#create-go");
    await joinAs(game, "host");
    await game.locator("#menu-button").dispatchEvent("click");
    await game.click("#rail [data-tab=invite]");
    assert.equal(await game.textContent("#invite-label"), "Wi-Fi link");
    assert.match(await game.textContent("#invite-link"), /^http:\/\/(\d+\.){3}\d+:\d+\/#invite=[0-9a-f]+$/);
    await game.goto(new URL("/menu", game.url()).href);
    await until("the relay error", async () => (await game.textContent("#error")) === "Can't reach the Sandbox relay, so only people on your Wi-Fi can join. Trying again…");
  });

  test("a crashed app leaves no game server behind", async () => {
    const own = JSON.parse(readFileSync(join(dir, "offline", "Sandbox", "state.json"), "utf8")).port;
    assert.equal(await portAnswers(own), true);
    app.process().kill("SIGKILL");
    await until("the server to stop", async () => !(await portAnswers(own)), 10000);
  });

  test("reopened after the crash, the world is there and opens again", async () => {
    ({ app, shell } = await launch("offline", { SANDBOX_RELAY: `http://127.0.0.1:${port()}` }));
    await shell.click("text=Worlds");
    const [row] = await until("the world", async () => (await rows(shell)).length && rows(shell));
    assert.match(row, /^Home World \| .+ \| Hosted$/);
    await shell.click("#games .item");
    const game = await gamePage(app);
    await game.locator("#world-name").waitFor();
    assert.equal(await game.textContent("#world-name"), "Home World");
  });
});

/** The real installer's handshake: download, say so, wait for the app to quit, then install; this one writes down the app it waited for. */
const installer = (marker) => `echo "Downloading Sandbox"; sleep 1; echo "Quit Sandbox to continue."; while kill -0 "$SANDBOX_APP_PID" 2>/dev/null; do sleep 0.2; done; echo "$SANDBOX_APP_PID" > '${marker}'`;

describe("starting up", () => {
  after(() => {
    releases.latest = VERSION;
    releases.installer = null;
  });

  test("offline, the menu shows and offers no update", async () => {
    const { app, shell } = await launch("start-offline", { SANDBOX_UPDATES: "http://127.0.0.1:1/latest" });
    await until("the menu", () => menuShown(shell));
    assert.equal(await shown(shell, "#go-update"), false);
    await close(app);
  });

  test("a release server that never answers holds the menu back 3 seconds at most", async () => {
    const started = Date.now();
    const { app, shell } = await launch("hang", { SANDBOX_UPDATES: `http://127.0.0.1:${RELEASES}/hang` });
    assert.equal(await menuShown(shell), false);
    await until("the menu", () => menuShown(shell));
    assert.ok(Date.now() - started < 6000);
    await close(app);
  });

  test("a download that fails at start opens the menu, offering Update", async () => {
    releases.latest = "9.9.9";
    const { app, shell, state } = await launch("start-fails");
    await until("the menu", () => menuShown(shell));
    assert.equal(await shown(shell, "#go-update"), true);
    assert.equal(await shown(shell, "#busy"), false);
    assert.equal(state().updatedTo, undefined);
    await close(app);
  });

  test("a newer release installs before the menu shows, then the installer opens the new version", async () => {
    const marker = join(dir, "installed-at-start");
    releases.installer = installer(marker);
    const { app, shell, state } = await launch("start-updates");
    const pid = app.process().pid;
    const closed = new Promise((r) => app.once("close", r));
    await until("the progress", async () => (await shell.textContent("#busy")) === "Updating to 9.9.9…");
    assert.equal(await menuShown(shell), false);
    await closed;
    await until("the installer", async () => existsSync(marker) && readFileSync(marker, "utf8").trim() === String(pid));
    assert.equal(state().updatedTo, "9.9.9");
  });

  test("when that install didn't bring the new version, the app opens as it is and offers Update", async () => {
    const ran = join(dir, "installed-again");
    releases.installer = `touch '${ran}'`;
    for (const _ of [1, 2]) {
      const { app, shell } = await launch("start-updates");
      await until("the menu", () => menuShown(shell));
      assert.equal(await shown(shell, "#go-update"), true);
      await close(app);
    }
    assert.equal(existsSync(ran), false);
  });
});

describe("updates", () => {
  let app, shell, state, game, code;
  before(async () => {
    releases.latest = VERSION;
    ({ app, shell, state } = await launch("update"));
  });
  after(() => close(app));

  test("a release that comes out while hosting with friends shows Update on the title and in the game, and restarts nothing", async () => {
    await shell.click("text=Host game");
    game = await gamePage(app);
    await game.fill("#create-name", "Update Test");
    await game.click("#create-go");
    await joinAs(game, "host");
    const own = state().port;
    const key = JSON.parse(readFileSync(join(dir, "update", "Sandbox", "data", "launcher.json"), "utf8")).hostKey;
    const s = await menu(`http://127.0.0.1:${own}`, key, "state");
    code = s.tunnel.code;
    await guest(`http://127.0.0.1:${own}`, s.running.invite, "friend");
    const pid = app.process().pid;
    await answer(app, 0);
    releases.latest = "9.9.9";
    await until("Update in the game", () => game.evaluate(() => !document.getElementById("menu-update").hidden));
    assert.equal(await shell.textContent("#go-update"), "Update9.9.9");
    await sleep(1500);
    assert.deepEqual(await asked(app), []);
    assert.equal(app.process().pid, pid);
    assert.equal(await portAnswers(own), true);
    assert.match(game.url(), new RegExp(`^${relayUrl}/r/`));
  });

  test("a failed download says so and keeps the app and the game open", async () => {
    const own = state().port;
    releases.installer = null;
    await answer(app, 0);
    await game.evaluate(() => document.getElementById("menu-update").click());
    await until("the error", async () => game.evaluate(() => document.body.innerText.includes("The update didn't download. Check your connection.")));
    const [q] = await asked(app);
    assert.equal(q.message, "Update to Sandbox 9.9.9?");
    assert.match(q.detail, /^1 player is in Update Test\. Updating ends the game for them\.$/);
    assert.equal(await portAnswers(own), true);
  });

  test("an update downloads before the app quits, then the installer takes over", async () => {
    const marker = join(dir, "installed");
    releases.installer = installer(marker);
    const own = state().port;
    const pid = app.process().pid;
    await answer(app, 0);
    const closed = new Promise((r) => app.once("close", r));
    await game.evaluate(() => document.getElementById("menu-update").click());
    await closed;
    await until("the installer", async () => existsSync(marker) && readFileSync(marker, "utf8").trim() === String(pid));
    assert.equal(await portAnswers(own), false);
    assert.equal(state().reopen.hosting, true);
    assert.match(state().reopen.url, new RegExp(`^${relayUrl}/r/`));
    app = null;
  });

  test("after the update the world is back up under the same code, and the host is back in it", async () => {
    releases.latest = VERSION;
    ({ app, shell, state } = await launch("update"));
    game = await gamePage(app);
    assert.match(game.url(), new RegExp(`^${relayUrl}/r/`));
    const res = await fetch(`${relayUrl}/join/${code}`, { headers: { "x-real-ip": "198.51.100.7" } });
    assert.equal(res.status, 200);
    await game.locator("#join").waitFor({ state: "hidden" });
    assert.equal(state().reopen, undefined);
    assert.equal(await shown(shell, "#go-update"), false);
  });
});

describe("in a browser", () => {
  let browser, page;
  before(async () => {
    browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
    page = await browser.newPage();
  });
  after(() => browser?.close());

  test("/menu through the relay, without the host's key, tells people it is the host's", async () => {
    await page.goto(`${other.url}/menu`);
    await until("the message", async () => (await page.textContent("#waiting")) === "Only the host can open this menu, on their own computer.");
    assert.equal(await page.locator("#title .item:visible").count(), 0);
  });

  test("/menu on the host's own computer needs no key, and offers the desktop app", async () => {
    await page.goto(`${other.base}/menu`);
    await page.click("#go-app");
    assert.match(await page.textContent("#app-install"), /desktop\/install \| bash -s -- '.+#key=/);
  });

  test("an invite link joins through the relay, and offers the app with the same link", async () => {
    const link = `${other.url}/#invite=${other.invite}`;
    await page.goto(link);
    await until("the join screen", async () => (await page.textContent("#join-world")) === "Snow Race");
    await page.click("#join-app-go");
    assert.ok((await page.textContent("#app-install")).endsWith(`bash -s -- '${link}'`));
    await page.keyboard.press("Escape");
    await page.fill("#join-name", "Browser");
    await page.click("#join-go");
    await until("the game", () => page.evaluate(() => document.getElementById("join").hidden));
    assert.ok(page.url().startsWith(other.url));
  });
});

describe("the host closes the game", () => {
  let app, shell, game;
  before(async () => ({ app, shell } = await launch("closing")));
  after(() => close(app));

  test("players in it are told, not left reconnecting", async () => {
    await shell.click("text=Join game");
    await shell.fill("#join-link", `${other.url}/#invite=${other.invite}`);
    await shell.press("#join-link", "Enter");
    game = await gamePage(app);
    await joinAs(game, "stayer");
    assert.match(await game.evaluate(() => getComputedStyle(document.querySelector("#howto h1")).fontFamily), /^"Archivo Expanded"/);
    const peek = await guest(other.url, other.invite, "peek");
    peek.close();
    await game.reload();
    await game.locator("#join").waitFor({ state: "hidden" });
    await sleep(3500);
    assert.doesNotMatch(await game.textContent("#feed"), /peek|stayer left/);
    otherLauncher.kill();
    await until("the message", async () => (await game.textContent("#status")) === "The host closed the game. You're back in when they open it.");
    const status = await game.locator("#status").boundingBox();
    for (const button of await game.locator("#top button:visible").all()) {
      const b = await button.boundingBox();
      assert.ok(status.y >= b.y + b.height || status.x >= b.x + b.width || b.x >= status.x + status.width, `the message covers ${await button.textContent()}`);
    }
    assert.equal(await game.isDisabled("#howto-play"), true);
    assert.equal(await shown(game, "#rules"), false);
  });

  test("opening it again from Worlds says it is closed, and Retry opens it once the host is back", async () => {
    await shell.click("#leave");
    await shell.click("text=Worlds");
    await until("the world", async () => (await rows(shell)).some((r) => r.startsWith("Snow Race")));
    await shell.click("#games .item >> text=Snow Race");
    await shell.click("#game-continue");
    await until("the message", async () => (await shell.textContent("#down-text")) === "Snow Race is closed. Ask the host to open it, then retry.");
    otherLauncher = startOther();
    await until("the world back", async () => (await fetch(`${other.url}/api/info`)).ok, 20000);
    await shell.click("#retry");
    game = await gamePage(app);
    await until("Snow Race", async () => (await game.textContent("#world-name")) === "Snow Race");
    assert.equal(game.url().startsWith(other.url), true);
  });
});

describe("the installer", () => {
  test("a failed download opens the installed app again, since an old app quit before it finished", async () => {
    const home = join(dir, "installer-home");
    const app = join(home, ".local/share/sandbox");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "sandbox"), `#!/bin/sh\ntouch '${join(home, "opened")}'\n`, { mode: 0o755 });
    const run = spawn("bash", [join(DESKTOP, "install")], { env: { ...ownEnv, HOME: home, SANDBOX_RELEASE: `http://127.0.0.1:${RELEASES}/missing` }, stdio: ["ignore", "ignore", "pipe"] });
    let said = "";
    run.stderr.on("data", (d) => (said += d));
    assert.equal(await new Promise((r) => run.once("exit", r)), 1);
    assert.match(said, /The download failed\. Check your connection, then update again\./);
    await until("the app opened", async () => existsSync(join(home, "opened")), 5000);
  });
});
