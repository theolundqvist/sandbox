// A playtest against a real world server, with a stand-in for the desktop app's hidden client, so it runs without Electron.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Subprocess } from "bun";

const dir = mkdtempSync(join(tmpdir(), "sandbox-live-"));
const PORT = 21000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const COPIES = `sandbox-playtest-${basename(dir)}-`;
let world: Subprocess;
let key: string;
let player: WebSocket;

/** The hidden client's side of the protocol: joins the copy as the playtest's player, answers input and screenshots, and leaves when the world that started it closes its stdin. */
const CLIENT = `
const url = new URL(process.env.SANDBOX_PLAYTEST);
const key = new URLSearchParams(url.hash.slice(1)).get("key");
const ws = new WebSocket(url.origin.replace("http", "ws") + "/ws?key=" + key);
ws.onmessage = ({ data }) => JSON.parse(String(data)).t === "welcome" && ws.send(JSON.stringify({ t: "loaded", firstFrameMs: 1, slowestMods: {} }));
let buffered = "";
for await (const chunk of Bun.stdin.stream().pipeThrough(new TextDecoderStream())) {
  const lines = (buffered + chunk).split("\\n");
  buffered = lines.pop();
  for (const line of lines) {
    const msg = JSON.parse(line);
    if (msg.t === "input") await Bun.sleep(msg.ms);
    console.log(JSON.stringify(msg.t === "shot" ? { id: msg.id, data: "/9j/2wBDAAEB" } : { id: msg.id, ok: true }));
  }
}
process.exit(0);
`;

const serverMod = (hooks: string) => `import type { ServerMod } from "../../api";\nexport default ${hooks} satisfies ServerMod;`;
const probe = (label: string) => serverMod(`{ load(world) { world.db.run("create table if not exists notes (label)"); world.db.run("insert into notes values ('${label}')"); if (!world.query("probe").length) world.spawn({ probe: "${label}" }); } }`);

function startWorld() {
  return Bun.spawn(["bun", join(import.meta.dir, "server.ts")], {
    env: { ...process.env, SANDBOX_DATA: dir, PORT: String(PORT), SANDBOX_PLAYTEST_APP: JSON.stringify([process.execPath, join(dir, "client.ts")]) },
    stdout: "ignore",
    stderr: "inherit",
  });
}

beforeAll(async () => {
  writeFileSync(join(dir, "client.ts"), CLIENT);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name: "Live", rules: "additive", start: "basics", invite: "live-invite", hostKey: "live-host" }));
  world = startWorld();
  for (let i = 0; i < 200 && !(await fetch(`${BASE}/api/info`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
  ({ key } = await (await fetch(`${BASE}/api/join`, { method: "POST", body: JSON.stringify({ invite: "live-invite", name: "builder" }) })).json());
  player = new WebSocket(`ws://127.0.0.1:${PORT}/ws?key=${key}`);
  await new Promise((resolve) => (player.onopen = resolve));
}, 30_000);

afterAll(async () => {
  player?.close();
  world?.kill("SIGKILL");
  await world?.exited;
  rmSync(dir, { recursive: true, force: true, maxRetries: 20 });
});

async function tool(name: string, args: Record<string, unknown> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(args)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
  const res = await fetch(`${BASE}/cli/${name}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
  return { status: res.status, text: (await res.text()).split("\n\nWhen you are done")[0]!, type: res.headers.get("content-type") };
}
const fps = (n: number) => player.send(JSON.stringify({ t: "perf", at: 0, fps: n }));

/** Every process a playtest started: the copy's server and the hidden client, each leading its own group, with everything under them. */
function playtestProcesses() {
  const pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  const env = (pid: string) => {
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8");
    } catch {
      return "";
    }
  };
  const stat = (pid: string) => {
    try {
      const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
      return { state: fields[0]!, group: fields[2]! };
    } catch {
      return null;
    }
  };
  const leaders = pids.filter((p) => env(p).includes(`SANDBOX_PLAYTEST_FROM=${dir}\0`) || env(p).includes(`SANDBOX_PLAYTEST_DATA=${join(tmpdir(), COPIES)}`));
  const groups = new Set(leaders.map((p) => stat(p)?.group));
  return pids.flatMap((pid) => {
    const s = stat(pid);
    return s && groups.has(s.group) ? [{ pid, ...s }] : [];
  });
}
const copies = () => readdirSync(tmpdir()).filter((d) => d.startsWith(COPIES));
const liveState = async () => ({
  notes: (await tool("query_db", { mod: "probe", sql: "select label from notes" })).text,
  probes: (await tool("query_world", { components: ["probe"] })).text,
  versions: JSON.parse((await tool("status")).text.split("\n\n")[0]!).mods.map((m: any) => `${m.name} v${m.version}`),
  bytes: ["db/probe.sqlite", "db/probe.sqlite-wal", "owners.json", "mods.json", "keys.json"].map((f) => (existsSync(join(dir, f)) ? Bun.hash(readFileSync(join(dir, f))).toString(36) : null)),
});

test.skipIf(process.platform !== "linux")("a playtest runs a copy of the world with the mod's unreloaded files, and nothing it does reaches the live world", async () => {
  await tool("write_file", { path: "mods/probe/server.ts", content: probe("live") });
  expect((await tool("reload", { mod: "probe" })).status).toBe(200);
  writeFileSync(join(dir, "world/mods/probe/server.ts"), probe("candidate"));
  fps(60);
  await Bun.sleep(300);
  const before = await liveState();

  const started = await tool("playtest", { mod: "probe" });
  expect(started.status).toBe(200);
  expect(started.text).toContain("Started a playtest");
  expect(started.text).toContain("probe reloaded in the copy from its current files.");
  const [copy] = copies();
  const copyDb = new (await import("bun:sqlite")).Database(join(tmpdir(), copy!, "db/probe.sqlite"), { readonly: true });
  // The live world's rows came along, and the copy ran the candidate on top of them.
  const rows = copyDb.query("select label from notes").all();
  expect([rows[0], rows.at(-1)]).toEqual([{ label: "live" }, { label: "candidate" }]);
  copyDb.close();
  expect(JSON.parse(readFileSync(join(tmpdir(), copy!, "keys.json"), "utf8"))).not.toHaveProperty(key);

  // Everything it started runs at the lowest priority, the scheduler's idle class on Linux.
  const running = playtestProcesses();
  expect(running.length).toBeGreaterThanOrEqual(2);
  for (const { pid } of running) {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
    expect(fields[16]).toBe("19");
    expect(fields[38]).toBe("5");
  }

  expect((await tool("playtest")).text).toStartWith("The playtest is running, with you in it as builder.");
  expect((await tool("play", { keys: "w", ms: 200 })).text).toStartWith("In the playtest you held w for 200 ms.");
  const shot = await tool("screenshot");
  expect(shot.type).toBe("image/jpeg");

  expect(await liveState()).toEqual(before);
  expect((await tool("playtest", { action: "stop" })).text).toBe("The playtest stopped and its copy of the world is gone.");
  expect(playtestProcesses()).toEqual([]);
  expect(copies()).toEqual([]);
  expect(await liveState()).toEqual(before);
  expect((await tool("play", { keys: "w" })).text).toStartWith("No playtest is running.");
}, 120_000);

test.skipIf(process.platform !== "linux")("two slow frames in a row in a player's game pause the playtest, and two smooth ones resume it", async () => {
  fps(60);
  await Bun.sleep(200);
  expect((await tool("playtest")).status).toBe(200);
  fps(50);
  fps(50);
  await Bun.sleep(300);
  const paused = await tool("play", { keys: "w", ms: 10 });
  expect(paused.status).toBe(422);
  expect(paused.text).toStartWith("paused: your player's game needs the computer.");
  expect(playtestProcesses().every((p) => p.state === "T")).toBe(true);
  fps(58);
  fps(59);
  await Bun.sleep(300);
  expect(playtestProcesses().some((p) => p.state === "T")).toBe(false);
  expect((await tool("play", { keys: "w", ms: 10 })).status).toBe(200);
}, 120_000);

test.skipIf(process.platform !== "linux")("a playtest ends with the live world, even one that is killed", async () => {
  expect(playtestProcesses().length).toBeGreaterThanOrEqual(2);
  world.kill("SIGKILL");
  await world.exited;
  for (let i = 0; i < 100 && playtestProcesses().length; i++) await Bun.sleep(100);
  expect(playtestProcesses()).toEqual([]);
  // The next start of the world clears the copy a crash left behind.
  world = startWorld();
  for (let i = 0; i < 200 && !(await fetch(`${BASE}/api/info`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
  expect((await tool("playtest")).status).toBe(200);
  expect(copies()).toHaveLength(1);
  world.kill("SIGTERM");
  await world.exited;
  expect(playtestProcesses()).toEqual([]);
  expect(copies()).toEqual([]);
}, 120_000);
