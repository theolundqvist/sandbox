// A throwaway launcher and relay over real HTTP: only someone at the launcher's own machine gets the host key.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
import { networkInterfaces, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Subprocess } from "bun";
import { openStore, seedStore } from "./world";

const dir = mkdtempSync(join(tmpdir(), "sandbox-launcher-"));
const LAUNCHER = 17000 + Math.floor(Math.random() * 1000);
const RELAY = LAUNCHER + 1000;
const procs: Subprocess[] = [];
/** This machine's own service keys never reach a test world, and its worlds share through the test relay, never the public one. */
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.endsWith("_API_KEY"))), SANDBOX_RELAY: `http://127.0.0.1:${RELAY}`, SANDBOX_COMMUNITY: "http://127.0.0.1:1" };

async function up(url: string) {
  for (let i = 0; i < 100; i++) {
    if (await fetch(url).then(() => true, () => false)) return;
    await Bun.sleep(100);
  }
  throw new Error(`${url} never came up`);
}

beforeAll(async () => {
  procs.push(Bun.spawn(["bun", join(import.meta.dir, "../relay/relay.ts")], { env: { ...env, PORT: String(RELAY), RELAY_CLAIMS: join(dir, "claims.json") }, stdout: "ignore" }));
  procs.push(
    Bun.spawn(["bun", join(import.meta.dir, "launcher.ts")], {
      env: { ...env, PORT: String(LAUNCHER), SANDBOX_DATA: join(dir, "data"), SANDBOX_NO_OPEN: "1" },
      stdout: "ignore",
    }),
  );
  await Promise.all([up(`http://127.0.0.1:${RELAY}/`), up(`http://127.0.0.1:${LAUNCHER}/menu`)]);
});

afterAll(async () => {
  for (const p of procs) p.kill();
  await Promise.allSettled(procs.map((p) => p.exited));
  // Windows keeps a file locked for a moment after the process holding it exits.
  rmSync(dir, { recursive: true, force: true, maxRetries: 20 });
});

const localKey = (base: string, headers: Record<string, string> = {}) => fetch(`${base}/api/local-key`, { headers });

test("loopback gets the host key, and the key opens the main menu", async () => {
  for (const host of ["127.0.0.1", "localhost"]) {
    const res = await localKey(`http://${host}:${LAUNCHER}`);
    expect(res.status).toBe(200);
    const { key } = await res.json();
    const menu = await fetch(`http://${host}:${LAUNCHER}/api/menu/state`, { headers: { authorization: `Bearer ${key}` } });
    expect(menu.status).toBe(200);
  }
});

test("loopback through a proxy, or under a foreign host name, is not the host", async () => {
  for (const headers of <Record<string, string>[]>[{ "cf-connecting-ip": "203.0.113.9" }, { "x-forwarded-for": "203.0.113.9" }, { forwarded: "for=203.0.113.9" }, { "x-sandbox-relayed": "1" }, { host: "evil.example" }])
    expect((await localKey(`http://127.0.0.1:${LAUNCHER}`, headers)).status).toBe(401);
});

test("a LAN address is not the host", async () => {
  const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
  expect(lan).toBeTruthy();
  expect((await localKey(`http://${lan}:${LAUNCHER}`)).status).toBe(401);
});

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>) {
  for (let i = 0; i < 150; i++, await Bun.sleep(100)) {
    const got = await check();
    if (got) return got;
  }
  throw new Error(`never saw ${what}`);
}

test("a player through the relay is not the host", async () => {
  const menu = await hostMenu();
  const { running } = await menu("create", { name: "Relay Test" });
  const url = running.link.split("/#")[0];
  expect(url).toStartWith(`http://127.0.0.1:${RELAY}/r/`);
  // The relay is reached on loopback here, exactly like a relay on the host's machine would be.
  await until("the menu through the relay", async () => (await fetch(`${url}/menu`)).status === 200);
  expect((await localKey(url!)).status).toBe(401);
  expect((await localKey(url!, { host: "localhost" })).status).toBe(401);
  await menu("stop", {});
});

test("a hosted world has one invite link, the same when hosted again, and a Wi-Fi link its players see while the relay is down", async () => {
  const menu = await hostMenu();
  const s = await menu("create", { name: "Link Test" });
  const { link, invite, wifiOnly } = s.running;
  expect(link).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${RELAY}/r/[a-z0-9]+/#invite=${invite}$`));
  expect(wifiOnly).toBe(false);
  await until("the game through the link", async () => (await fetch(link.split("#")[0])).status === 200);

  await menu("stop", {});
  const again = await menu("host", { id: s.running.id });
  expect(again.running.link).toBe(link);

  const { key } = await (await fetch(`http://127.0.0.1:${LAUNCHER}/api/join`, { method: "POST", body: JSON.stringify({ invite, name: "linker" }) })).json();
  const player = new WebSocket(`ws://127.0.0.1:${LAUNCHER}/ws?key=${key}`);
  const received: any[] = [];
  player.onmessage = ({ data }) => received.push(JSON.parse(String(data)));
  const welcome = await until("the welcome", async () => received.find((m) => m.t === "welcome"));
  expect([welcome.link, welcome.wifiOnly]).toEqual([link, false]);

  const relay = procs[0]!;
  relay.kill();
  await relay.exited;
  const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
  const wifi = `http://${lan}:${LAUNCHER}/#invite=${invite}`;
  expect(await until("a Wi-Fi-only invite", async () => (await menu("state")).running.wifiOnly && (await menu("state")).running.link)).toBe(wifi);
  expect(await until("players told", async () => received.find((m) => m.t === "public" && m.wifiOnly))).toMatchObject({ link: wifi });

  procs[0] = Bun.spawn(["bun", join(import.meta.dir, "../relay/relay.ts")], { env: { ...env, PORT: String(RELAY), RELAY_CLAIMS: join(dir, "claims.json") }, stdout: "ignore" });
  expect(await until("the relay link back", async () => !(await menu("state")).running.wifiOnly && (await menu("state")).running.link)).toBe(link);
  player.close();
  await menu("stop", {});
}, 30_000);

test("a world that asks for a password gets its invite only from the relay, for that password, and the choice stays with the world while only a hash is kept", async () => {
  const menu = await hostMenu();
  const s = await menu("create", { name: "Lock Test" });
  const { id, invite, link } = s.running;
  const room = link.match(/\/r\/([a-z0-9-]+)\//)[1];
  const unlock = (password: string) => fetch(`http://127.0.0.1:${RELAY}/_unlock`, { method: "POST", body: JSON.stringify({ room, password }) });
  await until("the relay link", async () => (await fetch(link.split("#")[0])).status === 200);
  expect(s.running.access).toBe(null);
  expect((await unlock("hunter22")).status).toBe(404);
  expect(await menu("access", { id, mode: "password" })).toMatchObject({ status: 400, error: "Pick a password." });
  const locked = await menu("access", { id, mode: "password", password: "hunter22" });
  expect([locked.running.access, locked.running.locked]).toEqual(["password", true]);
  expect(readFileSync(join(dir, "data", "access.json"), "utf8")).not.toContain("hunter22");
  expect((await unlock("wrong one")).status).toBe(403);
  expect(await (await unlock("hunter22")).json()).toEqual({ invite });

  // Hosted again, the world still asks; once open to friends, the relay holds nothing back.
  await menu("stop", {});
  await menu("host", { id });
  expect(await until("the lock again", async () => (await unlock("hunter22")).status === 200)).toBe(true);
  expect((await menu("access", { id, mode: "friends" })).running.access).toBe("friends");
  expect((await unlock("hunter22")).status).toBe(404);
  await menu("stop", {});
}, 30_000);

test("worlds made without a name each get their own", async () => {
  const { key } = await (await localKey(`http://127.0.0.1:${LAUNCHER}`)).json();
  const create = async () => (await fetch(`http://127.0.0.1:${LAUNCHER}/api/menu/create`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: "{}" })).json();
  await create();
  const { worlds } = await create();
  const unnamed = worlds.filter((w: { name: string }) => !["Relay Test", "Link Test", "Lock Test"].includes(w.name)).map((w: { name: string }) => w.name);
  expect(unnamed).toHaveLength(2);
  expect(new Set(unnamed).size).toBe(2);
  expect(unnamed).not.toContain("Sandbox");
});

test("a computer without git hosts worlds, reloads mods, and says history needs Git", async () => {
  // Only bun on the PATH: any git call would fail to spawn and stop the world.
  const bin = join(dir, "nogit-bin");
  mkdirSync(bin);
  // Windows links a file only without admin rights as a hard link.
  const bun = join(bin, basename(process.execPath));
  (process.platform === "win32" ? linkSync : symlinkSync)(process.execPath, bun);
  const port = LAUNCHER + 500;
  procs.push(Bun.spawn([bun, join(import.meta.dir, "launcher.ts")], { env: { PATH: bin, HOME: dir, SANDBOX_RELAY: env.SANDBOX_RELAY, SANDBOX_COMMUNITY: env.SANDBOX_COMMUNITY, PORT: String(port), SANDBOX_DATA: join(dir, "nogit"), SANDBOX_NO_OPEN: "1" }, stdout: "ignore", stderr: "ignore" }));
  await up(`http://127.0.0.1:${port}/menu`);
  const { key } = await (await localKey(`http://127.0.0.1:${port}`)).json();
  const s = await (await fetch(`http://127.0.0.1:${port}/api/menu/create`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ name: "No Git", start: "basics" }) })).json();
  expect(s.running?.name).toBe("No Git");
  const player = await (await fetch(`http://127.0.0.1:${port}/api/join`, { method: "POST", body: JSON.stringify({ invite: s.running.invite, name: "builder" }) })).json();
  const tool = (name: string, args: Record<string, string>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(args)) form.append(k, v);
    return fetch(`http://127.0.0.1:${port}/cli/${name}`, { method: "POST", headers: { authorization: `Bearer ${player.key}` }, body: form });
  };
  const reload = await tool("reload", { mod: "basics" });
  expect(reload.status).toBe(200);
  const history = await tool("history", { mod: "basics" });
  expect(history.status).toBe(422);
  expect(await history.text()).toStartWith("Needs Git");
}, 60_000);

/** Every speech-to-text provider on one server, each knowing one key and answering the way the real one does. */
function speechProviders(keys: Record<string, string>) {
  const checked: string[] = [];
  const said = (provider: string) => `build a bridge, heard by ${provider}`;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      const bearer = req.headers.get("authorization")?.replace(/^(Bearer|Token) /, "");
      const [provider, key, refused] = pathname.startsWith("/openai/v1/")
        ? ["Groq", bearer, 401]
        : pathname.startsWith("/v1beta/")
          ? ["Gemini", req.headers.get("x-goog-api-key"), 400]
          : pathname === "/v1/speech-to-text"
            ? ["ElevenLabs", req.headers.get("xi-api-key"), 400]
            : pathname.startsWith("/v1/listen")
              ? ["Deepgram", bearer, 401]
              : ["OpenAI", bearer, 401];
      const body = req.method === "POST" ? await req.blob() : null;
      const audio = provider === "Gemini" ? body?.size && JSON.parse(await body.text()).contents[0].parts[1].inline_data.data : body && provider !== "Deepgram" ? ((await new Response(body, { headers: { "content-type": req.headers.get("content-type")! } }).formData()).get("file") as Blob | null)?.size : body?.size;
      if (!audio) checked.push(provider);
      if (key !== keys[provider]) return Response.json({ detail: { type: "authentication_error" } }, { status: refused as number });
      if (!audio) return Response.json({ error: "no audio" }, { status: pathname.endsWith(":generateContent") || req.method === "POST" ? 400 : 200 });
      const text = said(provider as string);
      return Response.json(provider === "Gemini" ? { candidates: [{ content: { parts: [{ text }] } }] } : provider === "Deepgram" ? { results: { channels: [{ alternatives: [{ transcript: text }] }] } } : { text });
    },
  });
  return { server, checked, said };
}

test("the host pastes a speech key from any provider: recognised by its shape or by asking each in turn, kept private, live without a restart, and removable", async () => {
  const keys: Record<string, string> = {
    Groq: "gsk_test_groq_key",
    OpenAI: "sk-proj-test_openai_key",
    Gemini: "AIzaTest_gemini_key",
    ElevenLabs: "sk_test_elevenlabs_key",
    Deepgram: "0123456789abcdef0123456789abcdef01234567",
  };
  const stt = speechProviders(keys);
  const port = LAUNCHER + 600;
  const data = join(dir, "voice");
  // A key added before other providers existed was ElevenLabs'.
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "secrets.json"), JSON.stringify({ elevenlabs: { key: keys.ElevenLabs, host: `http://127.0.0.1:${stt.server.port}` } }), { mode: 0o600 });
  const launcher = Bun.spawn(["bun", join(import.meta.dir, "launcher.ts")], { env: { ...env, PORT: String(port), SANDBOX_DATA: data, SANDBOX_NO_OPEN: "1", SANDBOX_STT: `http://127.0.0.1:${stt.server.port}` }, stdout: "pipe", stderr: "pipe" });
  procs.push(launcher);
  const base = `http://127.0.0.1:${port}`;
  await up(`${base}/menu`);
  const { key } = await (await localKey(base)).json();
  const menu = (action: string, body: object) => fetch(`${base}/api/menu/${action}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const s = await (await menu("create", { name: "Voice Test", start: "blank" })).json();
  expect(s.voiceKey).toBe("ElevenLabs ••••_key");
  expect(s.voiceProviders.map((p: { name: string; free: boolean }) => p.name + (p.free ? " (free)" : ""))).toEqual(["Groq (free)", "OpenAI", "Gemini", "ElevenLabs", "Deepgram"]);
  const secrets = join(data, "secrets.json");
  expect(JSON.parse(readFileSync(secrets, "utf8"))).toEqual({ voice: { provider: "ElevenLabs", key: keys.ElevenLabs, host: `http://127.0.0.1:${stt.server.port}` } });

  const player = await (await fetch(`${base}/api/join`, { method: "POST", body: JSON.stringify({ invite: s.running.invite, name: "talker", host: s.running.hostKey }) })).json();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?key=${player.key}`);
  const got: any[] = [];
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  const next = async (t: string) => {
    for (let i = 0; i < 100; i++, await Bun.sleep(50)) {
      const at = got.findIndex((m) => m.t === t);
      if (at >= 0) return got.splice(at, 1)[0];
    }
    throw new Error(`no ${t}`);
  };
  expect(await next("welcome")).toMatchObject({ voice: true, host: "talker" });
  const speak = () => fetch(`${base}/api/voice`, { method: "POST", headers: { authorization: `Bearer ${player.key}` }, body: new Blob([new Uint8Array(2000)], { type: "audio/wav" }) });
  const status = async () => (await (await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${player.key}` } })).json()).voice;

  for (const [provider, pasted] of Object.entries(keys)) {
    stt.checked.length = 0;
    const added = await (await menu("voice", { key: ` ${pasted} ` })).json();
    expect(added.voiceKey).toBe(`${provider} ••••${pasted.slice(-4)}`);
    // A key's shape names its provider, so no other provider ever sees it.
    expect(stt.checked).toEqual([provider]);
    expect(await next("voice")).toEqual({ t: "voice", on: true });
    await speak();
    expect(await next("chat")).toMatchObject({ from: "talker", text: stt.said(provider), spoken: true });
  }
  expect(await status()).toStartWith("on");

  // A key shaped like no provider's is asked of each in turn.
  keys.Deepgram = "plain-key-no-provider-shape";
  stt.checked.length = 0;
  expect((await (await menu("voice", { key: keys.Deepgram })).json()).voiceKey).toBe("Deepgram ••••hape");
  expect(stt.checked).toEqual(["Groq", "OpenAI", "Gemini", "ElevenLabs", "Deepgram"]);
  expect(await next("voice")).toEqual({ t: "voice", on: true });

  expect(await (await menu("voice", { key: "gsk_not_it" })).json()).toEqual({ error: "Groq didn't accept that key. Copy it again from console.groq.com." });
  expect(await (await menu("voice", { key: "AIzaNotIt" })).json()).toEqual({ error: "Gemini didn't accept that key. Copy it again from aistudio.google.com." });
  expect(await (await menu("voice", { key: "not-anyones-key" })).json()).toEqual({ error: "Groq, OpenAI, Gemini, ElevenLabs, or Deepgram didn't accept that key. Copy all of it again." });

  if (process.platform !== "win32") expect(statSync(secrets).mode & 0o777).toBe(0o600);
  const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]));
  expect(files(join(data, "worlds")).filter((f) => Object.values(keys).some((k) => readFileSync(f).includes(k)))).toEqual([]);

  keys.Deepgram = "rotated";
  await speak();
  expect(await next("voice-failed")).toEqual({ t: "voice-failed", refused: true, provider: "Deepgram" });

  expect((await (await menu("voice", { key: "" })).json()).voiceKey).toBeNull();
  expect(await next("voice")).toEqual({ t: "voice", on: false });
  expect(await status()).toBe("off");
  ws.close();
  launcher.kill();
  stt.server.stop(true);
  const printed = (await new Response(launcher.stdout).text()) + (await new Response(launcher.stderr).text());
  for (const k of ["gsk_test_groq_key", "sk-proj-test_openai_key", "AIzaTest_gemini_key", "sk_test_elevenlabs_key", "plain-key-no-provider-shape"]) expect(printed).not.toContain(k);
}, 60_000);

// It finds the world's process in /proc.
test.skipIf(process.platform !== "linux")("a world that crashes is hosted again by itself, a Claude waiting on it is told to try again, its players' games reconnect and hear why, and the crash is in world.log", async () => {
  const port = LAUNCHER + 700;
  const data = join(dir, "crashy");
  const launcher = Bun.spawn(["bun", join(import.meta.dir, "launcher.ts")], { env: { ...env, PORT: String(port), SANDBOX_DATA: data, SANDBOX_NO_OPEN: "1" }, stdout: "ignore", stderr: "ignore" });
  procs.push(launcher);
  const base = `http://127.0.0.1:${port}`;
  await up(`${base}/menu`);
  const { key } = await (await localKey(base)).json();
  const s = await (await fetch(`${base}/api/menu/create`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ name: "Crashy", start: "basics" }) })).json();
  const player = await (await fetch(`${base}/api/join`, { method: "POST", body: JSON.stringify({ invite: s.running.invite, name: "stayer" }) })).json();
  const world = () => Number(readdirSync(`/proc/${launcher.pid}/task`).flatMap((t) => readFileSync(`/proc/${launcher.pid}/task/${t}/children`, "utf8").trim().split(" ")).find(Boolean));
  const first = world();
  const reload = new FormData();
  reload.append("mod", "basics");
  expect((await fetch(`${base}/cli/reload`, { method: "POST", headers: { authorization: `Bearer ${player.key}` }, body: reload })).status).toBe(200);
  // The world samples itself every 10 s.
  for (let i = 0; i < 150 && !count(join(data, "worlds", s.running.id, "record.sqlite"), "select count(*) n from events where kind = 'server'"); i++) await Bun.sleep(100);
  const form = new FormData();
  form.append("seconds", "30");
  const waiting = fetch(`${base}/cli/wait_for_chat`, { method: "POST", headers: { authorization: `Bearer ${player.key}` }, body: form });
  await Bun.sleep(500);
  process.kill(first, "SIGABRT");
  const dropped = await waiting;
  expect(dropped.status).toBe(502);
  expect(await dropped.text()).toBe("The game stopped before it answered. It starts again by itself: try again in a few seconds.\n");

  let welcome: any;
  for (let i = 0; i < 100 && !welcome; i++) {
    await Bun.sleep(200);
    welcome = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?key=${player.key}`);
      ws.onmessage = (e) => (resolve(JSON.parse(String(e.data))), ws.close());
      ws.onclose = ws.onerror = () => resolve(null);
    });
  }
  expect(welcome?.t).toBe("welcome");
  expect(welcome.feed.map((f: { text: string }) => f.text)).toContain("The world crashed and restarted by itself without the last change to basics. Anything from the last few seconds before the crash may be gone.");
  expect(world()).not.toBe(first);
  const log = readFileSync(join(data, "worlds", s.running.id, "world.log"), "utf8");
  expect(log.match(/Crashy is running/g)).toHaveLength(2);
  expect(log).toMatch(/\[launcher\] exited with SIGABRT after \d+ s\. Last sample \d+ s ago: \d+ MB RSS, \d+ MB heap\. Last reload \d+ s ago: basics by stayer, v\d+\.\n/);
  launcher.kill();
}, 60_000);
test("a world that crashes within a minute of a reload comes back without that reload, tells its Claude why, and no log holds the host key", async () => {
  const port = LAUNCHER + 750;
  const data = join(dir, "reverty");
  const launcher = Bun.spawn(["bun", join(import.meta.dir, "launcher.ts")], { env: { ...env, PORT: String(port), SANDBOX_DATA: data, SANDBOX_NO_OPEN: "1" }, stdout: "pipe", stderr: "pipe" });
  procs.push(launcher);
  const output = Promise.all([new Response(launcher.stdout).text(), new Response(launcher.stderr).text()]);
  const base = `http://127.0.0.1:${port}`;
  await up(`${base}/menu`);
  const { key } = await (await localKey(base)).json();
  const s = await (await fetch(`${base}/api/menu/create`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ name: "Reverty", start: "blank" }) })).json();
  const player = await (await fetch(`${base}/api/join`, { method: "POST", body: JSON.stringify({ invite: s.running.invite, name: "builder" }) })).json();
  const call = async (name: string, args: Record<string, string>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(args)) form.append(k, v);
    return (await fetch(`${base}/cli/${name}`, { method: "POST", headers: { authorization: `Bearer ${player.key}` }, body: form })).text();
  };
  const serverTs = join(data, "worlds", s.running.id, "world/mods/wobbly/server.ts");
  mkdirSync(join(serverTs, ".."), { recursive: true });
  writeFileSync(serverTs, `export default { tick() {} };`);
  expect(await call("reload", { mod: "wobbly" })).toStartWith("wobbly v1 is live");
  // A test run lasts 20 ticks, so only the live world is still running when this goes off.
  writeFileSync(serverTs, `export default { load() { setTimeout(() => process.kill(process.pid, "SIGKILL"), 2500); } };`);
  expect(await call("reload", { mod: "wobbly" })).toStartWith("wobbly v2 is live");

  let status: any;
  for (let i = 0; i < 100 && status?.mods?.[0]?.version !== 3; i++) {
    await Bun.sleep(200);
    status = await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${player.key}` } }).then((r) => (r.ok ? r.json() : null), () => null);
  }
  expect(status.mods).toMatchObject([{ name: "wobbly", version: 3 }]);
  expect(status.recent).toContain("The world crashed and restarted by itself without the last change to wobbly. Anything from the last few seconds before the crash may be gone.");
  expect(await call("logs", { mod: "wobbly" })).toContain("the world crashed within a minute of this reload, so it was undone.");
  await Bun.sleep(3000);
  expect((await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${player.key}` } })).ok).toBe(true);

  launcher.kill();
  const [stdout, stderr] = await output;
  const worldLog = readFileSync(join(data, "worlds", s.running.id, "world.log"), "utf8");
  for (const secret of [key, s.running.hostKey]) for (const text of [stdout, stderr, worldLog]) expect(text).not.toContain(secret);
  expect(stdout).toContain(`Main menu: http://localhost:${port}/menu`);
}, 60_000);
const hostMenu = async () => {
  const { key } = await (await localKey(`http://127.0.0.1:${LAUNCHER}`)).json();
  return async (action: string, body?: object | Uint8Array) => {
    const res = await fetch(`http://127.0.0.1:${LAUNCHER}/api/menu/${action}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${key}` }, body: body instanceof Uint8Array ? (body as Uint8Array<ArrayBuffer>) : body && JSON.stringify(body) });
    return action === "export" && res.ok ? res : { status: res.status, ...(await res.json()) };
  };
};
const joinAs = async (name: string, invite: string) => (await (await fetch(`http://127.0.0.1:${LAUNCHER}/api/join`, { method: "POST", body: JSON.stringify({ name, invite }) })).json()).key as string;
async function tool(key: string, name: string, args: Record<string, unknown> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(args)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
  const res = await fetch(`http://127.0.0.1:${LAUNCHER}/cli/${name}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name}: ${text}`);
  return text;
}
/** A tool's JSON result, without the chat appended after it. */
const answer = (text: string) => JSON.parse(text.split("\n\n")[0]!);
const worldDir = (id: string) => join(dir, "data/worlds", id);
const count = (path: string, sql: string) => {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
};

test("a world exported while it runs imports as a new world with its mods, history and state, and none of its secrets", async () => {
  const menu = await hostMenu();
  const created = await menu("create", { name: "Export Test", rules: "additive" });
  const { id, invite, hostKey } = created.running;
  const alice = await joinAs("alice", invite);
  const note = `import type { ServerMod } from "../../api";
export default {
  load(world) {
    if (!world.query("note").length) world.spawn({ note: "kept" });
    world.db.run("create table if not exists loads (at integer)");
    world.db.run("insert into loads values (?)", Date.now());
    const said = world.db.get("select text from said");
    if (said && !world.query("said").length) world.spawn({ said: said.text });
  },
} satisfies ServerMod;
`;
  // Players' text with the invite in it, everywhere a world keeps it: a mod's table and an entity, the record through a tool call, chat in the timelapse.
  mkdirSync(join(worldDir(id), "db"), { recursive: true });
  const sign = new Database(join(worldDir(id), "db/note.sqlite"));
  sign.run("create table said (text text)");
  sign.run("insert into said values (?)", [`Join us: ${invite}`]);
  sign.close();
  await tool(alice, "write_file", { path: "mods/note/server.ts", content: note });
  await tool(alice, "reload", { mod: "note" });
  await tool(alice, "logs", { mod: invite });
  await tool(alice, "say", { text: `Join us: ${invite}` });
  const inWorld = (sql: string) => count(join(worldDir(id), "world.sqlite"), sql);
  const inMoments = (path: string) => {
    const db = new Database(path, { readonly: true });
    try {
      return (db.query("select data from timelapse").all() as { data: Uint8Array<ArrayBuffer> }[]).filter((r) => new TextDecoder().decode(Bun.gunzipSync(r.data)).includes(invite)).length;
    } finally {
      db.close();
    }
  };
  // The world saves every 5 s and records a timelapse moment every 2 s.
  for (let i = 0; i < 100 && !(inWorld(`select count(*) n from entity where data like '%${invite}%'`) && inWorld(`select count(*) n from timelapse where activity like '%${invite}%'`) && inMoments(join(worldDir(id), "world.sqlite"))); i++) await Bun.sleep(100);
  await menu("stop", {});
  expect(count(join(worldDir(id), "record.sqlite"), `select count(*) n from events where data like '%${invite}%'`)).toBeGreaterThan(0);
  expect(inWorld(`select count(*) n from timelapse where activity like '%${invite}%'`)).toBeGreaterThan(0);
  expect(inMoments(join(worldDir(id), "world.sqlite"))).toBeGreaterThan(0);
  // A game with a save its process holds open, mid-WAL, beside a file of its own that stays home.
  const games = JSON.stringify({ arena: { id: "arena", title: "Arena", tagline: "Last one standing.", color: "#c33", status: "early", createdBy: "alice", createdAt: 1 } }, null, 2);
  const seats = JSON.stringify({ alice: { game: "arena", lastPos: { arena: [1, 2, 3] } } }, null, 2);
  writeFileSync(join(worldDir(id), "games.json"), games);
  writeFileSync(join(worldDir(id), "seats.json"), seats);
  mkdirSync(join(worldDir(id), "games/arena"), { recursive: true });
  const arenaSave = join(worldDir(id), "games/arena/world.sqlite");
  seedStore(arenaSave, 3, { 1: { pillar: "north" }, 2: { pillar: "south" } });
  const arena = { entities: new Map(), nextId: 0 };
  const store = openStore(arenaSave);
  store.load(arena);
  store.save(arena);
  writeFileSync(join(worldDir(id), "games/arena/game.log"), "arena is running");
  const saved = (path: string) => {
    const db = new Database(path, { readonly: true });
    try {
      return [db.query("select next_id, entities from world").all(), db.query("select id, data from entity order by id").all()];
    } finally {
      db.close();
    }
  };
  await menu("host", { id });

  const cover = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  writeFileSync(join(worldDir(id), "cover.jpg"), cover);
  // A database whose writer died mid-WAL: opening it read-write would fold the WAL into it, so the export must leave both files as they are.
  const ghost = join(worldDir(id), "db/ghost.sqlite");
  Bun.spawnSync([process.execPath, "-e", `const db = new (require("bun:sqlite").Database)(${JSON.stringify(ghost)}); db.run("pragma journal_mode = wal"); db.run("create table t (x)"); db.run("insert into t values (1)"); process.kill(process.pid, "SIGKILL");`]);
  const untouched = () => [ghost, `${ghost}-wal`].map((f) => existsSync(f) && `${statSync(f).size} ${statSync(f).mtimeMs}`);
  const ghostBefore = untouched();
  expect(ghostBefore[1]).toBeTruthy();
  const res = (await menu("export", { id })) as Response;
  expect(res.headers.get("content-type")).toBe("application/zip");
  expect(res.headers.get("content-disposition")).toBe('attachment; filename="export-test.zip"');
  const zip = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(zip);
  const names = Object.keys(files);
  expect(names).toContain("world/.git/HEAD");
  expect(names).toContain("world/mods/note/server.ts");
  expect(names).toContain("db/note.sqlite");
  expect(names).toContain("db/ghost.sqlite");
  expect(untouched()).toEqual(ghostBefore);
  writeFileSync(join(dir, "ghost.sqlite"), files["db/ghost.sqlite"]!);
  expect(count(join(dir, "ghost.sqlite"), "select count(*) n from t")).toBe(1);
  expect(files["cover.jpg"]).toEqual(cover);
  expect(names.filter((n) => /^(keys\.json|launcher\.json)$|node_modules|\.sqlite-(wal|shm)$/.test(n))).toEqual([]);
  expect(names.filter((n) => n.startsWith("games"))).toEqual(["games.json", "games/arena/world.sqlite"]);
  expect(names).toContain("seats.json");
  expect(JSON.parse(new TextDecoder().decode(files["config.json"]))).toEqual({ name: "Export Test", rules: "additive", start: "basics" });
  expect(JSON.parse(new TextDecoder().decode(files["mods.json"])).note.build.server).toMatch(/^note\/[a-z0-9]+\/server\/server\.js$/);
  for (const [name, data] of Object.entries(files)) for (const secret of [hostKey, invite, alice]) expect(Buffer.from(data).includes(secret), `${secret} in ${name}`).toBe(false);
  writeFileSync(join(dir, "exported.sqlite"), files["world.sqlite"]!);
  expect(inMoments(join(dir, "exported.sqlite"))).toBe(0);
  writeFileSync(join(dir, "note.sqlite"), files["db/note.sqlite"]!);
  const loads = count(join(dir, "note.sqlite"), "select count(*) n from loads");

  const imported = await menu("import", zip);
  const copy = imported.worlds.find((w: any) => w.name === "Export Test" && w.id !== id);
  expect(copy).toBeTruthy();
  expect(readFileSync(join(worldDir(copy.id), "cover.jpg"))).toEqual(Buffer.from(cover));
  expect(readFileSync(join(worldDir(copy.id), "games.json"), "utf8")).toBe(games);
  expect(readFileSync(join(worldDir(copy.id), "seats.json"), "utf8")).toBe(seats);
  expect(saved(join(worldDir(copy.id), "games/arena/world.sqlite"))).toEqual(saved(arenaSave));
  expect(saved(arenaSave)[1]).toHaveLength(2);
  expect(existsSync(join(worldDir(copy.id), "games/arena/game.log"))).toBe(false);
  const hosted = await menu("host", { id: copy.id });
  expect(hosted.running.hostKey).not.toBe(hostKey);
  expect(hosted.running.invite).not.toBe(invite);
  expect(hosted.running.players).toEqual([]);
  expect((await fetch(`http://127.0.0.1:${LAUNCHER}/api/join`, { method: "POST", body: JSON.stringify({ name: "mallory", invite: hostKey }) })).status).toBe(403);
  // alice comes back under her name with a new key, and still owns her mod.
  const again = await joinAs("alice", hosted.running.invite);
  expect(again).not.toBe(alice);
  const status = answer(await tool(again, "status"));
  expect(status.mods.find((m: any) => m.name === "note")).toMatchObject({ author: "alice", version: 1 });
  expect(JSON.parse(readFileSync(join(worldDir(copy.id), "owners.json"), "utf8")).note).toBe("alice");
  // Her seat is in the arena, so the hub's entities are asked for by name; the arena runs from its imported save.
  expect(await tool(again, "query_world", { components: ["note"], game: "" })).toContain('"note":"kept"');
  expect(await tool(again, "query_world", { components: ["pillar"] })).toContain('"pillar":"north"');
  expect(await tool(again, "history", { mod: "note" })).toContain("note v1");
  // Its load hook ran once more, on top of the rows it brought along; the simulation loads mods just after the world starts answering.
  const loadsNow = async () => answer(await tool(again, "query_db", { mod: "note", sql: "select count(*) n from loads" }));
  for (let i = 0; i < 40 && (await loadsNow())[0].n === loads; i++) await Bun.sleep(50);
  expect(await loadsNow()).toEqual([{ n: loads + 1 }]);
  const activity = await (await fetch(`http://127.0.0.1:${LAUNCHER}/api/host/activity?kind=tool&summary=false&minutes=10`, { headers: { authorization: `Bearer ${hosted.running.hostKey}` } })).json();
  expect(activity.some((r: any) => r.who === "alice" && r.data.tool === "reload")).toBe(true);
  await menu("stop", {});

  // A stopped world exports too, imported ones included.
  const onward = unzipSync(new Uint8Array(await ((await menu("export", { id: copy.id })) as Response).arrayBuffer()));
  expect(Object.keys(onward)).toContain("world.sqlite");
  expect(JSON.parse(new TextDecoder().decode(onward["mods.json"])).note.build.server).toBe(JSON.parse(new TextDecoder().decode(files["mods.json"])).note.build.server);
}, 120_000);

test("an import that isn't a world, or climbs out of its folder, is turned away", async () => {
  const menu = await hostMenu();
  const before = (await menu("state")).worlds.length;
  const config = new TextEncoder().encode(JSON.stringify({ name: "Evil" }));
  const payload = new TextEncoder().encode("pwned");
  for (const files of <Record<string, Uint8Array>[]>[
    { "config.json": config, "../evil.txt": payload },
    { "config.json": config, "world/../../evil.txt": payload },
    { "config.json": config, "/tmp/evil.txt": payload },
    { "config.json": config, "world\\..\\..\\evil.txt": payload },
    { "config.json": config, "keys.json": payload },
    { "config.json": config, "games/arena/game.log": payload },
    { "config.json": config, "games/Arena/world.sqlite": payload },
    { "config.json": config, "games/arena/world.sqlite-wal": payload },
    { "config.json": config, "games/arena/deeper/world.sqlite": payload },
    { "notes.txt": payload },
  ]) {
    const zip = zipSync(files);
    expect(Object.keys(unzipSync(zip))).toEqual(Object.keys(files));
    expect(await menu("import", zip)).toMatchObject({ status: 400, error: "That file isn't a Sandbox world." });
  }
  expect(await menu("import", new TextEncoder().encode("not a zip"))).toMatchObject({ status: 400, error: "That file isn't a Sandbox world." });
  expect((await menu("state")).worlds.length).toBe(before);
  expect(readdirSync(join(dir, "data")).filter((f) => f.startsWith("importing-"))).toEqual([]);
  expect(existsSync(join(dir, "evil.txt"))).toBe(false);
});

test("the host's game keeps the world's picture fresh until the host picks one when sharing, which then stays", async () => {
  const menu = await hostMenu();
  const { key } = await (await localKey(`http://127.0.0.1:${LAUNCHER}`)).json();
  const cover = (id: string, jpeg?: Uint8Array) =>
    fetch(`http://127.0.0.1:${LAUNCHER}/api/menu/cover?id=${id}`, { method: jpeg ? "POST" : "GET", headers: { authorization: `Bearer ${key}` }, body: jpeg as Uint8Array<ArrayBuffer> | undefined });
  const jpeg = (n: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, 0xff, 0xd9]);
  const { running } = await menu("create", { name: "Picture Test" });
  const id = running.id;
  expect((await cover(id)).status).toBe(404);
  expect((await cover(id, jpeg(1))).status).toBe(204);
  expect((await cover(id, jpeg(2))).status).toBe(204);
  expect(new Uint8Array(await (await cover(id)).arrayBuffer())).toEqual(jpeg(2));
  expect((await menu("state")).worlds.find((w: { id: string }) => w.id === id).cover).toBeNumber();
  expect((await cover(id, new Uint8Array([1, 2, 3]))).status).toBe(400);

  // Sharing with the World picture leaves the game in charge of it.
  const community = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 200 }) });
  const uploads = { zip: `${community.url}zip`, cover: `${community.url}cover`, clip: `${community.url}clip` };
  expect((await menu("publish-stage", { id, visibility: "link" })).status).toBe(200);
  expect((await menu("publish-upload", { id, uploads })).status).toBe(200);
  expect((await cover(id, jpeg(3))).status).toBe(204);

  // Current view, once it went up, is the picture here too, and the game's own frames no longer replace it.
  const picked = jpeg(4);
  expect((await menu("publish-stage", { id, visibility: "link", cover: Buffer.from(picked).toString("base64") })).status).toBe(200);
  expect(new Uint8Array(await (await cover(id)).arrayBuffer())).toEqual(jpeg(3));
  expect((await menu("publish-upload", { id, uploads })).status).toBe(200);
  expect(new Uint8Array(await (await cover(id)).arrayBuffer())).toEqual(picked);
  expect((await cover(id, jpeg(5))).status).toBe(409);
  expect(new Uint8Array(await (await cover(id)).arrayBuffer())).toEqual(picked);

  // Every frame the game sent is kept for Share to pick from, behind the world's picture, newest first; timelapse moments drawn again replace the old ones.
  const b64 = (n: number) => Buffer.from(jpeg(n)).toString("base64");
  const shots = async () =>
    ((await (await fetch(`http://127.0.0.1:${LAUNCHER}/api/menu/shots`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ id }) })).json()) as { name: string; jpeg: string }[]).map((s) => [s.name.split("-")[0], s.jpeg]);
  expect(await shots()).toEqual([["cover", b64(4)], ...[5, 3, 2, 1].map((n) => ["view", b64(n)])]);
  expect((await menu("timelapse-shots", { id, frames: [b64(6), b64(7)] })).status).toBe(200);
  expect((await menu("timelapse-shots", { id, frames: [b64(8)] })).status).toBe(200);
  expect((await shots()).filter(([kind]) => kind === "timelapse")).toEqual([["timelapse", b64(8)]]);
  expect((await menu("timelapse-shots", { id, frames: ["AQID"] })).status).toBe(400);

  // The gallery goes up in the order picked, and a timelapse turned off sends no clip.
  const stage = await menu("publish-stage", { id, visibility: "link", gallery: [b64(8), b64(2)], clip: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString("base64"), timelapse: false });
  expect(stage.sizes).toEqual({ zip: expect.any(Number), cover: 7, gallery: [7, 7] });
  expect(stage.details.timelapse).toBe(false);
  const put: string[] = [];
  const counting = Bun.serve({ port: 0, fetch: async (req) => (put.push(`${new URL(req.url).pathname} ${(await req.bytes())[4]}`), new Response(null, { status: 200 })) });
  expect((await menu("publish-upload", { id, uploads: { zip: `${counting.url}zip`, cover: `${counting.url}cover`, gallery0: `${counting.url}g0`, gallery1: `${counting.url}g1` } })).status).toBe(200);
  expect(put.filter((p) => p.startsWith("/g")).sort()).toEqual(["/g0 8", "/g1 2"]);
  counting.stop(true);
  community.stop(true);
  await menu("stop", {});
});

test("renaming a world, running or not, keeps its id, folder, invite link, players and data", async () => {
  const menu = await hostMenu();
  const s = await menu("create", { name: "Old Name" });
  const { id, link, invite } = s.running;
  const base = link.split("/#")[0];
  const key = await joinAs("renamer", invite);
  const before = readdirSync(join(dir, "data", "worlds", id)).sort();

  const renamed = await menu("rename", { id, name: "  Lava Keep  " });
  expect(renamed.status).toBe(200);
  expect(renamed.worlds.find((w: { id: string }) => w.id === id).name).toBe("Lava Keep");
  expect(renamed.running).toMatchObject({ id, name: "Lava Keep", link, invite });
  expect(await until("the running world under its new name", async () => (await (await fetch(`${base}/api/info`)).json()).name === "Lava Keep")).toBe(true);

  for (const name of ["", "   ", "x".repeat(41)]) expect(await menu("rename", { id, name })).toMatchObject({ status: 400, error: "A name is 1 to 40 characters." });
  expect(await menu("rename", { id: "../evil", name: "Evil" })).toMatchObject({ status: 400, error: "That world doesn't exist." });

  await menu("stop", {});
  expect((await menu("rename", { id, name: "Stopped Keep" })).worlds.find((w: { id: string }) => w.id === id).name).toBe("Stopped Keep");
  const again = await menu("host", { id });
  expect(again.running).toMatchObject({ id, name: "Stopped Keep", link, invite });
  expect(await until("the invite link back, under the new name", async () => (await fetch(`${base}/api/info`).then((r) => r.json(), () => ({}))).name === "Stopped Keep")).toBe(true);
  // The player who joined before the renames is still that player, and a new one still joins by the same invite.
  const back = await (await fetch(`${base}/api/join`, { method: "POST", body: JSON.stringify({ key }) })).json();
  expect(back).toMatchObject({ key, name: "renamer" });
  expect(await joinAs("newcomer", invite)).toBeString();
  expect(readdirSync(join(dir, "data", "worlds")).filter((f) => f === id)).toEqual([id]);
  expect(readdirSync(join(dir, "data", "worlds", id)).sort()).toEqual(expect.arrayContaining(before));
  await menu("stop", {});
}, 30_000);
