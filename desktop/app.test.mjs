// The real Electron app on a throwaway relay and launcher and a stand-in GitHub; run with `xvfb-run -a node --test desktop/app.test.mjs`.
import { execFile, spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir, userInfo } from "node:os";
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
// Below the kernel's ephemeral range (32768 and up), where outgoing connections already hold ports.
const port = () => 20000 + Math.floor(Math.random() * 12000);
const children = [];
/** Where the run saves screenshots for review, when it is given a folder. */
const CAPTURES = process.env.SANDBOX_CAPTURES;
const capture = (page, name) => CAPTURES && page.screenshot({ path: join(CAPTURES, `${name}.png`) });

async function until(what, check, ms = 20000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
    const got = await Promise.race([check().catch(() => null), sleep(end - Date.now())]);
    if (got) return got;
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function bun(script, env) {
  const proc = spawn("bun", [script], { env: { ...ownEnv, ...env }, stdio: "ignore", detached: true });
  children.push(proc);
  return proc;
}

/** Each server leads its own process group, so killing the group also takes the worlds it started, even when the run itself is killed. */
function cleanUp() {
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  }
  rmSync(dir, { recursive: true, force: true });
}
process.on("exit", cleanUp);
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(signal, () => process.exit(code));
// The runner reads results from stdout, so a broken stdout means the runner is gone.
process.stdout.on("error", () => process.exit(1));

/** Closes a browser page, failing by name if it hangs. */
const closePage = (page) => {
  const url = page.url();
  return Promise.race([page.close(), sleep(10000).then(() => { throw new Error(`Timed out closing the page at ${url}`); })]);
};

/** This machine's own service keys never reach the app under test. */
// Nothing here signs up for free voice with the real Community server.
const ownEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.endsWith("_API_KEY"))), SANDBOX_COMMUNITY: "http://127.0.0.1:1" };
const VOICE_KEY = "sk_test_voice_key";

/** A small real JPEG, standing in for a world's picture. */
const COVER = Buffer.from("/9j/4AAQSkZJRgABAgAAAQABAAD//gARTGF2YzU4LjEzNC4xMDAA/9sAQwAIFBQXFBcbGxsbGxsgHiAhISEgICAgISEhJCQkKioqJCQkISEkJCgoKiouLy4rKyorLy8yMjI8PDk5RkZIVlZn/8QASwABAQAAAAAAAAAAAAAAAAAAAAUBAQAAAAAAAAAAAAAAAAAAAAUQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAIABADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCGAIGP/9k=", "base64");

/** A world shared to Community: an export's zip, as the Worker serves it. */
const { zipSync, unzipSync } = createRequire(join(DESKTOP, "../package.json"))("fflate");
const tinyIsle = Buffer.from(zipSync({ "config.json": Buffer.from(JSON.stringify({ name: "Tiny Isle", rules: "open", start: "blank" })), "cover.jpg": COVER, "world/mods/isle/server.ts": Buffer.from("export default { load() {} };") }));

/** GitHub as the app sees it: the latest release and the installer script the app runs to update; Community, with one world and whatever the app shares; and ElevenLabs, which knows one key. */
const releases = { latest: VERSION, installer: null, build: true };
/** The release's build for this computer, sent slowly enough to watch it download. */
const BUILD = Buffer.alloc(4 << 20, 7);
const RELEASES = port();
const isle = { id: "tinyisle0001", title: "Tiny Isle", description: "One small island.", author: "maker", visibility: "public", votes: 2, plays: 5, players: 3, forks: 0, cover: `http://127.0.0.1:${RELEASES}/files/tinyisle0001/cover`, zip: `http://127.0.0.1:${RELEASES}/files/tinyisle0001/zip`, clip: null, link: "https://site.example/w/tinyisle0001" };
const community = { shared: null, mod: null, files: {}, session: "session-token-1" };
const jetpack = { id: "jetpack00001", kind: "mod", name: "jetpack", title: "Jetpack", description: "Fly with space.", author: "maker", votes: 4, uses: 12, forks: 0, cover: `http://127.0.0.1:${RELEASES}/files/tinyisle0001/cover`, link: "https://site.example/m/jetpack00001", readme: "# Jetpack\nHold space to fly. Fuel refills on the ground.", api: '// server.ts, reached with world.use("jetpack")\n/** Fuel left for a player, 0 to 1. */\nfuel(world, player: string): number', builders: ["maker"], parent: null };
const ACCOUNT = { username: "ana", email: "ana@example.com" };
const body = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks)));
});
const github = createServer(async (req, res) => {
  const signedIn = req.headers.authorization === `Bearer ${community.session}`;
  if (req.url === "/sessions" && req.method === "POST") {
    const { email, password } = JSON.parse(await body(req));
    if (email !== ACCOUNT.email || password !== "lava-keep-9") return (res.statusCode = 401), res.end(JSON.stringify({ error: "That email and password don't match." }));
    return res.end(JSON.stringify({ token: community.session, account: ACCOUNT }));
  }
  if (req.url === "/account") return signedIn ? res.end(JSON.stringify({ account: ACCOUNT })) : ((res.statusCode = 401), res.end("{}"));
  if (req.url === "/worlds" && req.method === "POST") {
    if (!signedIn) return (res.statusCode = 401), res.end("{}");
    community.shared = JSON.parse(await body(req));
    const uploads = Object.fromEntries(Object.keys(community.shared.files).map((kind) => [kind, `http://127.0.0.1:${RELEASES}/upload/${kind}`]));
    return res.end(JSON.stringify({ id: "shared000001", link: "https://site.example/w/shared000001", ownerToken: "owner", uploads }));
  }
  if (req.url === "/mods" && req.method === "POST") {
    if (!signedIn) return (res.statusCode = 401), res.end("{}");
    community.mod = JSON.parse(await body(req));
    const uploads = Object.fromEntries(Object.keys(community.mod.files).map((kind) => [kind, `http://127.0.0.1:${RELEASES}/upload/mod-${kind}`]));
    return res.end(JSON.stringify({ id: "sharedmod001", link: "https://site.example/m/sharedmod001", uploads }));
  }
  if (req.url === "/worlds/sharedmod001/done" && req.method === "POST") return res.end(JSON.stringify({ id: "sharedmod001", kind: "mod", title: community.mod.title, author: ACCOUNT.username, link: "https://site.example/m/sharedmod001" }));
  if (req.url.split("?")[0] === "/mods") return res.end(JSON.stringify([jetpack].filter((m) => m.readme.toLowerCase().includes(new URL(req.url, "http://x").searchParams.get("q").toLowerCase()))));
  if (req.url === "/mods/jetpack00001") return res.end(JSON.stringify(jetpack));
  if (req.url.startsWith("/upload/") && req.method === "PUT") {
    community.files[req.url.slice(8)] = await body(req);
    return res.end();
  }
  if (req.url === "/worlds/shared000001/done" && req.method === "POST") {
    const { title, description, visibility } = community.shared;
    return res.end(JSON.stringify({ id: "shared000001", link: "https://site.example/w/shared000001", title, description, visibility }));
  }
  if (req.url.split("?")[0] === "/worlds") return res.end(JSON.stringify([isle]));
  if (req.url === "/worlds/tinyisle0001") return res.end(JSON.stringify(isle));
  if (req.url === "/files/tinyisle0001/cover") return res.end(COVER);
  if (req.url === "/files/tinyisle0001/zip") return res.end(tinyIsle);
  if (req.url === "/latest") return res.end(JSON.stringify({ tag_name: `v${releases.latest}` }));
  if (req.url === "/hang") return;
  if (req.url === "/install" && releases.installer) return res.end(releases.installer);
  if (req.url === "/release/Sandbox-linux-x86_64.AppImage" && releases.build) {
    res.setHeader("content-length", BUILD.length);
    for (let at = 0; at < BUILD.length && !res.destroyed; at += 1 << 17) {
      res.write(BUILD.subarray(at, at + (1 << 17)));
      await sleep(100);
    }
    return res.end();
  }
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
const startOther = () => bun(join(ROOT, "engine/launcher.ts"), { PORT: String(OTHER), SANDBOX_DATA: join(dir, "other"), SANDBOX_RELAY: relayUrl, SANDBOX_NO_OPEN: "1" });

async function menu(base, key, action, body) {
  const res = await fetch(`${base}/api/menu/${action}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${key}` }, body: body && JSON.stringify(body) });
  return res.json();
}

before(async () => {
  bun(join(ROOT, "relay/relay.ts"), { PORT: String(RELAY), RELAY_CLAIMS: join(dir, "claims.json") });
  otherLauncher = startOther();
  const base = `http://127.0.0.1:${OTHER}`;
  const { key } = await until("the other launcher", async () => (await fetch(`${base}/api/local-key`)).json());
  await menu(base, key, "create", { name: "Snow Race" });
  const running = await until("the other world's relay link", async () => {
    const { running } = await menu(base, key, "state");
    return running?.link.startsWith(relayUrl) && running;
  });
  other = { base, key, url: running.link.split("/#")[0], invite: running.invite };
});

after(() => {
  cleanUp();
  github.closeAllConnections();
  github.close();
});

/** The game's menu is a closed shadow root, out of mods' reach; the tests open it so their selectors reach in. */
const OPEN_UI = () => {
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    return attach.call(this, { ...init, mode: "open" });
  };
};

/** Opens the app with its own settings folder; the same name reopens the same install. Its player is already named unless `player` is null. */
async function launch(name, env = {}, player = "host") {
  const saved = join(dir, name, "Sandbox", "state.json");
  if (player && !existsSync(saved)) {
    mkdirSync(join(dir, name, "Sandbox"), { recursive: true });
    writeFileSync(saved, JSON.stringify({ recents: [], hosts: {}, mic: [], name: player }));
  }
  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: [DESKTOP, "--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
    env: { ...ownEnv, SANDBOX_STT: `http://127.0.0.1:${RELEASES}`, XDG_CONFIG_HOME: join(dir, name), SANDBOX_RELAY: relayUrl, SANDBOX_UPDATES: `http://127.0.0.1:${RELEASES}/latest`, SANDBOX_INSTALLER: `http://127.0.0.1:${RELEASES}/install`, SANDBOX_RELEASE: `http://127.0.0.1:${RELEASES}/release`, SANDBOX_UPDATE_EVERY: "500", SANDBOX_COMMUNITY: `http://127.0.0.1:${RELEASES}`, ...env },
  });
  await app.context().addInitScript(OPEN_UI);
  const shell = await until("the start screen", async () => app.windows().find((w) => w.url().startsWith("sandbox://app/shell.html")));
  await shell.locator(player ? "#title" : "#name").waitFor();
  return { app, shell, state: () => (existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) : {}) };
}

/** Leaves the game for the title, and waits for its page to close, which it does only once it has sent the host's view of the world. */
async function leave(app, shell) {
  const left = app.windows().filter((w) => /^https?:/.test(w.url()));
  await shell.click("#leave");
  await Promise.all(left.map((w) => w.isClosed() || w.waitForEvent("close")));
}
const gamePage = (app) => until("the game view", async () => app.windows().find((w) => /^https?:/.test(w.url())));
const menuShown = (shell) => shell.locator("#title .items").isVisible();
const shown = (page, sel) => page.locator(sel).isVisible();
const rows = (shell) => shell.locator("#games .item").evaluateAll((items) => items.map((b) => [...b.childNodes].filter((n) => !n.classList.contains("cover")).map((n) => n.textContent).join(" | ")));
/** The width each row's picture loaded at, or null for a plain tile; a broken image would be 0. */
const pictures = (list) => list.locator(".item .cover").evaluateAll((tiles) => tiles.map((t) => t.querySelector("img")?.naturalWidth ?? null));
/** Answers the app's next question dialogs with this button, and keeps what they asked. */
const answer = (app, response) =>
  app.evaluate(({ dialog }, response) => {
    globalThis.asked = [];
    dialog.showMessageBox = async (_win, options) => (globalThis.asked.push(options), { response });
  }, response);
const asked = (app) => app.evaluate(() => globalThis.asked);

/** In the game: the app joins as its player's name without asking. */
/** In the game: the HUD shows and the server has welcomed this player. */
const playing = (page) => until("the game", () => page.locator("#hud").evaluate((hud) => !hud.hidden && hud.getRootNode().getElementById("status").hidden));

async function joinAs(page, name) {
  await page.locator("#join-name").waitFor();
  await page.fill("#join-name", name);
  await page.click("#join-go");
  await until("the game", () => page.locator("#join").isHidden());
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
  before(async () => ({ app, shell, state } = await launch("host", {}, null)));
  after(() => close(app));

  test("first launch asks the player's name once, starting from this computer's user name", async () => {
    await shell.locator("#name-first").waitFor();
    assert.equal(await shell.inputValue("#name-first"), userInfo().username.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 16));
    await shell.fill("#name-first", "x");
    await shell.click("#name-go");
    assert.equal(await shell.textContent("#error"), "Names are 2–16 letters, digits, - or _.");
    await shell.fill("#name-first", "Host");
    await shell.press("#name-first", "Enter");
    await until("the menu", () => menuShown(shell));
    assert.equal(state().name, "host");
    await shell.click("text=Settings");
    assert.equal(await shell.inputValue("#name-field"), "host");
    await shell.keyboard.press("Escape");
  });

  test("the title menu, no update, and no worlds yet", async () => {
    await until("the menu", () => menuShown(shell));
    assert.deepEqual(await shell.locator("#title .item:visible").allTextContents(), ["Worlds", "Join world", "Host world", "Settings", "Quit"]);
    assert.equal(await shell.textContent("#version"), `Sandbox ${VERSION}`);
    await capture(shell, "title");
    await shell.click("text=Worlds");
    assert.equal(await shown(shell, "#no-games"), true);
  });

  test("every screen goes back with Esc and with Back", async () => {
    await shell.keyboard.press("Escape");
    assert.equal(await shown(shell, "#title"), true);
    await shell.click("text=Join world");
    await shell.click("#back");
    assert.equal(await shown(shell, "#title"), true);
  });

  test("Join world fills in a copied invite link, and nothing else", async () => {
    const cases = {
      [`${other.url}/#invite=${other.invite}`]: `${other.url}/#invite=${other.invite}`,
      "http://192.168.1.20:7777/#key=0123456789abcdef": "http://192.168.1.20:7777/#key=0123456789abcdef",
      "k7f-m2q": "",
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
        document.getElementById("join-link").value = "";
        dispatchEvent(new Event("focus"));
      });
      if (filled) await until(`${copied} filled in`, async () => (await shell.inputValue("#join-link")) === filled, 5000).catch(() => {});
      else await sleep(1000);
      assert.equal(await shell.inputValue("#join-link"), filled, `copied ${JSON.stringify(copied)}`);
    }
    await app.evaluate(({ clipboard }) => clipboard.writeText(""));
    await shell.evaluate(() => (document.getElementById("join-link").value = ""));
  });

  test("anything but a link asks for the invite link", async () => {
    await shell.click("text=Join world");
    await shell.fill("#join-link", "AAAAAA");
    await shell.press("#join-link", "Enter");
    await until("the error", async () => (await shell.textContent("#error")) === "Paste the invite link your host sent.");
    await shell.keyboard.press("Escape");
  });

  test("Host world opens this computer's main menu, never Waiting for the host", async () => {
    await shell.click("text=Host world");
    const game = await gamePage(app);
    await game.locator("#create").waitFor();
    assert.equal(await shown(game, "#waiting"), false);
    assert.match(game.url(), /^http:\/\/localhost:\d+\/menu/);
  });

  test("the app's Host screen has no second title menu: Esc goes back to the app's own", async () => {
    const game = await gamePage(app);
    // The page closes as the key goes down.
    await game.keyboard.press("Escape").catch(() => {});
    await until("the app's title", () => menuShown(shell));
    await shell.click("text=Host world");
    await until("the Host screen", async () => (await gamePage(app)).locator("#create").isVisible());
  });

  test("Host untouched starts a new 3D field anyone may change, and the host plays it as their name", async () => {
    const game = await gamePage(app);
    assert.deepEqual(await game.locator("#create .field:visible output").allTextContents(), ["New world", "3D field", "Allowed", "Anyone changes"]);
    assert.equal(await game.inputValue("#create-password"), "");
    const host = await game.locator("#create-go").evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { focused: document.activeElement === el, clickable: document.elementFromPoint(box.x + 40, box.y + box.height / 2) === el, aboveHints: box.bottom <= document.querySelector(".hints").getBoundingClientRect().top };
    });
    assert.deepEqual(host, { focused: true, clickable: true, aboveHints: true });
    assert.equal(await game.textContent("#enter-hint"), "EnterHost");
    await game.keyboard.press("Enter");
    await game.waitForURL(/:\d+\/(#.*)?$/);
    await playing(game);
    const world = await game.textContent("#world-name");
    assert.notEqual(world, "Sandbox");
    await until("the world's name in the title bar", async () => (await shell.textContent("#world")) === world);
    assert.equal(await shown(game, "#rules"), false);
    assert.equal(await game.textContent("#claude"), "Connect to build");
    assert.equal(await game.textContent("#howto .cmd"), "Ctrl");
    assert.equal(await game.evaluate(() => localStorage.getItem("sandbox-name")), "host");
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
    assert.equal(await game.locator("#voice-key").evaluate((el) => el.getRootNode().activeElement === el), true);
    assert.equal(await shown(game, "#howto"), false);
    await game.fill("#voice-key", "sk_wrong");
    await game.press("#voice-key", "Enter");
    await until("the refusal", async () => (await game.textContent("#toasts")).includes("ElevenLabs didn't accept that key. Copy it again from elevenlabs.io."));
    assert.equal(await game.textContent("#voice-where"), "Paste a speech key from Groq (free), OpenAI, Gemini, ElevenLabs or Deepgram.");
    await app.evaluate(({ shell }) => (shell.openExternal = async (url) => void (globalThis.opened ??= []).push(url)));
    for (const link of await game.locator("#voice-where a").all()) await link.click();
    assert.deepEqual(await until("the key pages", () => app.evaluate(() => globalThis.opened?.length === 5 && globalThis.opened)), ["https://console.groq.com/keys", "https://platform.openai.com/api-keys", "https://aistudio.google.com/apikey", "https://elevenlabs.io/app/settings/api-keys", "https://console.deepgram.com/"]);
    await game.fill("#voice-key", VOICE_KEY);
    await game.press("#voice-key", "Enter");
    await until("voice on", async () => (await game.textContent("#mic")) === "Hold T to talk");
    assert.equal(await game.getAttribute("#voice-key", "placeholder"), "ElevenLabs ••••_key");
    assert.equal(await game.inputValue("#voice-key"), "");
    assert.equal(readFileSync(join(dir, "host", "Sandbox", "data", "secrets.json"), "utf8").includes(VOICE_KEY), true);
    await game.keyboard.press("Escape");
    await game.keyboard.press("Escape");
  });

  test("connecting an agent: the player picks theirs, gets its install, a one-time command that sets up the world's folder, and the prompt to paste there", async () => {
    const game = await gamePage(app);
    await game.locator("#menu-button").dispatchEvent("click");
    await game.click("#rail [data-tab=claude]");
    assert.equal(await shown(game, "#agent-guide"), false);
    await game.locator(".item.agent:not(.build)", { hasText: "Claude Code" }).click();
    const [, folder] = await until("the world's folder", async () => (await game.textContent("#agent-start")).match(/^cd (~\/Sandbox\/[a-z0-9-]+) && claude$/));
    assert.deepEqual([await game.textContent("#agent-install"), await game.textContent("#agent-start")], ["curl -fsSL https://claude.ai/install.sh | bash", `cd ${folder} && claude`]);
    assert.deepEqual([await game.textContent("#agent-os output"), await game.textContent("#agent-terminal")], ["Linux", "Press Ctrl+Alt+T. Paste this line and press Enter."]);
    await capture(game, "agent-page");
    await game.click("#agent-os i:last-child");
    assert.deepEqual([await game.textContent("#agent-os output"), await game.textContent("#agent-install")], ["Windows", "irm https://claude.ai/install.ps1 | iex"]);
    assert.match(await game.textContent("#agent-terminal"), /^Press the Windows key, type PowerShell, press Enter\./);
    const copy = game.locator("[data-copy=agent-connect]");
    const box = await copy.boundingBox();
    await copy.click();
    await until("Copied", async () => (await copy.textContent()) === "Copied");
    assert.deepEqual(await copy.boundingBox(), box);
    const command = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert.equal(command, await game.textContent("#agent-connect"));
    assert.match(command, /^curl -fsSL '[^']+\/join\/[0-9a-f]{12}' \| sh$/);
    await until("Copy again", async () => (await copy.textContent()) === "Copy");
    assert.match(await game.textContent("#agent-prompt"), /^We're playing .+\. Read AGENTS\.md in this folder and join as it says\.$/);
    // The page remembers the pick, and Change goes back to the list on that agent.
    await game.keyboard.press("Escape");
    await game.click("#rail [data-tab=claude]");
    assert.equal(await shown(game, "#agent-guide"), true);
    await game.click("#agent-picked");
    assert.equal(await game.evaluate(() => document.querySelector("#ui").shadowRoot.activeElement?.textContent), "Claude CodeTerminal");
    await game.keyboard.press("Escape");
    await game.keyboard.press("Escape");
  });

  test("leaving shows the hosted world, live, marked Hosted, with the host's view as its picture", async () => {
    await leave(app, shell);
    await shell.click("text=Worlds");
    const [row] = await until("the hosted world", async () => (await rows(shell)).length && rows(shell));
    assert.match(row, /^.+ \| Live \| Hosted$/);
    assert.equal((await rows(shell)).length, 1);
    const shot = async () => (await shell.evaluate(() => dispatchEvent(new Event("focus"))), (await pictures(shell.locator("#games")))[0]);
    assert.equal(await until("the picture", shot), 480);
    await shell.keyboard.press("Escape");
  });

  test("a link joins through the relay; reload stays in the room; the world is saved under its relay address", async () => {
    await shell.click("text=Join world");
    await shell.fill("#join-link", `${other.url}/#invite=${other.invite}`);
    await shell.press("#join-link", "Enter");
    const game = await gamePage(app);
    const stills = [];
    game.on("request", (r) => r.url().includes("/stills/") && stills.push(r.url()));
    await playing(game);
    assert.equal(game.url(), `${other.url}/`);
    assert.equal(await game.textContent("#mic"), "Voice off: ask the host to turn it on");
    await game.reload();
    await game.locator("#join").waitFor({ state: "hidden" });
    assert.equal(await game.locator("#join").isHidden(), true);
    assert.match(game.url(), new RegExp(`^${other.url}/`));
    assert.deepEqual(stills, []);
    await until("the saved world", async () => state().recents.find((r) => r.url === other.url && r.name === "Snow Race"));
    await leave(app, shell);
  });

  test("the joined world is listed as Joined, and Forget removes it", async () => {
    await shell.click("text=Worlds");
    await until("both worlds", async () => (await rows(shell)).length === 2);
    assert.ok((await rows(shell)).some((r) => /^Snow Race \| .+ \| Joined$/.test(r)));
    await shell.focus('#games .item:has-text("Snow Race")');
    await shell.keyboard.press("Delete");
    assert.equal(await shell.textContent("#forget-title"), "Forget Snow Race?");
    await shell.click("#forget-yes");
    await until("one world", async () => (await rows(shell)).length === 1);
    assert.equal(state().recents.some((r) => r.url === other.url), false);
    await shell.keyboard.press("Escape");
  });

  test("an invite link opens the game; a /r/ link without its scheme becomes https", async () => {
    await shell.click("text=Join world");
    await shell.fill("#join-link", `${other.base}/#invite=${other.invite}`);
    await shell.press("#join-link", "Enter");
    await playing(await gamePage(app));
    await leave(app, shell);
    const bare = await shell.evaluate(async () => (await import("/front.js")).joinLink("sandbox-relay.example.com/r/ab12cd/"));
    assert.equal(bare, "https://sandbox-relay.example.com/r/ab12cd/");
  });

  test("Community plays a shared world from the launch screen after the trust question, and the game's Share publishes a world as the signed-in account with its picture and a clip of its timelapse", async () => {
    await shell.click("[data-to=settings]");
    await shell.click("#go-account");
    await shell.fill("#signin-email", ACCOUNT.email);
    await shell.fill("#signin-password", "lava-keep-9");
    await shell.click("#signin-go");
    await until("the account", async () => (await shell.inputValue("#account-username")) === "ana");
    await shell.keyboard.press("Escape");
    await shell.keyboard.press("Escape");
    await until("the app's title", () => menuShown(shell));

    await shell.click("text=Worlds");
    await shell.click("#go-community");
    const listed = shell.locator("#community-list .item");
    await until("the community worlds", async () => (await listed.count()) === 1);
    assert.equal(await listed.first().locator(".what").textContent(), "Tiny Isleby maker · 5 plays · 2 votes");
    await listed.first().click();
    await until("the world's screen", async () => (await shell.textContent("#cworld-title")) === "Tiny Isle");
    await shell.click("#cworld-play");
    await until("the trust question", async () => (await shell.textContent("#trust-text")) === "This world runs code from maker. Only play worlds from people you trust.");
    await shell.click("#trust-yes");
    const game = await gamePage(app);
    await playing(game);
    assert.equal(await game.textContent("#world-name"), "Tiny Isle");
    const worlds = join(dir, "host", "Sandbox", "data", "worlds");
    const isleId = readdirSync(worlds).find((id) => id.startsWith("tiny-isle-"));
    assert.deepEqual(readFileSync(join(worlds, isleId, "cover.jpg")), COVER);

    // The timelapse records a moment every two seconds; the clip needs two.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await game.locator("#menu-button").dispatchEvent("click");
    await game.click("#rail [data-tab=world]");
    await game.click("#world-share");
    await until("the share page", async () => (await game.inputValue("#share-title")) === "Tiny Isle");
    await game.fill("#share-description", "One small island, remixed.");
    await answer(app, 0);
    await game.click("#share-go");
    await until("the shared link", async () => (await game.textContent("#share-link")) === "https://site.example/w/shared000001", 60_000);
    assert.deepEqual((await asked(app)).map((q) => q.message), ["Publish Tiny Isle as ana?"]);
    assert.deepEqual([community.shared.title, community.shared.visibility, community.shared.forkOf], ["Tiny Isle", "link", "tinyisle0001"]);
    assert.deepEqual(community.files.cover, COVER, "the world's picture");
    assert.deepEqual([...community.files.clip.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
    assert.equal(community.files.zip.subarray(0, 2).toString(), "PK");
    assert.equal(await game.textContent("#share-go"), "Update");

    // One mod of it goes to Community on its own from the Mods page, with the current view as its preview.
    await game.click("#rail [data-tab=mods]");
    const isleRow = game.locator("#menu-mods li", { hasText: "isle" });
    await capture(game, "game-mods-share");
    await answer(app, 0);
    await isleRow.locator("button", { hasText: "Share" }).click();
    await until("the mod's toast", async () => (await game.locator("#toasts .toast").allTextContents()).includes("isle is in Community: https://site.example/m/sharedmod001"), 30_000);
    assert.deepEqual((await asked(app)).map((q) => q.message), ["Publish the mod isle as ana?"]);
    assert.deepEqual([community.mod.name, community.mod.forkOf, community.mod.packages, community.mod.needs], ["isle", undefined, {}, []]);
    assert.deepEqual(Object.keys(unzipSync(community.files["mod-zip"])), ["server.ts"]);
    assert.deepEqual([...community.files["mod-cover"].subarray(0, 2)], [0xff, 0xd8]);
    assert.deepEqual(JSON.parse(readFileSync(join(worlds, isleId, "world", "mods", "isle", "community.json"), "utf8")), { id: "sharedmod001", name: "isle", title: "isle", author: "ana", link: "https://site.example/m/sharedmod001" });
    await leave(app, shell);
    await until("the host's view of Tiny Isle", async () => readFileSync(join(worlds, isleId, "cover.jpg")).length > COVER.length);

    // Community's Mods tab finds a mod by its README and shows what it does, its API and the line that adds it.
    await shell.click("text=Worlds");
    await shell.click("#go-community");
    await shell.locator("#community-tab i").first().click();
    assert.equal(await shell.textContent("#community-tab output"), "Mods");
    await shell.fill("#mods-search", "fuel");
    const mods = shell.locator("#community-list .item");
    await until("the mods found", async () => (await mods.count()) === 1 && (await mods.first().textContent()).includes("Jetpack"));
    assert.equal(await mods.first().locator(".value").textContent(), "12 worlds use it");
    await capture(shell, "shell-community-mods");
    await mods.first().click();
    await until("the mod's README", async () => (await shell.textContent("#cworld-readme")).startsWith("# Jetpack"));
    assert.equal(await shown(shell, "#cworld-play"), false);
    assert.equal(await shell.textContent("#cworld-add-line"), "./world add_mod id=jetpack00001");
    assert.match(await shell.textContent("#cworld-api"), /fuel\(world, player: string\): number/);
    await capture(shell, "shell-community-mod");
    await shell.keyboard.press("Escape");
    await shell.keyboard.press("Escape");
    await shell.keyboard.press("Escape");
  });

  test("a hosted world opens straight into the game, and Stop hosting in its World tab ends it and goes back to the title", async () => {
    await shell.click("text=Worlds");
    await shell.click("#games .item >> text=Tiny Isle");
    const game = await gamePage(app);
    await playing(game);
    await game.locator("#menu-button").dispatchEvent("click");
    await game.click("#rail [data-tab=world]");
    await game.click("#world-stop");
    assert.equal(await game.textContent("#world-stop"), "Stop for everyone?");
    await game.click("#world-stop");
    await until("the app's title", () => menuShown(shell));
    await shell.click("text=Worlds");
    await until("Tiny Isle stopped", async () => (await rows(shell)).some((r) => /^Tiny Isle \| .+ ago \| Hosted$|^Tiny Isle \| just now \| Hosted$/.test(r)));
    await shell.keyboard.press("Escape");
  });

  test("quitting stops the game server", async () => {
    const own = state().port;
    await answer(app, 0);
    await shell.click("#quit");
    await until("the server to stop", async () => !(await portAnswers(own)));
  });
});

describe("a friend in a browser", () => {
  let app, shell, game, browser, page, link;
  before(async () => {
    ({ app, shell } = await launch("friendly", {}, "alex"));
    browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
  });
  after(async () => {
    await browser?.close();
    await close(app);
  });
  /** A friend's own browser, which has never seen this world. */
  const friend = async () => {
    const context = await browser.newContext();
    await context.addInitScript(OPEN_UI);
    return context.newPage();
  };
  /** The host's Host screen with the world they're hosting picked, its settings changed, and hosted again. */
  async function rehost(change) {
    await leave(app, shell);
    await shell.click("text=Host world");
    game = await until("the Host screen", async () => app.windows().find((w) => /\/menu(#.*)?$/.test(w.url())));
    await game.locator("#create").waitFor();
    await game.locator("#create-world i").nth(1).click();
    await change();
    await game.click("#create-go");
    await playing(game);
  }

  test("the host hosts untouched, and a friend joins by the link in a browser with only a name", async () => {
    await shell.click("text=Host world");
    game = await gamePage(app);
    await game.click("#create-go");
    await playing(game);
    await game.locator("#menu-button").dispatchEvent("click");
    await game.click("#rail [data-tab=invite]");
    link = await game.textContent("#invite-link");
    page = await friend();
    await page.goto(link);
    await page.locator("#join-name").waitFor();
    assert.equal(await shown(page, "#join-password-field"), false);
    await joinAs(page, "sam");
    await playing(page);
    assert.equal(await page.locator(".item.agent.build").count(), 0);
  });

  test("sam's name on a new computer, while sam is offline, asks the host, who can say no or let them in", async () => {
    const base = page.url().replace(/\/(#.*)?$/, "");
    await closePage(page);
    await until("sam offline", async () => (await (await fetch(`${base}/api/info`)).json()).online === 1);
    page = await friend();
    await page.goto(link);
    await page.fill("#join-name", "sam");
    await page.click("#join-go");
    await until("asking", async () => (await page.textContent("#join-error")) === "Asking the host…");
    const ask = game.locator(".toast.asking");
    assert.equal(await ask.evaluate((t) => t.firstChild.textContent), "sam is joining from a new computer.");
    await ask.locator("button", { hasText: "No" }).click();
    await until("the refusal", async () => (await page.textContent("#join-error")) === "The host didn't let you in as sam. Pick another name.");
    await page.click("#join-go");
    await ask.locator("button", { hasText: "Let in" }).click();
    await playing(page);
  });

  test("a password is asked once on each device, and a wrong one says so", async () => {
    await rehost(() => game.fill("#create-password", "moon"));
    assert.equal(await game.evaluate(() => localStorage.getItem("sandbox-name")), "alex");
    page = await friend();
    await page.goto(link);
    await page.locator("#join-password").waitFor();
    await page.fill("#join-name", "jo");
    await page.fill("#join-password", "sun");
    await page.click("#join-go");
    await until("the refusal", async () => (await page.textContent("#join-error")) === "That password isn't right.");
    await page.fill("#join-password", "moon");
    await page.click("#join-go");
    await playing(page);
    await page.reload();
    await playing(page);
    assert.equal(await shown(page, "#join"), false);
  });

  test("with agents off, the agent page says so and the command refuses in plain words", async () => {
    await rehost(() => game.locator("#create-agents i").nth(1).click());
    const base = page.url().replace(/\/(#.*)?$/, "");
    await until("agents off", async () => (await (await fetch(`${base}/api/info`)).json()).agents === false);
    const back = await page.context().newPage();
    await closePage(page);
    page = back;
    await page.goto(base);
    await playing(page);
    assert.equal(await shown(page, "#claude"), false);
    await page.locator("#menu-button").dispatchEvent("click");
    await page.click("#rail [data-tab=claude]");
    assert.equal(await page.textContent("#agents-off"), "The host turned agents off for this world.");
    assert.equal(await shown(page, "#agent-connect"), false);
    const { id } = await (await fetch(`${base}/api/info`)).json();
    const key = await page.evaluate((id) => localStorage.getItem(`sandbox-key:${id}`), id);
    const res = await fetch(`${base}/cli/status`, { method: "POST", headers: { authorization: `Bearer ${key}` } });
    assert.deepEqual([res.status, await res.text()], [403, "The host turned agents off for this world.\n"]);
  });

  test("Add only rules show by the world's name", async () => {
    await rehost(() => game.locator("#create-rules i").nth(1).click());
    assert.equal(await game.textContent("#rules"), "Add only");
    assert.equal(await shown(game, "#rules"), true);
  });
});

describe("the relay down", () => {
  let app, shell;
  before(async () => ({ app, shell } = await launch("offline", { SANDBOX_RELAY: `http://127.0.0.1:${port()}` })));
  after(() => close(app));

  test("Host world still opens the main menu, on this computer", async () => {
    await shell.click("text=Host world");
    const game = await gamePage(app);
    await game.locator("#create").waitFor();
    assert.match(game.url(), /^http:\/\/localhost:\d+\/menu/);
  });

  test("the host's invite is a Wi-Fi link, and Invite says why", async () => {
    const game = await gamePage(app);
    await game.fill("#create-name", "Home World");
    await game.click("#create-go");
    await playing(game);
    await game.locator("#menu-button").dispatchEvent("click");
    await game.click("#rail [data-tab=invite]");
    assert.match(await game.textContent("#invite-link"), /^http:\/\/(\d+\.){3}\d+:\d+\/#invite=[0-9a-f]+$/);
    assert.equal(await shown(game, "#invite-wifi"), true);
    assert.equal(await game.textContent("#invite-wifi"), "Internet invites are down. Friends on your Wi-Fi can still join.");
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
    await playing(game);
    assert.equal(await game.textContent("#world-name"), "Home World");
  });
});

/** The real installer's handshake: download, say so, wait for the app to quit, then install; this one writes down the app it waited for. */
const installer = (marker) => `echo "Downloading Sandbox"; sleep 1; echo "Quit Sandbox to continue."; while kill -0 "$SANDBOX_APP_PID" 2>/dev/null; do sleep 0.2; done; echo "$SANDBOX_APP_PID" > '${marker}'; echo "$SANDBOX_RELEASE" > '${marker}.release'`;

describe("starting up", () => {
  after(() => {
    releases.latest = VERSION;
    releases.installer = null;
    releases.build = true;
  });

  test("offline, the menu shows and offers no update", async () => {
    const { app, shell } = await launch("start-offline", { SANDBOX_UPDATES: "http://127.0.0.1:1/latest" });
    await until("the menu", () => menuShown(shell));
    assert.equal(await shown(shell, "#go-update"), false);
    await close(app);
  });

  test("a damaged settings file stops the game server with a plain cause, details to copy, and Retry starts it fresh", async () => {
    const data = join(dir, "broken", "Sandbox", "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "launcher.json"), "{");
    const { app, shell } = await launch("broken");
    await until("the menu", () => menuShown(shell));
    await shell.click("#go-new");
    await shell.locator("#down").waitFor();
    assert.equal(await shell.textContent("#down-title"), "Couldn't start");
    assert.equal(await shell.textContent("#down-text"), "A saved settings file is damaged. Retry starts with fresh settings.");
    await shell.click("#copy-details");
    await until("Copied", async () => (await shell.textContent("#copy-details")) === "Copied");
    assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /JSON Parse error/);
    assert.equal(readFileSync(join(data, "launcher.json.damaged"), "utf8"), "{");
    await shell.click("#retry");
    await gamePage(app);
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
    releases.build = false;
    const { app, shell, state } = await launch("start-fails");
    await until("the menu", () => menuShown(shell));
    assert.equal(await shown(shell, "#go-update"), true);
    assert.equal(await shown(shell, "#busy"), false);
    assert.equal(state().updatedTo, undefined);
    await close(app);
  });

  test("a newer release downloads with a bar of the bytes received and installs before the menu shows, then the installer opens the new version", async () => {
    const marker = join(dir, "installed-at-start");
    releases.installer = installer(marker);
    releases.build = true;
    const { app, shell, state } = await launch("start-updates");
    const pid = app.process().pid;
    const closed = new Promise((r) => app.once("close", r));
    await until("the progress", async () => (await shell.textContent("#busy")) === "Updating to 9.9.9…");
    assert.equal(await menuShown(shell), false);
    const downloaded = () => shell.locator("#progress i").evaluate((bar) => bar.offsetWidth / bar.parentElement.offsetWidth);
    await until("the download partway", async () => ((d) => d > 0.2 && d < 0.8)(await downloaded()));
    await capture(shell, "update-downloading");
    await until("Installing", async () => (await shell.textContent("#busy")) === "Installing…");
    assert.equal(await downloaded(), 1);
    await closed;
    await until("the installer", async () => existsSync(marker) && readFileSync(marker, "utf8").trim() === String(pid));
    assert.deepEqual(readFileSync(new URL(`${readFileSync(`${marker}.release`, "utf8").trim()}/Sandbox-linux-x86_64.AppImage`)), BUILD);
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
  let app, shell, state, game, link;
  before(async () => {
    releases.latest = VERSION;
    ({ app, shell, state } = await launch("update", {}, "robin"));
  });
  after(() => close(app));

  test("a release that comes out while hosting with friends shows Update on the title and in the game, and restarts nothing", async () => {
    await shell.click("text=Host world");
    game = await gamePage(app);
    await game.fill("#create-name", "Update Test");
    await game.click("#create-go");
    await playing(game);
    const own = state().port;
    const key = JSON.parse(readFileSync(join(dir, "update", "Sandbox", "data", "launcher.json"), "utf8")).hostKey;
    const s = await menu(`http://127.0.0.1:${own}`, key, "state");
    link = s.running.link;
    assert.ok(link.startsWith(`${relayUrl}/r/`));
    await guest(`http://127.0.0.1:${own}`, s.running.invite, "friend");
    const pid = app.process().pid;
    await answer(app, 0);
    releases.latest = "9.9.9";
    await until("Update in the game", () => game.locator("#menu-update").evaluate((b) => !b.hidden));
    assert.equal(await shell.textContent("#go-update"), "Update9.9.9");
    await sleep(1500);
    assert.deepEqual(await asked(app), []);
    assert.equal(app.process().pid, pid);
    assert.equal(await portAnswers(own), true);
  });

  test("a failed download says so and keeps the app and the game open", async () => {
    const own = state().port;
    releases.build = false;
    await answer(app, 0);
    await game.locator("#menu-update").evaluate((b) => b.click());
    await until("the error", async () => game.getByText("The update didn't download. Check your connection.").isVisible());
    const [q] = await asked(app);
    assert.equal(q.message, "Update to Sandbox 9.9.9?");
    assert.match(q.detail, /^1 player is in Update Test\. Updating ends the world for them\.$/);
    assert.equal(await portAnswers(own), true);
  });

  test("an update downloads before the app quits, then the installer takes over", async () => {
    const marker = join(dir, "installed");
    releases.installer = installer(marker);
    releases.build = true;
    const own = state().port;
    const pid = app.process().pid;
    await answer(app, 0);
    const closed = new Promise((r) => app.once("close", r));
    await game.locator("#menu-button").dispatchEvent("click");
    await game.click("#menu-update");
    await until("the download partway in the game's menu", () => game.locator("#menu-update").evaluate((b) => b.textContent === "Updating…" && ((d) => d > 0.2 && d < 0.8)(b.querySelector(".bar i").offsetWidth / b.querySelector(".bar").offsetWidth)));
    assert.equal(await game.getByText("The update didn't download. Check your connection.").count(), 0, "the last attempt's failure is gone");
    await capture(game, "update-in-game");
    await closed;
    await until("the installer", async () => existsSync(marker) && readFileSync(marker, "utf8").trim() === String(pid));
    assert.equal(await portAnswers(own), false);
    assert.equal(state().reopen.hosting, true);
    assert.match(state().reopen.url, new RegExp(`^http://localhost:${own}/`));
    app = null;
  });

  test("after the update the world is back up under the same link, and the host is back in it", async () => {
    releases.latest = VERSION;
    ({ app, shell, state } = await launch("update", {}, "robin"));
    game = await gamePage(app);
    const key = JSON.parse(readFileSync(join(dir, "update", "Sandbox", "data", "launcher.json"), "utf8")).hostKey;
    await until("the same link", async () => (await menu(`http://127.0.0.1:${state().port}`, key, "state")).running?.link === link);
    assert.equal((await fetch(`${link.split("/#")[0]}/api/info`)).status, 200);
    await game.locator("#join").waitFor({ state: "hidden" });
    assert.equal(state().reopen, undefined);
    assert.equal(await shown(shell, "#go-update"), false);
  });

  test("an update while in a friend's world brings the player back into it", async () => {
    await leave(app, shell);
    await shell.click("text=Join world");
    await shell.fill("#join-link", `${other.url}/#invite=${other.invite}`);
    await shell.press("#join-link", "Enter");
    game = await until("the friend's world", async () => app.windows().find((w) => w.url().startsWith(other.url)));
    await playing(game);
    const marker = join(dir, "installed-joined");
    releases.installer = installer(marker);
    releases.latest = "9.9.9";
    await until("Update in the game", () => game.locator("#menu-update").evaluate((b) => !b.hidden));
    await answer(app, 0);
    const closed = new Promise((r) => app.once("close", r));
    await game.locator("#menu-update").evaluate((b) => b.click());
    await closed;
    await until("the installer", async () => existsSync(marker));
    assert.equal(state().reopen.url.startsWith(`${other.url}/`), true);
    releases.latest = VERSION;
    ({ app, shell, state } = await launch("update", {}, "robin"));
    game = await gamePage(app);
    await playing(game);
    assert.equal(game.url().startsWith(`${other.url}/`), true);
    assert.equal(await game.locator("#join").isHidden(), true);
  });
});

describe("in a browser", () => {
  let browser, page;
  before(async () => {
    browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
    page = await browser.newPage();
    await page.addInitScript(OPEN_UI);
  });
  after(() => browser?.close());
  const join = async (name) => (await (await fetch(`${other.url}/api/join`, { method: "POST", body: JSON.stringify({ invite: other.invite, name }) })).json()).key;
  const tool = async (key, name, args) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(args)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
    return (await fetch(`${other.url}/cli/${name}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form })).text();
  };

  test("/menu through the relay, without the host's key, tells people it is the host's", async () => {
    await page.goto(`${other.url}/menu`);
    await until("the message", async () => (await page.textContent("#waiting")) === "Only the host can open this menu, on their own computer.");
    assert.equal(await page.locator("#title .item:visible").count(), 0);
  });

  test("/menu on the host's own computer needs no key, and offers the desktop app", async () => {
    await page.goto(`${other.base}/menu`);
    await page.click("#go-app");
    assert.equal(await page.textContent("#app-os output"), "Linux");
    assert.equal(await page.textContent("#app-open"), "Press Ctrl+Alt+T.");
    assert.match(await page.textContent("#app-install"), /desktop\/install \| bash -s -- '.+#key=/);
    await page.click("#app-os i:last-child");
    assert.equal(await page.textContent("#app-os output"), "Windows");
    assert.match(await page.textContent("#app-open"), /^Press the Windows key, type PowerShell/);
    assert.match(await page.textContent("#app-install"), /desktop\/install\.ps1\)\)\) '.+#key=/);
  });

  test("an invite link joins through the relay with a name and Play, and nothing else", async () => {
    await page.goto(`${other.url}/#invite=${other.invite}`);
    await until("the join screen", async () => (await page.textContent("#join-world")) === "Snow Race");
    assert.deepEqual(await page.locator("#join-main .item:visible").evaluateAll((items) => items.map((i) => i.id)), ["join-name-field", "join-go"]);
    assert.equal(await page.locator("#join-go").evaluate((b) => b.firstChild.textContent), "Play");
    await page.fill("#join-name", "Browser");
    await page.click("#join-go");
    await until("the game", () => page.locator("#join").isHidden());
    assert.ok(page.url().startsWith(other.url));
  });

  test("chat lines fade after a while and come back while the chat is open", async () => {
    await page.click("#howto-play");
    await page.keyboard.press("Enter");
    await page.keyboard.type("hello all");
    await page.keyboard.press("Enter");
    const line = page.locator("#feed .line", { hasText: "browser: hello all" });
    const opacity = () => line.evaluate((el) => Number(getComputedStyle(el).opacity));
    await line.waitFor();
    assert.equal(await opacity(), 1);
    await until("the line to fade", async () => (await opacity()) === 0);
    await page.keyboard.press("Enter");
    assert.equal(await opacity(), 1);
    await page.keyboard.press("Escape");
  });

  test("a late second notice that the mouse was freed doesn't open the menu once the chat has closed", async () => {
    await until("the mouse locked", () => page.evaluate(() => !!document.pointerLockElement));
    await page.evaluate(() => document.exitPointerLock());
    await until("the mouse freed", () => page.evaluate(() => !document.pointerLockElement));
    await page.evaluate(() => document.dispatchEvent(new Event("pointerlockchange")));
    await sleep(300);
    assert.equal(await shown(page, "#menu"), false);
  });

  test("the search palette opens over the menu", async () => {
    await page.keyboard.press("Tab");
    await page.keyboard.press("Control+KeyK");
    await until("the palette over the menu", () => page.evaluate(() => {
      const input = document.getElementById("palette-input");
      const box = input.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === input;
    }));
    await page.keyboard.press("Escape");
    // Esc right after opening doesn't close the menu.
    await sleep(300);
    await page.keyboard.press("Escape");
    await until("the menu to close", () => page.locator("#menu").isHidden());
  });

  test("a mod opens the menu at its page, and closes only the menu it opened", async () => {
    const key = await join("traveller");
    const content = `import type { ClientMod } from "../../api";
let menu: { close(): void } | undefined;
export default {
  init(ctx) {
    const go = Object.assign(document.createElement("button"), { id: "travel-go", textContent: "Go" });
    go.onclick = () => menu?.close();
    const here = Object.assign(document.createElement("button"), { id: "travel-here", textContent: "Here" });
    here.onclick = () => void (menu = ctx.openMenu("Travel"));
    ctx.menuTab("Travel").append(go, here);
    ctx.key("KeyM", "Travel", { down: () => void (menu = ctx.openMenu("Travel")) });
  },
} satisfies ClientMod;`;
    await tool(key, "write_file", { path: "mods/travel/client.ts", content });
    assert.match(await tool(key, "reload", { mod: "travel", announce: { title: "Travel", text: "Waystones" } }), /^travel v1 is live/);
    await until("the mod", () => page.locator("#travel-go").count());
    await page.keyboard.press("KeyM");
    await until("the Travel page", async () => (await page.locator("#travel-go").isVisible()) && (await page.textContent("#page-title")) === "Travel");
    await page.click("#travel-go");
    await until("the menu to close", () => page.locator("#menu").isHidden());
    await page.keyboard.press("Tab");
    await page.click("#rail [data-tab] >> text=Travel");
    await page.click("#travel-go");
    await page.click("#travel-here");
    await page.click("#travel-go");
    await sleep(500);
    assert.ok(await page.locator("#menu").isVisible(), "the menu the player opened stays open");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await until("the menu to close", () => page.locator("#menu").isHidden());
  });

  test("a mod may remove the vote bar and the chat, hide everything and cover the screen, but Tab still opens the menu and its votes", async () => {
    const key = await join("blackout");
    const content = `import type { ClientCtx, ClientMod } from "../../api";
function blackout(ctx: ClientCtx) {
  document.getElementById("react")!.remove();
  document.getElementById("chat")!.remove();
  document.head.append(Object.assign(document.createElement("style"), { textContent: "* { display: none !important; }" }));
  const block = ctx.menuTab("Blackout");
  for (const root of [block.getRootNode(), block.assignedSlot?.getRootNode(), block.parentElement?.shadowRoot]) (root as ParentNode | undefined)?.querySelector("#menu")?.remove();
  addEventListener("keydown", (e) => e.stopImmediatePropagation(), true);
  const ui = document.getElementById("ui")!;
  ui.inert = true;
  ui.remove();
  document.body.inert = true;
  // Over everything: the highest z-index, then the top layer and a modal dialog a while after the menu opens.
  const cover = <T extends HTMLElement>(el: T) => {
    el.style.cssText = "position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; z-index: 2147483647; background: rgba(0,0,0,.01)";
    el.style.setProperty("display", "block", "important");
    document.body.append(el);
    return el;
  };
  cover(document.createElement("div"));
  const layer = cover(Object.assign(document.createElement("div"), { popover: "manual" }));
  const dialog = cover(document.createElement("dialog"));
  new MutationObserver(() => document.body.classList.contains("menu-open") && !(window as any).covered && setTimeout(() => {
    layer.showPopover();
    dialog.showModal();
    (window as any).covered = true;
  }, 2000)).observe(document.body, { attributes: true });
}
export default { init(ctx) { if (ctx.playerId === "closed") setTimeout(() => blackout(ctx), 500); } } satisfies ClientMod;`;
    // This player's menu stays closed, as it is for everyone; the test keeps its own handle to look inside.
    const closed = await browser.newPage();
    await closed.addInitScript(() => {
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) {
        const root = attach.call(this, init);
        if (this.id === "ui") window.uiForTest = root;
        return root;
      };
    });
    // A second player online, so one vote to undo doesn't revert the mod.
    const witness = await guest(other.url, other.invite, "witness");
    const closedKey = await join("closed");
    await closed.goto(`${other.url}/#key=${closedKey}`);
    await closed.click("#howto-play");
    await tool(key, "write_file", { path: "mods/blackout/client.ts", content });
    assert.match(await tool(key, "reload", { mod: "blackout", announce: { title: "Blackout", text: "Lights out" } }), /^blackout v1 is live/);
    const removed = () => closed.evaluate(() => !document.getElementById("react") && !document.getElementById("chat"));
    await until("the mod's attack", removed);
    await sleep(1000);
    // The middle of a control in the menu (in a mod's row of votes), if it shows there on top of everything.
    const onTop = (sel, row) => closed.evaluate(([sel, row]) => {
      const root = window.uiForTest;
      const el = row ? [...root.querySelectorAll("#menu-mods li")].find((li) => li.querySelector("b")?.textContent.startsWith(row))?.querySelector(sel) : root.querySelector(sel);
      const box = el?.getBoundingClientRect();
      const x = box && box.x + box.width / 2, y = box && box.y + box.height / 2;
      return !!box && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.contains(window.uiForTest.elementFromPoint(x, y)) && { x, y };
    }, [sel, row]);
    await closed.keyboard.press("Tab");
    const mods = await until("the menu", () => onTop("[data-tab=mods]"));
    assert.ok(!(await closed.evaluate(() => window.covered)), "the menu is over the highest z-index before the mod uses the top layer");
    await closed.mouse.click(mods.x, mods.y);
    await until("the votes page", () => onTop("#menu-mods"));
    await until("the mod's cover in the top layer", () => closed.evaluate(() => window.covered));
    await sleep(200);
    const love = await until("blackout's vote", () => onTop("[data-kind=love]", "blackout"));
    const votes = async () => (await (await fetch(`${other.url}/api/status`, { headers: { authorization: `Bearer ${closedKey}` } })).json()).mods.find((m) => m.name === "blackout");
    await closed.mouse.click(love.x, love.y);
    await until("the love vote", async () => (await votes()).love === 1);
    await closed.keyboard.press("ArrowDown");
    await closed.keyboard.press("Enter");
    await until("the undo vote by keyboard", async () => { const v = await votes(); return v.undo === 1 && v.love === 0; });
    assert.ok(await removed());
    await closePage(closed);
    witness.close();
  });

  test("screenshot: the tab the player came back to last answers, a background or stalled tab still answers, and an offline player gets a plain next step", async () => {
    const key = await join("shooter");
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    await context.addInitScript(OPEN_UI);
    const answered = [];
    const open = async (tab) => {
      const p = await context.newPage();
      p.on("websocket", (ws) => ws.on("framesent", ({ payload }) => String(payload).startsWith('{"t":"shot"') && answered.push(tab)));
      await p.goto(`${other.url}/#key=${key}`);
      await p.locator("#howto-play:not([disabled])").waitFor();
      return p;
    };
    const shot = async () => {
      const before = answered.length;
      const res = await fetch(`${other.url}/cli/screenshot`, { method: "POST", headers: { authorization: `Bearer ${key}` } });
      const body = Buffer.from(await res.arrayBuffer());
      // Playwright reports the tab's frame after the server has already answered.
      if (res.ok) await until("the answering tab", async () => answered.length > before);
      const sof = body.findIndex((b, i) => b === 0xff && (body[i + 1] === 0xc0 || body[i + 1] === 0xc2));
      return { status: res.status, type: res.headers.get("content-type"), width: sof > 0 ? body.readUInt16BE(sof + 7) : 0, text: body.toString(), by: res.ok ? answered.at(-1) : null };
    };
    const first = await open("first");
    let result = await shot();
    assert.equal(result.type, "image/jpeg");
    assert.deepEqual([result.width, result.by], [1280, "first"]);
    const second = await open("second");
    await until("the first tab to hand over", async () => (await first.textContent("#status")).includes("another tab"));
    assert.equal((await shot()).by, "second");
    await first.bringToFront();
    await first.evaluate(() => dispatchEvent(new Event("focus")));
    await until("the first tab to take over", async () => (await second.textContent("#status")).includes("another tab"));
    await until("the first tab back in", () => first.locator("#status").isHidden());
    assert.equal((await shot()).by, "first");

    // A covered or busy tab gets no animation frames, so it answers inside the server's 10 s with the scene alone; a background one also reports itself hidden.
    await first.evaluate(() => (window.requestAnimationFrame = () => 0));
    result = await shot();
    assert.deepEqual([result.status, result.by], [200, "first"]);
    await first.evaluate(() => Object.defineProperty(document, "hidden", { get: () => true }));
    result = await shot();
    assert.deepEqual([result.status, result.width, result.by], [200, 1280, "first"]);
    await context.close();
    await until("the player gone", async () => (await shot()).status === 422);
    assert.match((await shot()).text, /^shooter doesn't have the game open.*query_world and logs/);
  });

  test("a solid entity nothing draws shows as an orange wireframe named after its mod, and query_world counts it", async () => {
    const key = await join("mason");
    const content = `import type { ServerMod } from "../../api";
export default {
  load(world) {
    for (const [id] of world.query("wallTest")) world.remove(id);
    world.spawn({ wallTest: true, pos: [3, 1, 3], solid: { size: [2, 2, 0.4] } });
    world.spawn({ wallTest: true, pos: [6, 1, 3], solid: true, mesh: { opacity: 0 } });
  },
} satisfies ServerMod;`;
    await tool(key, "write_file", { path: "mods/masonry/server.ts", content });
    assert.match(await tool(key, "reload", { mod: "masonry" }), /^masonry v1 is live/);
    await until("the wall counted in the browser's game", async () => (await tool(key, "query_world", { components: ["wallTest"] })).includes(`solidWithoutModel: {"count":1,"byMod":{"masonry":1}}`));
    assert.match(await tool(key, "query_world", { components: ["wallTest"] }), /\(2 matching entities\)/);
  });

  test("joining draws the world before mods start and between slow ones, counts them in on Play, and names a slow one in the feed", async () => {
    const key = await join("slow");
    for (const mod of ["slowpoke", "sluggard"]) {
      const content = `import type { ClientMod } from "../../api";
export default { init() { const until = performance.now() + 600; while (performance.now() < until); (window as any).slow = ((window as any).slow ?? 0) + 1; } } satisfies ClientMod;`;
      await tool(key, "write_file", { path: `mods/${mod}/client.ts`, content });
      assert.match(await tool(key, "reload", { mod }), new RegExp(`^${mod} v1 is live`));
    }
    const late = await browser.newPage();
    await late.addInitScript(() => {
      const seen = (window.seen = []);
      const raf = requestAnimationFrame;
      window.requestAnimationFrame = (fn) => raf((t) => (seen.at(-1) !== "frame" && seen.push("frame"), fn(t)));
      new MutationObserver(() => {
        const text = document.getElementById("howto-play")?.textContent;
        if (!text?.startsWith("Starting") || text === window.lastCount) return;
        window.lastCount = text;
        seen.push(window.slow > (window.counted ?? 0) ? `${text} (slow)` : text);
        window.counted = window.slow;
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    await late.goto(`${other.url}/#key=${await join("late")}`);
    await late.locator("#howto-play:not([disabled])").waitFor();
    assert.equal(await late.textContent("#howto-play"), "Play");
    const seen = await late.evaluate(() => window.seen);
    const counts = seen.filter((s) => s !== "frame");
    assert.deepEqual(counts.map((s) => s.replace(" (slow)", "")), counts.map((_, i) => `Starting ${i + 1} of ${counts.length}`));
    assert.equal(seen[seen.indexOf(counts[0]) - 1], "frame", "a frame before the first mod starts");
    const [first, second] = counts.filter((s) => s.endsWith("(slow)")).map((s) => seen.indexOf(s));
    assert.ok(seen.slice(first, second).includes("frame"), "a frame between the slow mods");
    await until("the slow mods named in the feed", async () => /slowpoke took \d+\.\d s to start in late's game/.test(await late.textContent("#feed")));
    await closePage(late);
  });
});

describe("Continue", () => {
  let app, shell, state;
  before(async () => ({ app, shell, state } = await launch("continue", {}, "returner")));
  after(() => close(app));

  test("the title starts on Continue, which opens the world last played, hosted or joined and after a restart; a forgotten world takes it away", async () => {
    const title = () => shell.locator("#title .item:visible").allTextContents();
    const focused = () => shell.evaluate(() => document.activeElement.textContent);
    /** The game view just opened, not the one just left, which closes as it goes. */
    const opened = (left) => until("the world", async () => app.windows().find((w) => w !== left && /^https?:/.test(w.url())));
    await shell.click("text=Host world");
    let game = await gamePage(app);
    await game.click("#create-go");
    await playing(game);
    const world = await game.textContent("#world-name");
    await leave(app, shell);
    // The title comes back under the pointer, which moves the focus as it hovers; click rather than press Enter.
    await until("Continue on the hosted world", async () => (await title())[0] === "Continue");
    await shell.click("#go-last");
    game = await opened(game);
    await playing(game);
    assert.equal(await game.textContent("#world-name"), world);
    await leave(app, shell);

    await shell.click("text=Join world");
    await shell.fill("#join-link", `${other.url}/#invite=${other.invite}`);
    await shell.press("#join-link", "Enter");
    await playing(await opened(game));
    await until("Snow Race played last", async () => state().last === other.url);
    await leave(app, shell);
    await close(app);
    ({ app, shell, state } = await launch("continue", {}, "returner"));
    await until("Continue on the joined world", async () => (await focused()) === "Continue");
    assert.deepEqual(await title(), ["Continue", "Worlds", "Join world", "Host world", "Settings", "Quit"]);
    await shell.keyboard.press("Enter");
    game = await gamePage(app);
    await playing(game);
    assert.equal(await game.textContent("#world-name"), "Snow Race");
    assert.ok(game.url().startsWith(other.url));
    await leave(app, shell);

    await shell.click("text=Worlds");
    await until("Snow Race listed", async () => (await rows(shell)).some((r) => r.startsWith("Snow Race")));
    await shell.focus('#games .item:has-text("Snow Race")');
    await shell.keyboard.press("Delete");
    await shell.click("#forget-yes");
    await shell.keyboard.press("Escape");
    await until("the title without Continue", async () => (await title()).join() === "Worlds,Join world,Host world,Settings,Quit");
  });
});

describe("building with an agent", () => {
  // The agent is a stand-in on this computer's PATH, saying what it was started with and then waiting as an agent would.
  const home = join(dir, "builder-home");
  const said = join(home, "said");
  let app, shell, game;
  before(async () => {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "claude"), `#!/bin/sh\necho "$$" > '${said}'\necho "claude in $PWD"\nprintf '%s\\n' "$1" | cut -c1-40\nexec sleep 600\n`, { mode: 0o755 });
    ({ app, shell } = await launch("builder", { HOME: home, SHELL: "/bin/sh" }, "builder"));
    await shell.click("text=Join world");
    await shell.fill("#join-link", `${other.url}/#invite=${other.invite}`);
    await shell.press("#join-link", "Enter");
    game = await gamePage(app);
    await playing(game);
  });
  after(() => close(app));

  test("Build with asks first in the app's own dialog, then sets up the world's folder and runs the agent there beside the game with the prompt, and Stop ends it", async () => {
    await game.locator("#menu-button").dispatchEvent("click");
    await game.click("#rail [data-tab=claude]");
    assert.deepEqual(await game.locator(".item.agent.build").allTextContents(), ["Build with Claude Code", "Build with Codex"]);
    await answer(app, 1);
    await game.click("text=Build with Claude Code");
    const [question] = await until("the question", () => asked(app).then((a) => a.length && a));
    assert.deepEqual([question.message, question.buttons], ["Build with Claude Code?", ["Start", "Cancel"]]);
    assert.equal(await shown(game, "#menu"), true);
    assert.equal(app.windows().some((w) => w.url().endsWith("/agent.html")), false);

    await answer(app, 0);
    await game.click("text=Build with Claude Code");
    await until("the menu closed", async () => !(await shown(game, "#menu")));
    const pane = await until("the agent pane", async () => app.windows().find((w) => w.url().endsWith("/agent.html")));
    await until("the agent started in the world's folder with the prompt", async () => /claude in \S+\/Sandbox\/[a-z0-9-]+\s*We're playing/.test(await pane.textContent("#term")));
    assert.equal(await pane.textContent("#name"), "Claude Code");
    const pid = Number(readFileSync(said, "utf8"));
    await pane.click("#close");
    await until("the pane closed", async () => !app.windows().some((w) => w.url().endsWith("/agent.html")));
    assert.equal(app.windows().includes(game), true);
    assert.equal(await app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL()), game.url());
    await until("the agent stopped", async () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });
});

describe("the host closes the game", () => {
  let app, shell, game, state;
  before(async () => ({ app, shell, state } = await launch("closing", {}, "stayer")));
  after(() => close(app));

  test("players in it are told, not left reconnecting", async () => {
    await shell.click("text=Join world");
    await shell.fill("#join-link", `${other.url}/#invite=${other.invite}`);
    await shell.press("#join-link", "Enter");
    game = await gamePage(app);
    await playing(game);
    assert.match(await game.locator("#howto h1").evaluate((el) => getComputedStyle(el).fontFamily), /^"Archivo Expanded"/);
    const peek = await guest(other.url, other.invite, "peek");
    peek.close();
    await game.reload();
    await game.locator("#join").waitFor({ state: "hidden" });
    await sleep(3500);
    assert.doesNotMatch(await game.textContent("#feed"), /peek|stayer left/);
    otherLauncher.kill();
    await until("the message", async () => (await game.textContent("#status")) === "The host closed the world. You're back in when they open it.");
    const status = await game.locator("#status").boundingBox();
    for (const button of await game.locator("#top button:visible").all()) {
      const b = await button.boundingBox();
      assert.ok(status.y >= b.y + b.height || status.x >= b.x + b.width || b.x >= status.x + status.width, `the message covers ${await button.textContent()}`);
    }
    assert.equal(await game.isDisabled("#howto-play"), true);
    assert.equal(await shown(game, "#rules"), false);
  });

  test("when the host comes back with an updated game, players reload into it", async () => {
    const updated = join(dir, "updated");
    for (const f of ["engine", "package.json", "tsconfig.json"]) cpSync(join(ROOT, f), join(updated, f), { recursive: true });
    symlinkSync(join(ROOT, "node_modules"), join(updated, "node_modules"));
    appendFileSync(join(updated, "engine", "client", "main.ts"), '\nconsole.debug("updated");\n');
    await game.evaluate(() => (window.before = true));
    const launcher = bun(join(updated, "engine", "launcher.ts"), { PORT: String(OTHER), SANDBOX_DATA: join(dir, "other"), SANDBOX_RELAY: relayUrl, SANDBOX_NO_OPEN: "1" });
    try {
      await until("the reload", async () => !(await game.evaluate(() => window.before).catch(() => true)), 30000);
      await playing(game);
    } finally {
      launcher.kill();
      await until("the world gone", async () => !(await fetch(`${other.url}/api/info`)).ok);
    }
  });

  test("opening it again from Worlds waits for the host, keeps its name, and goes back in by itself once the host is back", async () => {
    await leave(app, shell);
    await shell.click("text=Worlds");
    await until("the world", async () => (await rows(shell)).some((r) => r.startsWith("Snow Race")));
    await shell.click("#games .item >> text=Snow Race");
    await shell.locator("#waiting").waitFor();
    assert.deepEqual([await shell.textContent("#waiting-title"), await shell.textContent("#waiting-text")], ["Snow Race", "Waiting for the host to open it"]);
    assert.equal(state().recents.find((r) => r.url === other.url).name, "Snow Race");
    otherLauncher = startOther();
    game = await until("the game back", async () => app.windows().find((w) => w.url().startsWith(other.url)), 30000);
    await playing(game);
    assert.equal(await game.textContent("#world-name"), "Snow Race");
    assert.equal(await shown(shell, "#waiting"), false);
  });

  test("Back stops waiting", async () => {
    await leave(app, shell);
    otherLauncher.kill();
    await until("the world gone", async () => !(await fetch(`${other.url}/api/info`)).ok);
    await shell.click("text=Worlds");
    await shell.click("#games .item >> text=Snow Race");
    await shell.locator("#waiting").waitFor();
    await shell.click("#waiting-back");
    otherLauncher = startOther();
    await until("the world back", async () => (await fetch(`${other.url}/api/info`)).ok, 20000);
    await sleep(3000);
    assert.equal(app.windows().some((w) => w.url().startsWith(other.url)), false);
    assert.equal(await menuShown(shell), true);
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

describe("usage stats", () => {
  /** Community as usage stats see it: it signs the computer up and keeps every batch, with who sent it. */
  const STATS = port();
  const batches = [];
  const stats = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/installs") return res.end(JSON.stringify({ id: "install00001", token: "install-token-1" }));
    if (req.method === "POST" && req.url === "/events") {
      batches.push({ auth: req.headers.authorization, raw: String(await body(req)) });
      res.statusCode = 204;
      return res.end();
    }
    res.statusCode = 404;
    res.end("{}");
  }).listen(STATS);
  const env = { SANDBOX_COMMUNITY: `http://127.0.0.1:${STATS}` };
  /** Everything the tests type, none of which may ever be sent. */
  const typed = [];
  const type = (page, sel, value) => (typed.push(value), page.fill(sel, value));
  const sent = (surface) => batches.flatMap((b) => JSON.parse(b.raw).events.map((e) => ({ ...e, app: JSON.parse(b.raw).app }))).filter((e) => e.surface === surface);
  /** Whether `steps` happened in this order, other events between them. */
  const inOrder = (events, steps) => {
    let at = 0;
    for (const e of events) if (at < steps.length && e.screen === steps[at][0] && e.action === steps[at][1]) at++;
    return at === steps.length || `stopped before ${JSON.stringify(steps[at])} in ${JSON.stringify(events.map((e) => [e.screen, e.action]))}`;
  };
  const quit = async (app, shell) => {
    await answer(app, 0);
    const closed = app.waitForEvent("close");
    await shell.click("#quit");
    await closed;
  };
  after(() => stats.close());

  test("a first launch through naming, Settings, Join and hosting a world lands as each screen, button and step, under the computer's install, and nothing typed", async () => {
    const { app, shell } = await launch("newcomer", env, null);
    await type(shell, "#name-first", "Newcomer7");
    await shell.click("#name-go");
    await until("the menu", () => menuShown(shell));
    await shell.click("text=Settings");
    await shell.keyboard.press("Escape");
    await shell.click("text=Join world");
    await type(shell, "#join-link", "http://127.0.0.1:1/#invite=SECRETINVITE42");
    await shell.press("#join-link", "Enter");
    await shell.locator("#waiting").waitFor();
    await shell.click("#waiting-back");
    await until("the menu", () => menuShown(shell));
    await shell.click("text=Host world");
    const game = await gamePage(app);
    await game.locator("#create").waitFor();
    await type(game, "#create-name", "Secret Valley");
    await type(game, "#create-password", "hunter22");
    await game.click("#create-start i:last-child");
    await game.click("#create-go");
    await game.waitForURL(/:\d+\/(#.*)?$/);
    await leave(app, shell);
    await until("the menu", () => menuShown(shell));
    await quit(app, shell);

    assert.equal(
      inOrder(sent("app"), [["name", "screen"], ["name", "name-go"], ["name", "named"], ["title", "screen"], ["title", "to-settings"], ["settings", "screen"], ["title", "to-join"], ["join", "screen"], ["join", "join"], ["waiting", "screen"], ["waiting", "waiting-back"], ["title", "go-new"]]),
      true,
    );
    assert.equal(inOrder(sent("menu"), [["create", "screen"], ["create", "create-start"], ["create", "create-go"], ["create", "hosted"]]), true);
    assert.deepEqual(sent("menu").find((e) => e.action === "create-start").props, { value: "hills" });
    assert.deepEqual(sent("app")[0].app, { version: VERSION, os: process.platform });
    assert.equal(sent("menu")[0].app.os, process.platform);
    assert.deepEqual([...new Set(batches.map((b) => b.auth))], ["Bearer install-token-1"]);
    assert.ok(batches.every((b) => JSON.parse(b.raw).events.length <= 50));
    for (const b of batches) for (const value of typed) assert.equal(b.raw.toLowerCase().includes(value.toLowerCase()), false, `${JSON.stringify(value)} was sent`);
  });

  test("with Share usage stats off, nothing more is sent", async () => {
    const { app, shell } = await launch("newcomer", env);
    await shell.click("text=Settings");
    await until("the setting", async () => (await shell.textContent("#share-usage output")) === "On");
    await shell.click("#share-usage i:last-child");
    assert.equal(await shell.textContent("#share-usage output"), "Off");
    const before = batches.length;
    await shell.keyboard.press("Escape");
    await shell.click("text=Worlds");
    await shell.keyboard.press("Escape");
    await shell.click("text=Join world");
    await shell.keyboard.press("Escape");
    await quit(app, shell);
    await sleep(1000);
    const after = batches.slice(before).flatMap((b) => JSON.parse(b.raw).events);
    assert.deepEqual(after.filter((e) => ["saved", "join"].includes(e.screen) || e.action === "share-usage"), []);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "newcomer", "Sandbox", "data", "usage.json"), "utf8")), { share: false });
  });
});

describe("playtest", () => {
  /** Screenshots and frame times go where CI uploads them from. */
  const out = process.env.SANDBOX_CAPTURES ?? join(dir, "captures");
  let app, shell, state, base, key, game;
  before(async () => {
    mkdirSync(out, { recursive: true });
    ({ app, shell, state } = await launch("playtest"));
    await shell.click("text=Host world");
    game = await gamePage(app);
    await game.locator("#create-go").waitFor();
    await game.keyboard.press("Enter");
    await game.waitForURL(/:\d+\/(#.*)?$/);
    await playing(game);
    base = `http://127.0.0.1:${state().port}`;
    key = await game.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith("sandbox-key:"))[1]);
  });
  after(async () => {
    await close(app);
    const worlds = join(dir, "playtest", "Sandbox", "data", "worlds");
    for (const world of existsSync(worlds) ? readdirSync(worlds) : []) if (existsSync(join(worlds, world, "playtest.log"))) cpSync(join(worlds, world, "playtest.log"), join(out, "playtest.log"));
    cpSync(join(dir, "playtest", "Sandbox", "server.log"), join(out, "server.log"));
  });

  const call = async (name, args = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(args)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
    const res = await fetch(`${base}/cli/${name}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
    return res.headers.get("content-type") === "image/jpeg" ? { status: res.status, image: Buffer.from(await res.arrayBuffer()) } : { status: res.status, text: (await res.text()).split("\n\nWhen you are done")[0] };
  };
  /** The playtest pauses itself whenever the host's own game slows down, which a busy CI machine does; the agent then simply tries again. */
  const pauses = [];
  const retried = async (name, args) => {
    for (const end = Date.now() + 120000; ; await sleep(1000)) {
      const res = await call(name, args);
      if (!(res.status === 422 && res.text.startsWith("paused:")) || Date.now() > end) return res;
      pauses.push({ name, at: Date.now() });
    }
  };
  /** The host's own game, as its perf reports every 2 s say. */
  const frames = async (seconds) => {
    const seen = [];
    for (const end = Date.now() + seconds * 1000; Date.now() < end; await sleep(1000)) {
      const p = JSON.parse((await call("perf")).text.split("\n\n")[0]).players.host;
      if (p && !seen.some((s) => s.fps === p.fps && s.p95FrameMs === p.p95FrameMs && s.slowestFrameMs === p.slowestFrameMs)) seen.push({ fps: p.fps, p95FrameMs: p.p95FrameMs, slowestFrameMs: p.slowestFrameMs });
    }
    const sorted = (k) => seen.map((s) => s[k]).sort((a, b) => a - b);
    return { reports: seen.length, fpsMedian: sorted("fps")[seen.length >> 1], p95FrameMsMedian: sorted("p95FrameMs")[seen.length >> 1], p95FrameMsWorst: sorted("p95FrameMs").at(-1) };
  };
  /** The playtest's own processes: the live world starts its copy of the world and its hidden game each leading a process group. Chromium rewrites its environment block, so the hidden game is found by its parent. */
  const playtestProcesses = () => {
    const read = (pid, file) => {
      try {
        return readFileSync(`/proc/${pid}/${file}`, "utf8");
      } catch {
        return "";
      }
    };
    const procs = readdirSync("/proc").filter((p) => /^\d+$/.test(p)).map((pid) => {
      const f = read(pid, "stat").split(") ")[1]?.split(" ") ?? [];
      return { pid, state: f[0], parent: f[1], group: f[2], env: read(pid, "environ") };
    });
    const worlds = new Set(procs.filter((p) => p.env.includes("SANDBOX_PLAYTEST_APP=") && p.env.includes(`${join(dir, "playtest")}`)).map((p) => p.pid));
    const groups = new Set(procs.filter((p) => worlds.has(p.parent) && p.group === p.pid).map((p) => p.pid));
    return procs.filter((p) => groups.has(p.group));
  };
  /** Every window the X server shows, and the one with the keyboard. */
  const screen = async () => {
    const run = (...args) => new Promise((resolve) => execFile("xdotool", args, (_e, stdout) => resolve(stdout.trim())));
    return { visible: (await run("search", "--onlyvisible", "--name", "")).split("\n").sort(), focus: await run("getwindowfocus"), appFocused: await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().some((w) => w.isFocused())) };
  };

  test("an agent plays a hidden copy: w moves its view in the screenshot, with no new window and the player's window keeping focus", async () => {
    const without = await frames(20);
    const before = await screen();
    const started = await retried("playtest");
    assert.equal(started.status, 200, started.text);
    assert.match(started.text, /^Started a playtest: a hidden copy of the world as it is now, with you in it as host\./);
    assert.ok(playtestProcesses().length >= 2);
    const first = await retried("screenshot");
    assert.equal(first.status, 200, first.text);
    const moved = await retried("play", { keys: "w", ms: 1000 });
    assert.match(moved.text, /^In the playtest you held w for 1000 ms\. You moved from \(.+\) to \(.+\)\./);
    const turned = await retried("play", { look: "400,200", ms: 300 });
    assert.equal(turned.status, 200, turned.text);
    const second = await retried("screenshot");
    writeFileSync(join(out, "playtest-before.jpg"), first.image);
    writeFileSync(join(out, "playtest-after.jpg"), second.image);
    // Share of pixels that changed clearly: turning and tilting the camera moves the horizon and the ground; without a look it stays under 1%.
    const changed = await app.evaluate(({ nativeImage }, [a, b]) => {
      const [x, y] = [a, b].map((s) => nativeImage.createFromBuffer(Buffer.from(s, "base64")).toBitmap());
            let n = 0;
      let total = 0;
      for (let i = 0; i < x.length; i += 4, total++) if (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]) > 60) n++;
      return n / total;
    }, [first.image.toString("base64"), second.image.toString("base64")]);
    const withPlaytest = await frames(20);
    const after = await screen();
    writeFileSync(join(out, "frametime.json"), JSON.stringify({ without, withPlaytest, pauses, screen: { before, after }, moved: moved.text, turned: turned.text, changed }, null, 2));
    assert.deepEqual(after, before);
    assert.ok(changed > 0.05, `only ${changed} of the view changed`);
    assert.equal((await call("playtest", { action: "stop" })).text, "The playtest stopped and its copy of the world is gone.");
    await until("the playtest's processes gone", async () => !playtestProcesses().length, 10000);
  });

  test("the player's game slowing down pauses the playtest, and it resumes once their game is smooth again", async () => {
    assert.equal((await retried("playtest")).status, 200);
    // Every frame of the player's own game takes 400 ms more, until the test lets go.
    await game.evaluate(() => {
      window.hog = true;
      const frame = () => {
        if (!window.hog) return;
        for (const until = performance.now() + 400; performance.now() < until; );
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    const seen = [];
    const paused = await until("the playtest to pause", async () => {
      const res = await call("play", { ms: 10 });
      const host = JSON.parse((await call("perf")).text.split("\n\n")[0]).players.host;
      seen.push({ status: res.status, text: res.text.slice(0, 60), fps: host?.fps, secondsOld: host?.secondsOld, at: Date.now() });
      writeFileSync(join(out, "guard.json"), JSON.stringify(seen, null, 2));
      return res.text.startsWith("paused:") && res.text;
    }, 90000);
    assert.match(paused, /^paused: your player's game needs the computer\./);
    const stopped = playtestProcesses().map((p) => p.state);
    await game.evaluate(() => (window.hog = false));
    const resumed = await until("the playtest to resume", async () => {
      const res = await call("play", { ms: 10 });
      const host = JSON.parse((await call("perf")).text.split("\n\n")[0]).players.host;
      seen.push({ status: res.status, text: res.text.slice(0, 60), fps: host?.fps, secondsOld: host?.secondsOld, resuming: true });
      writeFileSync(join(out, "guard.json"), JSON.stringify(seen, null, 2));
      return res.status === 200;
    }, 120000);
    const log = JSON.parse(readFileSync(join(out, "frametime.json"), "utf8"));
    writeFileSync(join(out, "frametime.json"), JSON.stringify({ ...log, guard: { stoppedStates: stopped, resumed: !!resumed } }, null, 2));
    assert.ok(stopped.length >= 2 && stopped.every((s) => s === "T"), JSON.stringify(stopped));
  });

  test("quitting the app ends a running playtest", async () => {
    assert.ok(playtestProcesses().length >= 2);
    await close(app);
    app = null;
    await until("the playtest's processes gone", async () => !playtestProcesses().length, 15000);
  });
});

describe("world list", () => {
  let app, shell, state, own, hostKey, hosted;
  before(async () => ({ app, shell, state } = await launch("lister", {}, "lister")));
  after(() => close(app));
  const worldsDir = () => join(dir, "lister", "Sandbox", "data", "worlds");
  const coversDir = () => join(dir, "lister", "Sandbox", "covers");
  const hostState = () => menu(`http://127.0.0.1:${own}`, hostKey, "state");
  const picturesNow = async () => (await shell.evaluate(() => dispatchEvent(new Event("focus"))), pictures(shell.locator("#games")));
  const renaming = () => shell.locator("#games .renaming input");

  test("a world played 25 seconds keeps a picture of its 3D view, and every world in Worlds shows its own, joined ones from this computer", async () => {
    await shell.click("text=Host world");
    const game = await gamePage(app);
    await game.click("#create-go");
    await playing(game);
    own = state().port;
    hostKey = JSON.parse(readFileSync(join(dir, "lister", "Sandbox", "data", "launcher.json"), "utf8")).hostKey;
    hosted = (await hostState()).running;
    const cover = join(worldsDir(), hosted.id, "cover.jpg");
    assert.equal(existsSync(cover), false);
    // The first picture comes while playing, about 20 s in, not only on leaving.
    await until("the picture taken while playing", async () => existsSync(cover), 40000);
    assert.deepEqual([...readFileSync(cover).subarray(0, 2)], [0xff, 0xd8]);
    await capture(game, "worldlist-playing");
    await leave(app, shell);

    await shell.click("text=Join world");
    await shell.fill("#join-link", `${other.url}/#invite=${other.invite}`);
    await shell.press("#join-link", "Enter");
    await playing(await gamePage(app));
    await leave(app, shell);
    await until("the joined world's picture on this computer", async () => existsSync(coversDir()) && readdirSync(coversDir()).length === 1);

    await shell.click("text=Worlds");
    await until("both worlds", async () => (await rows(shell)).length === 2);
    assert.deepEqual(await until("both pictures", async () => ((await picturesNow()).every((w) => w === 480) ? picturesNow() : null)), [480, 480]);
    await capture(shell, "worldlist-worlds");
  });

  test("F2 renames a hosted world and a joined one in place: Enter keeps a name, Esc and an empty name don't, and the world keeps its id, invite and players", async () => {
    const hostedRow = `#games .item[data-key="local:${hosted.id}"]`;
    const joinedRow = `#games .item[data-key="${other.url}"]`;
    const name = (sel) => shell.locator(`${sel} .what`).textContent();
    const before = await name(hostedRow);

    await shell.focus(hostedRow);
    await shell.keyboard.press("F2");
    assert.equal(await renaming().inputValue(), before);
    await renaming().fill("");
    await renaming().press("Enter");
    assert.equal(await renaming().isVisible(), true);
    await renaming().fill("Lava Keep");
    await capture(shell, "worldlist-renaming");
    await renaming().press("Escape");
    assert.equal(await renaming().count(), 0);
    assert.equal(await name(hostedRow), before);
    assert.equal(await shell.locator("#games").isVisible(), true);

    await shell.keyboard.press("F2");
    await renaming().fill("Lava Keep");
    await renaming().press("Enter");
    await until("the new name", async () => (await name(hostedRow)) === "Lava Keep");
    assert.equal(await shell.evaluate(() => document.activeElement.dataset.key), `local:${hosted.id}`);
    const after = await hostState();
    assert.deepEqual([after.running.id, after.running.invite, after.running.link], [hosted.id, hosted.invite, hosted.link]);
    assert.equal(JSON.parse(readFileSync(join(worldsDir(), hosted.id, "config.json"), "utf8")).name, "Lava Keep");
    const friend = await guest(`http://127.0.0.1:${own}`, hosted.invite, "friend");
    friend.close();

    await shell.focus(joinedRow);
    await shell.keyboard.press("F2");
    await renaming().fill("Ana's race");
    await renaming().press("Enter");
    await until("the joined world's new name", async () => (await name(joinedRow)) === "Ana's race");
    assert.equal(state().labels[other.url], "Ana's race");
    assert.ok((await menu(other.base, other.key, "state")).worlds.some((w) => w.name === "Snow Race"));
    assert.deepEqual(await picturesNow(), [480, 480]);
    await capture(shell, "worldlist-renamed");

    await shell.click(hostedRow);
    const game = await gamePage(app);
    await playing(game);
    assert.equal(await game.textContent("#world-name"), "Lava Keep");
    await leave(app, shell);
  });
});
