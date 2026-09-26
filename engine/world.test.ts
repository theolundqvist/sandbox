// A throwaway world over real HTTP and websockets, driven through the same tools a Claude uses.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const dir = mkdtempSync(join(tmpdir(), "sandbox-world-"));
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let world: Subprocess;
let key: string;
let player: WebSocket;
const received: any[] = [];

beforeAll(async () => {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name: "Test", rules: "open", start: "basics", invite: "test-invite", hostKey: "test-host" }));
  world = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], { env: { ...process.env, SANDBOX_DATA: dir, PORT: String(PORT) }, stdout: "ignore", stderr: "inherit" });
  for (let i = 0; i < 200 && !(await fetch(`${BASE}/api/info`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
  ({ key } = await (await fetch(`${BASE}/api/join`, { method: "POST", body: JSON.stringify({ invite: "test-invite", name: "builder" }) })).json());
  player = new WebSocket(`ws://127.0.0.1:${PORT}/ws?key=${key}`);
  player.onmessage = ({ data }) => received.push(JSON.parse(String(data)));
  await new Promise((resolve) => (player.onopen = resolve));
}, 30_000);

afterAll(() => {
  player?.close();
  world?.kill();
  rmSync(dir, { recursive: true, force: true });
});

async function tool(name: string, args: Record<string, unknown> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(args)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
  const res = await fetch(`${BASE}/cli/${name}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
  return { status: res.status, text: await res.text() };
}

const write = (path: string, content: string) => tool("write_file", { path, content });
const serverMod = (hooks: string) => `import type { ServerMod } from "../../api";\nexport default ${hooks} satisfies ServerMod;`;

test("a mod goes live at most once every 20 s, says when it may again, and a reload that leaves its client unchanged doesn't swap it in players' games", async () => {
  expect((await tool("reload", { mod: "basics" })).status).toBe(200);
  const refused = await tool("reload", { mod: "basics" });
  expect(refused.status).toBe(422);
  const wait = Number(refused.text.match(/Reload again in (\d+) s/)?.[1]);
  expect(wait).toBeGreaterThan(15);
  expect(wait).toBeLessThanOrEqual(20);
  await Bun.sleep(wait * 1000);
  expect((await tool("reload", { mod: "basics" })).status).toBe(200);
  expect(received.filter((m) => m.t === "mod" && m.name === "basics")).toEqual([]);

  await write("mods/painted/client.ts", `export default { init() {} };`);
  expect((await tool("reload", { mod: "painted" })).status).toBe(200);
  expect(received.filter((m) => m.t === "mod" && m.name === "painted")).toHaveLength(1);
}, 60_000);

test("reloads of a mod that pile up behind another reload go live once, and every caller hears the result", async () => {
  await write("mods/slow/server.ts", `export default { tick() {} };`);
  await write("mods/twin/server.ts", `export default { tick() {} };`);
  const slow = tool("reload", { mod: "slow" });
  const twins = await Promise.all([tool("reload", { mod: "twin" }), tool("reload", { mod: "twin" })]);
  expect((await slow).status).toBe(200);
  for (const twin of twins) {
    expect(twin.status).toBe(200);
    expect(twin.text).toStartWith("twin v1 is live");
  }
}, 30_000);

test("Claudes' messages to each other arrive whole, and a chat line too long for players is refused instead of cut", async () => {
  const { key: other } = await (await fetch(`${BASE}/api/join`, { method: "POST", body: JSON.stringify({ invite: "test-invite", name: "other" }) })).json();
  const contract = `Contract: ${"x".repeat(1500)} END`;
  expect((await tool("say", { text: contract, to: "claudes" })).status).toBe(200);
  const heard = await (await fetch(`${BASE}/cli/status`, { method: "POST", headers: { authorization: `Bearer ${other}` } })).text();
  expect(heard).toContain(`[claudes] builder's Claude: ${contract}`);

  const refused = await tool("say", { text: "y".repeat(401) });
  expect(refused.status).toBe(422);
  expect(refused.text).toStartWith("That is 401 characters");
  expect(received.some((m) => m.t === "chat" && m.text.startsWith("yyy"))).toBe(false);
  expect((await tool("say", { text: "z".repeat(400) })).status).toBe(200);
  await Bun.sleep(100);
  expect(received.find((m) => m.t === "chat" && m.text.startsWith("zzz"))?.text).toHaveLength(400);

  const banner = await tool("reload", { mod: "basics", announce: { title: "Long", text: "w".repeat(161) } });
  expect(banner.status).toBe(422);
  expect(banner.text).toStartWith("announce.text is 161 characters");
});

test("a meshless wall or a mod's terrain that stops a walk is named with the mod that made it", async () => {
  await write(
    "mods/fence/server.ts",
    serverMod(`{
  load(world) {
    world.spawn({ pos: [20, 2, 0], solid: { size: [1, 4, 20] } });
    world.physics.ground((x) => (x < -20 ? 3 : null));
  },
}`),
  );
  expect((await tool("reload", { mod: "fence" })).text).toStartWith("fence v1 is live");
  const walk = async (from: number[], to: number[]) => JSON.parse((await tool("walk_test", { from, to })).text);

  const wall = await walk([10, 0, 0], [30, 0, 0]);
  expect(wall.outcome).toBe("stopped");
  expect(wall.at[0]).toBeCloseTo(19.15, 1);
  expect(wall.by).toMatchObject({ mesh: false, mod: "fence", box: { center: [20, 2, 0], size: [1, 4, 20] } });

  const cliff = await walk([-10, 0, 0], [-30, 0, 0]);
  expect(cliff.outcome).toBe("stopped");
  expect(cliff.by).toMatchObject({ terrain: "fence", rise: 3 });

  expect((await walk([10, 0, 5], [10, 0, -5])).outcome).toBe("reached");
}, 30_000);

test("a mod that overrules where a player's game or another mod moved them shows up in corrections", async () => {
  await write(
    "mods/pen/server.ts",
    serverMod(`{
  message(world, player, msg) {
    for (const [, e] of world.query("player")) if (e.player === player.id) e.pos = [Math.min(msg.p[0], 3), msg.p[1], msg.p[2]];
  },
}`),
  );
  await write(
    "mods/leash/server.ts",
    serverMod(`{
  tick(world) {
    for (const [, e] of world.query("player")) if (e.pos[2] > 2) e.pos = [e.pos[0], e.pos[1], 2];
  },
}`),
  );
  for (const mod of ["pen", "leash"]) expect((await tool("reload", { mod })).text).toStartWith(`${mod} v1 is live`);
  const tell = (mod: string, msg: object) => player.send(JSON.stringify({ t: "m", mod, msg }));
  const corrections = async (mod: string) => (await tool("corrections", { mod })).text.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));

  tell("basics", { x: 0, z: 1 });
  await Bun.sleep(1500);
  tell("basics", { x: 0, z: 0 });
  expect((await corrections("leash"))[0]).toMatchObject({ player: "builder", hook: "tick", overruled: "basics", to: [expect.any(Number), expect.any(Number), 2] });

  tell("pen", { p: [2, 0.8, 0] });
  await Bun.sleep(200);
  expect(await corrections("pen")).toEqual([]);
  tell("pen", { p: [10, 0.8, 0] });
  await Bun.sleep(200);
  expect((await corrections("pen"))[0]).toMatchObject({ player: "builder", hook: "message", overruled: "the player's own game", wanted: [10, 0.8, 0], to: [3, 0.8, 0] });
}, 30_000);

test("a Claude can show colliders in its player's game", async () => {
  expect((await tool("colliders", { on: true })).status).toBe(200);
  await Bun.sleep(100);
  expect(received.some((m) => m.t === "colliders" && m.on === true)).toBe(true);
});

test("test runs of a mod don't keep copies of the world's databases alive", async () => {
  await write("mods/ledger/server.ts", serverMod(`{ load(world) { world.db.run("create table if not exists t (s text)"); world.db.transaction(() => { for (let i = 0; i < 2000; i++) world.db.run("insert into t values (?)", "x".repeat(4000)); }); } }`));
  expect((await tool("reload", { mod: "ledger" })).text).toStartWith("ledger v1 is live");
  await write("mods/broken/server.ts", serverMod(`{ tick() { throw new Error("broken"); } }`));
  const rss = () => Number(readFileSync(`/proc/${world.pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)![1]) / 1024;
  await tool("reload", { mod: "broken" });
  const before = rss();
  for (let i = 0; i < 30; i++) expect((await tool("reload", { mod: "broken" })).text).toStartWith("Test run");
  // Measured: 84 MB with the copies closed, 584 MB without.
  expect(rss() - before).toBeLessThan(250);
}, 60_000);
