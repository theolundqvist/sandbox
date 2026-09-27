// The real Electron app on a throwaway relay and launcher and a stand-in GitHub; run with `xvfb-run -a node --test desktop/app.test.mjs`.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** A small real JPEG, standing in for a world's picture. */
const COVER = Buffer.from("/9j/4AAQSkZJRgABAgAAAQABAAD//gARTGF2YzU4LjEzNC4xMDAA/9sAQwAIFBQXFBcbGxsbGxsgHiAhISEgICAgISEhJCQkKioqJCQkISEkJCgoKiouLy4rKyorLy8yMjI8PDk5RkZIVlZn/8QASwABAQAAAAAAAAAAAAAAAAAAAAUBAQAAAAAAAAAAAAAAAAAAAAUQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAIABADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCGAIGP/9k=", "base64");

/** A world published to GitHub, as the tarball GitHub serves: its files inside one folder named after the repo. */
function publishedWorld() {
  const root = join(dir, "published", "maker-tiny-isle-abc1234");
  mkdirSync(join(root, "mods/isle"), { recursive: true });
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "world.json"), JSON.stringify({ name: "Tiny Isle", description: "One small island.", author: "maker", engine: "test", start: "blank", rules: "open" }));
  writeFileSync(join(root, "mods/isle/server.ts"), `export default { load() {} };`);
  writeFileSync(join(root, "cover.jpg"), COVER);
  writeFileSync(join(root, "state/entities.json"), JSON.stringify({ nextId: 2, entities: { 1: { pos: [0, 0, 0], mesh: { shape: "box", size: [4, 1, 4], color: "#c9b27c" } } } }));
  execFileSync("tar", ["czf", join(dir, "published", "tiny-isle.tgz"), "-C", join(dir, "published"), "maker-tiny-isle-abc1234"]);
  return readFileSync(join(dir, "published", "tiny-isle.tgz"));
}
const tinyIsle = publishedWorld();

/** GitHub as the app sees it: the latest release, the installer script the app runs to update, the worlds in Browse and their tarballs; and ElevenLabs, which knows one key. */
const releases = { latest: VERSION, installer: null };
const RELEASES = port();
const github = createServer((req, res) => {
  if (req.url === "/worlds.json") return res.end(JSON.stringify([{ repo: "maker/tiny-isle", name: "Tiny Isle", description: "One small island." }, { repo: "maker/bare-rock", name: "Bare Rock", description: "No picture yet." }]));
  if (req.url === "/raw/maker/tiny-isle/HEAD/cover.jpg") return res.end(COVER);
  if (/^\/codeload\/(maker|stranger)\/tiny-isle\/tar\.gz\/HEAD$/.test(req.url)) return res.end(tinyIsle);
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
    env: { ...ownEnv, SANDBOX_STT: `http://127.0.0.1:${RELEASES}`, XDG_CONFIG_HOME: join(dir, name), SANDBOX_RELAY: relayUrl, SANDBOX_UPDATES: `http://127.0.0.1:${RELEASES}/latest`, SANDBOX_INSTALLER: `http://127.0.0.1:${RELEASES}/install`, SANDBOX_UPDATE_EVERY: "500", SANDBOX_MARKET: `http://127.0.0.1:${RELEASES}/worlds.json`, SANDBOX_RAW: `http://127.0.0.1:${RELEASES}/raw`, SANDBOX_CODELOAD: `http://127.0.0.1:${RELEASES}/codeload`, ...env },
  });
  await app.context().addInitScript(OPEN_UI);
  const shell = await until("the start screen", async () => app.windows().find((w) => w.url().startsWith("sandbox://app/shell.html")));
  await shell.locator(player ? "#title" : "#name").waitFor();
  return { app, shell, state: () => (existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) : {}) };
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
const playing = (page) => until("the game", () => page.locator("#hud").evaluate((hud) => !hud.hidden));

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

  test("Join world fills in a copied invite link or code, and nothing else", async () => {
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
    await shell.click("text=Join world");
    await shell.fill("#join-link", "AAAAAA");
    await shell.press("#join-link", "Enter");
    await until("the error", async () => (await shell.textContent("#error")) === "No world with that code");
    await shell.keyboard.press("Escape");
  });

  test("Host world opens this computer's main menu through the relay, never Waiting for the host", async () => {
    await shell.click("text=Host world");
    const game = await gamePage(app);
    await game.locator("#create").waitFor();
    assert.equal(await shown(game, "#waiting"), false);
    assert.match(game.url(), new RegExp(`^${relayUrl}/r/[a-z0-9-]+/menu`));
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
    await game.click("#create-go");
    await game.waitForURL(/\/r\/[a-z0-9-]+\/(#.*)?$/);
    await playing(game);
    assert.notEqual(await game.textContent("#world-name"), "Sandbox");
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

  test("connecting an agent: Copy copies the one prompt in place, and it installs this world's command first", async () => {
    const game = await gamePage(app);
    await game.locator("#menu-button").dispatchEvent("click");
    await game.click("#rail [data-tab=claude]");
    const copy = game.locator("[data-copy=claude-prompt]");
    const box = await copy.boundingBox();
    await copy.click();
    await until("Copied", async () => (await copy.textContent()) === "Copied");
    assert.deepEqual(await copy.boundingBox(), box);
    const prompt = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert.equal(prompt, await game.textContent("#claude-prompt"));
    assert.match(prompt, /^First install the command for our game by running `mkdir -p ~\/\.local\/bin && curl .*\/cli\?name=/);
    await game.keyboard.press("Escape");
    await game.keyboard.press("Escape");
  });

  test("leaving shows the hosted world, live, marked Hosted, with the host's view as its picture", async () => {
    await shell.click("#leave");
    await shell.click("text=Worlds");
    const [row] = await until("the hosted world", async () => (await rows(shell)).length && rows(shell));
    assert.match(row, /^.+ \| Live \| Hosted$/);
    assert.equal((await rows(shell)).length, 1);
    const shot = async () => (await shell.evaluate(() => dispatchEvent(new Event("focus"))), (await pictures(shell.locator("#games")))[0]);
    assert.equal(await until("the picture", shot), 960);
    await shell.keyboard.press("Escape");
  });

  test("a code joins through the relay; reload stays in the room; the world is saved under its relay address", async () => {
    await shell.click("text=Join world");
    await shell.fill("#join-link", `${other.code.slice(0, 3)}-${other.code.slice(3)}`);
    await shell.press("#join-link", "Enter");
    const game = await gamePage(app);
    const clips = [];
    game.on("request", (r) => r.url().includes("/clips/") && clips.push(r.url()));
    await playing(game);
    assert.equal(game.url(), `${other.url}/`);
    assert.equal(await game.textContent("#mic"), "Voice off: ask the host to turn it on");
    await game.reload();
    await game.locator("#join").waitFor({ state: "hidden" });
    assert.equal(await game.locator("#join").isHidden(), true);
    assert.match(game.url(), new RegExp(`^${other.url}/`));
    assert.deepEqual(clips, []);
    await until("the saved world", async () => state().recents.find((r) => r.url === other.url && r.name === "Snow Race"));
    await shell.click("#leave");
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
    await shell.click("#leave");
    const bare = await shell.evaluate(async () => (await import("/front.js")).joinLink("sandbox-relay.example.com/r/ab12cd/", "/relay"));
    assert.equal(bare, "https://sandbox-relay.example.com/r/ab12cd/");
  });

  test("too many wrong codes are refused for a minute", async () => {
    await shell.click("text=Join world");
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

  test("Browse plays a listed world after one download, and a pasted link to another asks for trust first", async () => {
    await shell.click("text=Worlds");
    await shell.click("#go-browse");
    const game = await gamePage(app);
    const listed = game.locator("#market .item");
    await until("the listed worlds", async () => (await listed.count()) === 2);
    assert.equal(await listed.first().textContent(), "Tiny IsleOne small island.Play");
    assert.equal(await listed.first().locator("img").getAttribute("src"), `http://127.0.0.1:${RELEASES}/raw/maker/tiny-isle/HEAD/cover.jpg`);
    assert.deepEqual(await until("the pictures", async () => (await pictures(game.locator("#market")))[0] && pictures(game.locator("#market"))), [16, null]);
    await game.fill("#repo-link", "https://github.com/stranger/tiny-isle");
    await game.press("#repo-link", "Enter");
    await until("the trust question", async () => (await game.textContent("#ask-note")) === "This world runs code from stranger. Only play worlds from people you trust.");
    await game.click("#ask-no");
    await listed.first().click();
    await until("Stop the hosted world?", async () => /^Stop .+\?$/.test(await game.textContent("#ask-title")));
    await game.click("#ask-yes");
    await playing(game);
    assert.equal(await game.textContent("#world-name"), "Tiny Isle");
    const worlds = join(dir, "host", "Sandbox", "data", "worlds");
    const isle = readdirSync(worlds).find((id) => id.startsWith("tiny-isle-"));
    assert.deepEqual(readFileSync(join(worlds, isle, "cover.jpg")), COVER);
    await shell.click("#leave");
    await until("the host's view of Tiny Isle", async () => readFileSync(join(worlds, isle, "cover.jpg")).length > COVER.length);
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
    await shell.click("#leave");
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
    await page.close();
    page = back;
    await page.goto(base);
    await playing(page);
    assert.equal(await shown(page, "#claude"), false);
    await page.locator("#menu-button").dispatchEvent("click");
    await page.click("#rail [data-tab=claude]");
    assert.equal(await page.textContent("#agents-off"), "The host turned agents off for this world.");
    assert.equal(await shown(page, "#claude-prompt"), false);
    const { id } = await (await fetch(`${base}/api/info`)).json();
    const key = await page.evaluate((id) => localStorage.getItem(`sandbox-key:${id}`), id);
    const res = await fetch(`${base}/cli/status`, { method: "POST", headers: { authorization: `Bearer ${key}` } });
    assert.deepEqual([res.status, await res.text()], [403, "The host turned agents off for this world.\n"]);
  });
});

describe("the relay down", () => {
  let app, shell;
  before(async () => ({ app, shell } = await launch("offline", { SANDBOX_RELAY: `http://127.0.0.1:${port()}` })));
  after(() => close(app));

  test("a code can't be looked up", async () => {
    await shell.click("text=Join world");
    await shell.fill("#join-link", "K7F-M2Q");
    await shell.press("#join-link", "Enter");
    await until("the error", async () => (await shell.textContent("#error")) === "Can't look up codes right now. Check your connection, or ask for the invite link.");
    await shell.keyboard.press("Escape");
  });

  test("Host world still opens the main menu, on this computer", async () => {
    await shell.click("text=Host world");
    const game = await gamePage(app);
    await game.locator("#create").waitFor();
    assert.match(game.url(), /^http:\/\/localhost:\d+\/menu/);
  });

  test("the host's invite is a Wi-Fi link, and the main menu says why", async () => {
    const game = await gamePage(app);
    await game.fill("#create-name", "Home World");
    await game.click("#create-go");
    await playing(game);
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
    assert.equal(readFileSync(`${marker}.release`, "utf8").trim(), "https://github.com/theolundqvist/sandbox/releases/download/v9.9.9");
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
    await shell.click("text=Host world");
    game = await gamePage(app);
    await game.fill("#create-name", "Update Test");
    await game.click("#create-go");
    await playing(game);
    const own = state().port;
    const key = JSON.parse(readFileSync(join(dir, "update", "Sandbox", "data", "launcher.json"), "utf8")).hostKey;
    const s = await menu(`http://127.0.0.1:${own}`, key, "state");
    code = s.tunnel.code;
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
    assert.match(game.url(), new RegExp(`^${relayUrl}/r/`));
  });

  test("a failed download says so and keeps the app and the game open", async () => {
    const own = state().port;
    releases.installer = null;
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
    const own = state().port;
    const pid = app.process().pid;
    await answer(app, 0);
    const closed = new Promise((r) => app.once("close", r));
    await game.locator("#menu-update").evaluate((b) => b.click());
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
    await closed.close();
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
    await late.close();
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

  test("opening it again from Worlds waits for the host, keeps its name, and goes back in by itself once the host is back", async () => {
    await shell.click("#leave");
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
    await shell.click("#leave");
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
