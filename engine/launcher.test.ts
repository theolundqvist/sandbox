// A throwaway launcher and relay over real HTTP: only someone at the launcher's own machine gets the host key.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const dir = mkdtempSync(join(tmpdir(), "sandbox-launcher-"));
const LAUNCHER = 17000 + Math.floor(Math.random() * 1000);
const RELAY = LAUNCHER + 1000;
const procs: Subprocess[] = [];
/** This machine's own service keys never reach a test world. */
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.endsWith("_API_KEY")));

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
      env: { ...env, PORT: String(LAUNCHER), SANDBOX_DATA: join(dir, "data"), SANDBOX_RELAY: `http://127.0.0.1:${RELAY}`, SANDBOX_NO_OPEN: "1" },
      stdout: "ignore",
    }),
  );
  await Promise.all([up(`http://127.0.0.1:${RELAY}/`), up(`http://127.0.0.1:${LAUNCHER}/menu`)]);
});

afterAll(() => {
  for (const p of procs) p.kill();
  rmSync(dir, { recursive: true, force: true });
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

test("a player through the relay is not the host", async () => {
  const { key } = await (await localKey(`http://127.0.0.1:${LAUNCHER}`)).json();
  const menu = async (action: string, body?: object) =>
    (await fetch(`http://127.0.0.1:${LAUNCHER}/api/menu/${action}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${key}` }, body: body && JSON.stringify(body) })).json();
  await menu("share", { on: true });
  let url: string | null = null;
  for (let i = 0; i < 50 && !url; i++, await Bun.sleep(100)) url = (await menu("state")).tunnel?.url ?? null;
  expect(url).toStartWith(`http://127.0.0.1:${RELAY}/r/`);
  // The relay is reached on loopback here, exactly like a relay on the host's machine would be.
  expect((await fetch(`${url}/menu`)).status).toBe(200);
  expect((await localKey(url!)).status).toBe(401);
  expect((await localKey(url!, { host: "localhost" })).status).toBe(401);
});

test("a join code leads to the game's invite link until the host replaces it or stops sharing", async () => {
  const { key } = await (await localKey(`http://127.0.0.1:${LAUNCHER}`)).json();
  const menu = async (action: string, body?: object) =>
    (await fetch(`http://127.0.0.1:${LAUNCHER}/api/menu/${action}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${key}` }, body: body && JSON.stringify(body) })).json();
  const lookup = (code: string, ip = "198.51.100.1") => fetch(`http://127.0.0.1:${RELAY}/join/${code}`, { headers: { "x-real-ip": ip } });
  await menu("share", { on: true });
  const s = await menu("create", { name: "Code Test" });
  expect(s.tunnel.code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
  const first = s.tunnel.code;
  const formatted = `${first.slice(0, 3)}-${first.slice(3).toLowerCase()}`;
  expect(await (await lookup(formatted)).json()).toEqual({ url: `${s.tunnel.url}/#invite=${s.running.invite}` });

  const invited = await menu("invite", {});
  expect(invited.running.invite).not.toBe(s.running.invite);
  expect((await (await lookup(first)).json()).url).toEndWith(`#invite=${invited.running.invite}`);

  const renewed = await menu("code", {});
  expect(renewed.tunnel.code).not.toBe(first);
  expect(await (await lookup(first)).json()).toEqual({ error: "No game with that code" });
  expect((await lookup(renewed.tunnel.code)).status).toBe(200);

  await menu("share", { on: false });
  await Bun.sleep(200);
  expect((await lookup(renewed.tunnel.code)).status).toBe(404);
  await menu("stop", {});
});

test("join code lookups are limited per address", async () => {
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await fetch(`http://127.0.0.1:${RELAY}/join/AAAAAA`, { headers: { "x-real-ip": "198.51.100.2" } })).status);
  expect(statuses).toEqual([...Array(10).fill(404), 429]);
  expect((await fetch(`http://127.0.0.1:${RELAY}/join/AAAAAA`, { headers: { "x-real-ip": "198.51.100.3" } })).status).toBe(404);
});

test("worlds made without a name each get their own", async () => {
  const { key } = await (await localKey(`http://127.0.0.1:${LAUNCHER}`)).json();
  const create = async () => (await fetch(`http://127.0.0.1:${LAUNCHER}/api/menu/create`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: "{}" })).json();
  await create();
  const { worlds } = await create();
  const unnamed = worlds.filter((w: { name: string }) => w.name !== "Code Test").map((w: { name: string }) => w.name);
  expect(unnamed).toHaveLength(2);
  expect(new Set(unnamed).size).toBe(2);
  expect(unnamed).not.toContain("Sandbox");
});

test("a computer without git hosts worlds, reloads mods, and says history needs Git", async () => {
  // Only bun on the PATH: any git call would fail to spawn and stop the world.
  const bin = join(dir, "nogit-bin");
  mkdirSync(bin);
  symlinkSync(Bun.which("bun")!, join(bin, "bun"));
  const port = LAUNCHER + 500;
  procs.push(Bun.spawn([join(bin, "bun"), join(import.meta.dir, "launcher.ts")], { env: { PATH: bin, HOME: dir, PORT: String(port), SANDBOX_DATA: join(dir, "nogit"), SANDBOX_NO_OPEN: "1" }, stdout: "ignore", stderr: "ignore" }));
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

test("the host adds a voice key in the game: checked, kept private, live without a restart, and removable", async () => {
  const GOOD = "sk_test_good_voice_key";
  let accepted = GOOD;
  const eleven = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("xi-api-key") !== accepted) return Response.json({ detail: { status: "invalid_api_key" } }, { status: 401 });
      const file = (await req.formData()).get("file") as Blob;
      return file.size ? Response.json({ text: "build a bridge" }) : Response.json({ detail: "empty audio" }, { status: 400 });
    },
  });
  const port = LAUNCHER + 600;
  const data = join(dir, "voice");
  const launcher = Bun.spawn(["bun", join(import.meta.dir, "launcher.ts")], { env: { ...env, PORT: String(port), SANDBOX_DATA: data, SANDBOX_NO_OPEN: "1", SANDBOX_ELEVENLABS: `http://127.0.0.1:${eleven.port}` }, stdout: "pipe", stderr: "pipe" });
  procs.push(launcher);
  const base = `http://127.0.0.1:${port}`;
  await up(`${base}/menu`);
  const { key } = await (await localKey(base)).json();
  const menu = (action: string, body: object) => fetch(`${base}/api/menu/${action}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const s = await (await menu("create", { name: "Voice Test", start: "blank" })).json();
  expect(s.voiceKey).toBeNull();
  const player = await (await fetch(`${base}/api/join`, { method: "POST", body: JSON.stringify({ invite: s.running.invite, name: "talker" }) })).json();
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
  expect((await next("welcome")).voice).toBe(false);

  const wrong = await menu("voice", { key: "sk_not_it" });
  expect(await wrong.json()).toEqual({ error: "That key didn't work. Copy it again from elevenlabs.io." });
  const added = await (await menu("voice", { key: ` ${GOOD} ` })).json();
  expect(added.voiceKey).toBe("••••_key");
  expect(await next("voice")).toEqual({ t: "voice", on: true });

  const secrets = join(data, "secrets.json");
  expect(statSync(secrets).mode & 0o777).toBe(0o600);
  const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]));
  expect(files(join(data, "worlds")).filter((f) => readFileSync(f).includes(GOOD))).toEqual([]);

  await fetch(`${base}/api/voice`, { method: "POST", headers: { authorization: `Bearer ${player.key}` }, body: new Blob([new Uint8Array(2000)], { type: "audio/webm" }) });
  expect(await next("chat")).toMatchObject({ from: "talker", text: "build a bridge", spoken: true });

  accepted = "sk_rotated";
  await fetch(`${base}/api/voice`, { method: "POST", headers: { authorization: `Bearer ${player.key}` }, body: new Blob([new Uint8Array(2000)], { type: "audio/webm" }) });
  expect(await next("voice-failed")).toEqual({ t: "voice-failed", refused: true });

  expect((await (await menu("voice", { key: "" })).json()).voiceKey).toBeNull();
  expect(await next("voice")).toEqual({ t: "voice", on: false });
  ws.close();
  launcher.kill();
  eleven.stop(true);
  const printed = (await new Response(launcher.stdout).text()) + (await new Response(launcher.stderr).text());
  expect(printed).not.toContain(GOOD);
}, 60_000);

test("a world that crashes is hosted again by itself, its players' games reconnect and hear why, and the crash is in world.log", async () => {
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
  process.kill(first, "SIGABRT");

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
  expect(welcome.feed.map((f: { text: string }) => f.text)).toContain("The game crashed and restarted by itself. Anything from the last few seconds before the crash may be gone.");
  expect(world()).not.toBe(first);
  const log = readFileSync(join(data, "worlds", s.running.id, "world.log"), "utf8");
  expect(log.match(/Crashy is running/g)).toHaveLength(2);
  launcher.kill();
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
  },
} satisfies ServerMod;
`;
  await tool(alice, "write_file", { path: "mods/note/server.ts", content: note });
  await tool(alice, "reload", { mod: "note" });
  // The world saves every 5 s. Stopping it writes its host link into the record, which the export must scrub.
  for (let i = 0; i < 100 && !count(join(worldDir(id), "world.sqlite"), `select count(*) n from entity where data like '%"note"%'`); i++) await Bun.sleep(100);
  await menu("stop", {});
  expect(count(join(worldDir(id), "record.sqlite"), `select count(*) n from events where data like '%${hostKey}%'`)).toBeGreaterThan(0);
  await menu("host", { id });

  const res = (await menu("export", { id })) as Response;
  expect(res.headers.get("content-type")).toBe("application/zip");
  expect(res.headers.get("content-disposition")).toBe('attachment; filename="export-test.zip"');
  const zip = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(zip);
  const names = Object.keys(files);
  expect(names).toContain("world/.git/HEAD");
  expect(names).toContain("world/mods/note/server.ts");
  expect(names).toContain("db/note.sqlite");
  expect(names.filter((n) => /^(keys\.json|launcher\.json)$|node_modules|\.sqlite-(wal|shm)$/.test(n))).toEqual([]);
  expect(JSON.parse(new TextDecoder().decode(files["config.json"]))).toEqual({ name: "Export Test", rules: "additive", start: "basics" });
  expect(JSON.parse(new TextDecoder().decode(files["mods.json"])).note.build.server).toMatch(/^note\/[a-z0-9]+\/server\/server\.js$/);
  for (const [name, data] of Object.entries(files)) for (const secret of [hostKey, invite, alice]) expect(Buffer.from(data).includes(secret), `${secret} in ${name}`).toBe(false);
  writeFileSync(join(dir, "note.sqlite"), files["db/note.sqlite"]!);
  const loads = count(join(dir, "note.sqlite"), "select count(*) n from loads");

  const imported = await menu("import", zip);
  const copy = imported.worlds.find((w: any) => w.name === "Export Test" && w.id !== id);
  expect(copy).toBeTruthy();
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
  expect(await tool(again, "query_world", { components: ["note"] })).toContain('"note":"kept"');
  expect(await tool(again, "history", { mod: "note" })).toContain("note v1");
  // Its load hook ran once more, on top of the rows it brought along.
  expect(answer(await tool(again, "query_db", { mod: "note", sql: "select count(*) n from loads" }))).toEqual([{ n: loads + 1 }]);
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
