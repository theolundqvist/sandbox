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

/** A JSON answer is the first block; chat and the wait_for_chat reminder follow it. */
const json = async (name: string, args: Record<string, unknown> = {}) => JSON.parse((await tool(name, args)).text.split("\n\n")[0]!);
const write = (path: string, content: string) => tool("write_file", { path, content });
/** Changes a file the way a Claude's own editor would, without the write tool's base hash. */
const edit = (path: string, content: string) => writeFileSync(join(dir, "world", path), content);
const serverMod = (hooks: string) => `import type { ServerMod } from "../../api";\nexport default ${hooks} satisfies ServerMod;`;

test("a mod reloads again at once, and a reload that leaves its client or its server byte for byte the same leaves players' games or the simulation alone", async () => {
  expect((await tool("reload", { mod: "basics" })).status).toBe(200);
  expect((await tool("reload", { mod: "basics" })).text).toStartWith("basics v3 is live");
  expect(received.filter((m) => m.t === "mod" && m.name === "basics")).toEqual([]);

  const counting = (n: number) => serverMod(`{ load(world) { world.db.run("create table if not exists loads (n)"); world.db.run("insert into loads values (${n})"); } }`);
  await write("mods/painted/client.ts", `export default { init() {} };`);
  await write("mods/painted/server.ts", counting(1));
  expect((await tool("reload", { mod: "painted" })).status).toBe(200);
  expect(received.filter((m) => m.t === "mod" && m.name === "painted")).toHaveLength(1);
  const loads = async () => (await tool("query_db", { mod: "painted", sql: "select count(*) as n from loads" })).text.match(/"n":\s*(\d+)/)?.[1];
  expect(await loads()).toBe("1");
  edit("mods/painted/client.ts", `export default { init() { console.log("repainted"); } };`);
  expect((await tool("reload", { mod: "painted" })).text).toStartWith("painted v2 is live");
  expect(received.filter((m) => m.t === "mod" && m.name === "painted")).toHaveLength(2);
  expect(await loads()).toBe("1");
  edit("mods/painted/server.ts", counting(2));
  expect((await tool("reload", { mod: "painted" })).text).toStartWith("painted v3 is live");
  expect(await loads()).toBe("2");
}, 60_000);

test("reloads asked for while one of the same mod runs become one follow-up of the latest files, and another mod reloads alongside", async () => {
  // twin's first version holds the simulation in each load for as long as it can without the 2 s hang check stopping it, so quick has time to spare on a busy machine.
  const holding = (id: string, ms: number) => serverMod(`{ load(world) { Bun.sleepSync(${ms}); world.spawn({ pos: [0, 0, 0], twin: "${id}" }); } }`);
  await write("mods/twin/server.ts", holding("first", 1200));
  await write("mods/quick/server.ts", serverMod(`{ tick() {} }`));
  const first = tool("reload", { mod: "twin" });
  const firstDone = first.then(() => performance.now());
  await Bun.sleep(100);
  edit("mods/twin/server.ts", holding("latest", 0));
  const later = [tool("reload", { mod: "twin" }), tool("reload", { mod: "twin" })];
  const quick = await tool("reload", { mod: "quick" });
  expect(quick.text).toStartWith("quick v1 is live");
  expect(performance.now()).toBeLessThan(await firstDone);
  expect((await first).text).toStartWith("twin v1 is live");
  for (const twin of await Promise.all(later)) expect(twin.text).toStartWith("twin v2 is live");
  // The spawn reaches query_world with the next tick.
  const twins = async () => (await tool("query_world", { components: ["twin"] })).text;
  for (let i = 0; i < 20 && !(await twins()).includes('"latest"'); i++) await Bun.sleep(100);
  expect(await twins()).toContain('"latest"');
}, 30_000);

test("a mod that claims a system another live mod owns is told whose it is, and status lists what each mod owns", async () => {
  await write("mods/stomach/server.ts", `export const owns = ["hunger"];\n${serverMod(`{ tick() {} }`)}`);
  expect((await tool("reload", { mod: "stomach" })).text).not.toContain("hunger:");
  await write("mods/snacks/server.ts", `export const owns = ["hunger", "inventory"];\n${serverMod(`{ tick() {} }`)}`);
  expect((await tool("reload", { mod: "snacks" })).text).toContain("- hunger: stomach by builder already owns it.");
  const { mods } = await json("status");
  expect(mods.find((m: { name: string }) => m.name === "snacks").owns).toEqual(["hunger", "inventory"]);
});

test("Claudes' messages to each other arrive whole, and a chat line too long for players is refused instead of cut", async () => {
  const { key: other } = await (await fetch(`${BASE}/api/join`, { method: "POST", body: JSON.stringify({ invite: "test-invite", name: "other" }) })).json();
  const contract = `Contract: ${"x".repeat(1500)} END`;
  expect((await tool("say", { text: contract, to: "claudes" })).status).toBe(200);
  const heard = await (await fetch(`${BASE}/cli/status`, { method: "POST", headers: { authorization: `Bearer ${other}` } })).text();
  expect(heard).toContain(`[claudes] builder's agent: ${contract}`);

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

test("announce reveals a live mod with a banner but no vote, at most once a minute per mod", async () => {
  const shown = await tool("announce", { mod: "basics", title: "Double jump", text: "Press Space twice in the air" });
  expect(shown.status).toBe(200);
  await Bun.sleep(100);
  expect(received.find((m) => m.t === "announce" && m.title === "Double jump")).toMatchObject({ mod: "basics", text: "Press Space twice in the air", vote: false });

  const again = await tool("announce", { mod: "basics", title: "Triple jump" });
  expect(again.status).toBe(422);
  expect(again.text).toContain("at most one a minute");
  expect((await tool("announce", { mod: "nowhere", title: "Ghost" })).status).toBe(422);
  await Bun.sleep(100);
  expect(received.some((m) => m.t === "announce" && ["Triple jump", "Ghost"].includes(m.title))).toBe(false);
});

test("every result, answered or refused, sends the agent back to wait_for_chat, so any harness keeps listening", async () => {
  const answered = await tool("status");
  const refused = await tool("read_file", { path: "missing.ts" });
  expect(refused.status).toBe(422);
  for (const { text } of [answered, refused]) expect(text.trimEnd()).toEndWith("call wait_for_chat again. Never end your turn.");
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
  const walk = async (from: number[], to: number[]) => json("walk_test", { from, to });

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
  // Measured over these 30 runs: 584 MB when test runs were workers that kept their copies, 84 MB when they closed them, 0 MB as child processes.
  expect(rss() - before).toBeLessThan(50);
}, 60_000);

test("perf names the mod behind a slow tick, not just its average", async () => {
  await write("mods/spiky/server.ts", serverMod(`{ tick() { if (Date.now() % 500 < 60) { const until = performance.now() + 30; while (performance.now() < until); } } }`));
  expect((await tool("reload", { mod: "spiky" })).text).toStartWith("spiky v1 is live");
  await Bun.sleep(4500);
  const { server } = await json("perf");
  expect(server.modTicks.spiky.max).toBeGreaterThanOrEqual(29);
  expect(server.mods.spiky).toBeLessThan(15);
}, 30_000);

test("query_world with wait answers when what it asked about changes, not before", async () => {
  await write("mods/bell/server.ts", serverMod(`{ message(world) { world.spawn({ pos: [0, 0, 0], rung: true }); } }`));
  expect((await tool("reload", { mod: "bell" })).text).toStartWith("bell v1 is live");
  const started = Date.now();
  const answer = tool("query_world", { components: ["rung"], wait: 20 });
  await Bun.sleep(1000);
  player.send(JSON.stringify({ t: "m", mod: "bell", msg: {} }));
  expect((await answer).text).toContain("(1 matching entities)");
  expect(Date.now() - started).toBeLessThan(3000);
}, 30_000);

test("perf shows how long a player waited to join and which mods held them up", async () => {
  player.send(JSON.stringify({ t: "loaded", firstFrameMs: 27470, modsMs: 27124, slowestMods: { factory: 9206 }, screen: "1280x720" }));
  await Bun.sleep(100);
  expect((await json("perf")).joins.builder).toEqual({ firstFrameMs: 27470, slowestMods: { factory: 9206 } });
});

test("a name is someone's only while they or their Claude are on; from another computer the host lets it in, and the old key stops working and its game goes back to the join screen", async () => {
  const joinAs = (name: string) => fetch(`${BASE}/api/join`, { method: "POST", body: JSON.stringify({ invite: "test-invite", name }) });
  const first = (await (await joinAs("roamer")).json()).key;
  const laptop = new WebSocket(`ws://127.0.0.1:${PORT}/ws?key=${first}`);
  await new Promise((resolve) => (laptop.onopen = resolve));
  const refused = await joinAs("roamer");
  expect(refused.status).toBe(409);
  expect((await refused.json()).error).toBe("Someone is playing as that name right now. If it's you, close the game there first.");
  laptop.close();
  await new Promise((resolve) => (laptop.onclose = resolve));

  // The laptop's Claude still waits for chat under the name.
  const form = new FormData();
  form.append("seconds", "30");
  const listening = new AbortController();
  const waiting = fetch(`${BASE}/cli/wait_for_chat`, { method: "POST", headers: { authorization: `Bearer ${first}` }, body: form, signal: listening.signal }).catch(() => null);
  await Bun.sleep(300);
  expect((await joinAs("roamer")).status).toBe(409);
  listening.abort();
  await waiting;
  await Bun.sleep(100);

  const hostless = await joinAs("roamer");
  expect([hostless.status, (await hostless.json()).error]).toEqual([409, "The host isn't in the game to let you in as roamer. Pick another name."]);

  const { key: bossKey } = await (await fetch(`${BASE}/api/join`, { method: "POST", body: JSON.stringify({ invite: "test-invite", name: "boss", host: "test-host" }) })).json();
  const host = new WebSocket(`ws://127.0.0.1:${PORT}/ws?key=${bossKey}`);
  const asked: { id: string; name: string }[] = [];
  host.onmessage = ({ data }) => {
    const msg = JSON.parse(String(data));
    if (msg.t === "let-in") asked.push(msg);
  };
  await new Promise((resolve) => (host.onopen = resolve));
  const answer = async (allow: boolean) => {
    const pending = joinAs("roamer");
    while (!asked.length) await Bun.sleep(20);
    const { id, name } = asked.shift()!;
    expect(name).toBe("roamer");
    host.send(JSON.stringify({ t: "let-in", id, allow }));
    return pending;
  };
  const turnedAway = await answer(false);
  expect([turnedAway.status, (await turnedAway.json()).error]).toEqual([409, "The host didn't let you in as roamer. Pick another name."]);
  expect((await (await fetch(`${BASE}/api/join`, { method: "POST", body: JSON.stringify({ key: first }) })).json()).name).toBe("roamer");

  const phone = await (await answer(true)).json();
  host.close();
  expect(phone.name).toBe("roamer");
  expect(phone.key).not.toBe(first);
  const status = await fetch(`${BASE}/cli/status`, { method: "POST", headers: { authorization: `Bearer ${first}` } });
  expect(status.status).toBe(401);
  const stale = new WebSocket(`ws://127.0.0.1:${PORT}/ws?key=${first}`);
  const closed = await new Promise<CloseEvent>((resolve) => (stale.onclose = resolve));
  expect([closed.code, closed.reason]).toEqual([4001, "You joined from another device"]);
});

test("a mod that takes over half a second to start is named in the feed once per version", async () => {
  const loaded = JSON.stringify({ t: "loaded", firstFrameMs: 900, modsMs: 3000, slowestMods: { bell: 2400, factory: 9206 }, screen: "1280x720" });
  player.send(loaded);
  player.send(loaded);
  await Bun.sleep(200);
  expect(received.filter((m) => m.t === "feed" && m.text.includes("to start")).map((m) => m.text)).toEqual(["bell took 2.4 s to start in builder's game"]);
});

test("a mod's author can't vote on it, so alone online they can't undo it", async () => {
  player.send(JSON.stringify({ t: "react", mod: "bell", kind: "undo" }));
  player.send(JSON.stringify({ t: "react", mod: "bell", kind: "love" }));
  await Bun.sleep(300);
  const status = await (await fetch(`${BASE}/api/status`, { headers: { authorization: `Bearer ${key}` } })).json();
  expect(status.mods.find((m: any) => m.name === "bell")).toMatchObject({ author: "builder", love: 0, undo: 0 });
});

test("a mod that takes 16 ms or more of every frame for 10 s is named in the feed once", async () => {
  const report = (bell: number) => player.send(JSON.stringify({ t: "perf", at: 0, modsMsPerFrame: { bell } }));
  const named = () => received.filter((m) => m.t === "feed" && m.text.includes("of every frame")).map((m) => m.text);
  for (const ms of [30, 30, 30, 2, 30, 30, 30, 30]) report(ms);
  await Bun.sleep(200);
  expect(named()).toEqual([]);
  report(24);
  report(24);
  await Bun.sleep(200);
  expect(named()).toEqual(["bell takes 24 ms of every frame in builder's game"]);
});
