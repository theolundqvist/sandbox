import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const root = mkdtempSync(join(tmpdir(), "sandbox-hostile-world-"));
const data = join(root, "world-data");
const home = join(root, "fake-home");
const canary = `CANARY-${crypto.randomUUID()}`;
for (const dir of [data, join(home, ".ssh")]) mkdirSync(dir, { recursive: true });
const forbidden = [join(home, ".ssh/id_canary"), join(root, ".env"), join(root, "launcher.json"), join(data, "config.json"), join(data, "world.sqlite")];
writeFileSync(forbidden[0]!, canary);
writeFileSync(forbidden[1]!, `MODBOX_CANARY=${canary}`);
writeFileSync(forbidden[2]!, JSON.stringify({ hostKey: canary }));
writeFileSync(forbidden[3]!, JSON.stringify({ name: "Security fixture", rules: "open", start: "blank", invite: "synthetic-invite", hostKey: canary }));
const stored = new Database(forbidden[4]!);
stored.run("create table canary(value text)");
stored.query("insert into canary values (?)").run(canary);
stored.close();
let proc: Subprocess;
let base = "";
let key = "";
let socket: WebSocket | undefined;
let output: Promise<string[]>;
let localHits = 0;
const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { localHits++; return new Response("not public"); } });

// The world has its own process and tick clock; fake timers cannot advance its HTTP state.
beforeAll(async () => {
  proc = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "server.ts")], {
    cwd: root,
    env: { HOME: home, PATH: process.env.PATH!, TMPDIR: root, SANDBOX_DATA: data, PORT: "0", MODBOX_CANARY: canary },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
    ipc: (message) => { if (message && typeof message === "object" && "port" in message && typeof message.port === "number") base = `http://127.0.0.1:${message.port}`; },
  });
  output = Promise.all([new Response(proc.stdout as ReadableStream<Uint8Array>).text(), new Response(proc.stderr as ReadableStream<Uint8Array>).text()]);
  for (let i = 0; i < 400 && !base; i++) await Bun.sleep(50);
  expect(base).not.toBe("");
  const joined = await (await fetch(`${base}/api/join`, { method: "POST", body: JSON.stringify({ invite: "synthetic-invite", name: "builder" }) })).json();
  key = joined.key;
  socket = new WebSocket(`${base.replace("http:", "ws:")}/ws?key=${key}`);
  await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("Fixture connection failed")); });
}, 30_000);

afterAll(async () => {
  socket?.close();
  proc?.kill();
  if (proc) await proc.exited;
  endpoint.stop(true);
  const logs = output ? await output : [];
  for (const log of logs) expect(log.includes(canary)).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

async function tool(name: string, args: Record<string, string>) {
  const body = new FormData();
  for (const [name, value] of Object.entries(args)) body.append(name, value);
  const response = await fetch(`${base}/cli/${name}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body });
  const text = await response.text();
  expect(text.includes(canary)).toBe(false);
  return { status: response.status, text };
}

test("a hostile mod cannot reach host files, environment, localhost, or a shell while SQLite and exports keep working", async () => {
  const mod = join(data, "world/mods/hostile");
  mkdirSync(mod, { recursive: true });
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "untouched");
  writeFileSync(join(mod, "server.ts"), `
import { readFileSync, writeFileSync, truncateSync } from "node:fs";
import { Socket } from "node:net";
import type { ServerMod } from "../../api";
export default {
  exports: { twice(_world, n: number) { return n * 2; } },
  load(world) {
    const reads = ${JSON.stringify(forbidden)}.map(path => { try { return readFileSync(path, "utf8"); } catch { return "denied"; } });
    let write = "allowed", truncate = "allowed", shell = "allowed";
    try { writeFileSync(${JSON.stringify(outside)}, "changed"); } catch { write = "denied"; }
    try { truncateSync(${JSON.stringify(outside)}, 0); } catch { truncate = "denied"; }
    try { const p = Bun.spawnSync(["/bin/sh", "-c", "printf escaped"], { stdout: "pipe", stderr: "pipe" }); if (p.exitCode !== 0) shell = "denied"; } catch { shell = "denied"; }
    world.db.run("create table if not exists legitimate(value integer)");
    world.db.run("insert into legitimate values (21)");
    const state = { reads, write, truncate, shell, env: process.env.MODBOX_CANARY ?? "denied", fetch: "pending", socket: "pending" };
    world.spawn({ modbox: state });
    world.async(async run => {
      let outcome = "allowed";
      try { await fetch("http://127.0.0.1:${endpoint.port}/canary"); } catch { outcome = "denied"; }
      run(() => { state.fetch = outcome; });
    });
    world.async(async run => {
      const outcome = await new Promise<string>(resolve => {
        try {
          const client = new Socket();
          client.once("error", () => { client.destroy(); resolve("denied"); });
          client.once("connect", () => { client.destroy(); resolve("allowed"); });
          client.connect(${endpoint.port}, "127.0.0.1");
        } catch { resolve("denied"); }
      });
      run(() => { state.socket = outcome; });
    });
  },
} satisfies ServerMod;
`);
  const reloaded = await tool("reload", { mod: "hostile" });
  expect(reloaded.status).toBe(200);
  expect(reloaded.text).toContain("is live");
  let state: Record<string, unknown> | undefined;
  for (let i = 0; i < 80; i++) {
    // query_world answers with the entity map on its first line, then the match count and any chat.
    const found = JSON.parse((await tool("query_world", { components: '["modbox"]' })).text.split("\n")[0]!) as Record<string, { modbox?: Record<string, unknown> }>;
    state = Object.values(found)[0]?.modbox;
    if (state && state.fetch !== "pending" && state.socket !== "pending") break;
    await Bun.sleep(50);
  }
  expect(state).toEqual({ reads: forbidden.map(() => "denied"), write: "denied", truncate: "denied", shell: "denied", env: "denied", fetch: "denied", socket: "denied" });
  expect(localHits).toBe(0);
  expect(readFileSync(outside, "utf8")).toBe("untouched");
  // query_db answers with JSON rows, then any chat after a blank line.
  expect(JSON.parse((await tool("query_db", { mod: "hostile", sql: "select value from legitimate" })).text.split("\n\n")[0]!)).toEqual([{ value: 21 }]);
  const consumer = join(data, "world/mods/consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "server.ts"), 'import type { ServerMod } from "../../api"; export default { load(world) { world.spawn({ exported: world.use("hostile").twice(21) }); } } satisfies ServerMod;');
  expect((await tool("reload", { mod: "consumer" })).text).toContain("is live");
  for (let i = 0; i < 20; i++) {
    const found = JSON.parse((await tool("query_world", { components: '["exported"]' })).text.split("\n")[0]!) as Record<string, { exported?: number }>;
    if (Object.values(found).some(entity => entity.exported === 42)) return;
    await Bun.sleep(50);
  }
  throw new Error("The legitimate cross-mod export never reached the world");
}, 45_000);
