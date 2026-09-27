// Games inside one world: each in its own process with its own save, players switching between them over real websockets.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const dir = mkdtempSync(join(tmpdir(), "sandbox-games-"));
const PORT = 20000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const IDLE_MS = 2500;
let world: Subprocess;

type Player = { key: string; ws: WebSocket; got: any[] };
const players: Record<string, Player> = {};

async function startWorld() {
  world = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], {
    env: { ...process.env, SANDBOX_DATA: dir, PORT: String(PORT), SANDBOX_GAME_IDLE_MS: String(IDLE_MS) },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let i = 0; !(await fetch(`${BASE}/api/info`).then((r) => r.ok, () => false)); i++) {
    if (i > 300) throw new Error("the world didn't answer within 30 s of starting");
    await Bun.sleep(100);
  }
}

async function connect(name: string) {
  const known = players[name]?.key;
  const { key } = await (await fetch(`${BASE}/api/join`, { method: "POST", body: JSON.stringify(known ? { key: known } : { invite: "test-invite", name }) })).json();
  const got: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?key=${key}`);
  ws.onmessage = ({ data }) => got.push(JSON.parse(String(data)));
  await new Promise((resolve) => (ws.onopen = resolve));
  players[name] = { key, ws, got };
  await until(() => got.some((m) => m.t === "welcome"));
}

beforeAll(async () => {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name: "Test", rules: "open", start: "basics", invite: "test-invite", hostKey: "test-host" }));
  await startWorld();
  await connect("ada");
  await connect("bo");
}, 30_000);

afterAll(async () => {
  for (const p of Object.values(players)) p.ws.close();
  world?.kill();
  await world?.exited;
  rmSync(dir, { recursive: true, force: true });
});

async function until(ok: () => unknown, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${ok}`);
    await Bun.sleep(50);
  }
}

async function tool(name: string, args: Record<string, unknown> = {}, who = "ada") {
  const form = new FormData();
  for (const [k, v] of Object.entries(args)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
  const res = await fetch(`${BASE}/cli/${name}`, { method: "POST", headers: { authorization: `Bearer ${players[who]!.key}` }, body: form });
  return { status: res.status, text: await res.text() };
}
const json = async (name: string, args: Record<string, unknown> = {}, who = "ada") => JSON.parse((await tool(name, args, who)).text.split("\n\n")[0]!);
const write = (path: string, content: string) => tool("write_file", { path, content });
const rewrite = async (path: string, content: string) => tool("write_file", { path, content, base_hash: (await tool("read_file", { path })).text.match(/^hash: (\w+)/)![1]! });
const reload = async (mod: string) => expect((await tool("reload", { mod })).text).toStartWith(`${mod} v`);
const serverMod = (body: string) => `import type { ServerMod } from "../../api";\nexport default ${body} satisfies ServerMod;`;
const found = async (components: string[], game?: string, who = "ada") => {
  const text = (await tool("query_world", { components, ...(game === undefined ? {} : { game }) }, who)).text;
  return Object.values(JSON.parse(text.split("\n(")[0]!)) as any[];
};
const game = async (id: string) => (await json("list_games")).find((g: any) => g.id === id);

/** Sends the switch and waits until the new game's first tick reached the player. */
async function enter(who: string, to: string | null) {
  const p = players[who]!;
  const from = p.got.length;
  p.ws.send(JSON.stringify({ t: "enterGame", game: to }));
  await until(() => p.got.slice(from).some((m) => m.t === "gameSwitch" && m.game === to && m.phase === "done"));
}
/** Entities a player's game was sent, by id, folding in every tick since `from`. */
function seen(who: string) {
  const all = new Map<number, any>();
  for (const m of players[who]!.got.filter((m) => m.t === "tick")) {
    if (m.reset) all.clear();
    for (const [id, e] of Object.entries(m.set)) all.set(+id, { ...all.get(+id), ...(e as object) });
    for (const id of m.removed) all.delete(id);
  }
  return [...all.values()];
}
const everSent = (who: string, component: string) => players[who]!.got.some((m) => m.t === "tick" && Object.values(m.set).some((e: any) => component in e));
/** Waits until a game runs in a new process that loaded its mods and ticks for `who` again; a crashed game waits a moment before it restarts. */
async function restarted(id: string, before: number, who = "ada") {
  await until(async () => {
    const g = await game(id);
    return g.running && g.pid && g.pid !== before;
  });
  const from = players[who]!.got.length;
  await until(() => players[who]!.got.slice(from).some((m) => m.t === "tick"));
}

test("games are created, edited and listed through the tools, and a bad card or a mod naming no game is refused", async () => {
  expect((await tool("create_game", { id: "alpha", title: "Alpha", tagline: "The first", color: "#1d6b4f" })).status).toBe(200);
  expect((await tool("create_game", { id: "alpha", title: "Again", tagline: "", color: "#000" })).text).toContain("already a game alpha");
  expect((await tool("create_game", { id: "Beta!", title: "Beta", tagline: "", color: "#000" })).status).toBe(422);
  expect((await tool("create_game", { id: "beta", title: "Beta", tagline: "", color: "red; background: url(x)" })).status).toBe(422);
  expect((await tool("create_game", { id: "beta", title: "Beta", tagline: "The second", color: "#335", order: 2 })).status).toBe(200);
  expect((await tool("edit_game", { id: "alpha", status: "live", spawn: [5, 1, 5] })).status).toBe(200);
  const alpha = await game("alpha");
  expect(alpha).toMatchObject({ title: "Alpha", status: "live", spawn: [5, 1, 5], createdBy: "ada", mods: [], players: [], running: false });
  expect((await game("beta")).status).toBe("building");
  await until(() => players.bo!.got.some((m) => m.t === "games" && m.games.some((g: any) => g.id === "alpha" && g.status === "live")));
  expect(players.bo!.got.some((m) => m.t === "feed" && m.text === "ada's agent created the game Alpha")).toBe(true);

  await write("mods/stray/server.ts", serverMod(`{ game: "nowhere", tick() {} }`));
  const stray = await tool("reload", { mod: "stray" });
  expect(stray.status).toBe(422);
  expect(stray.text).toContain("names the game nowhere, which doesn't exist");
  await write("mods/split/server.ts", serverMod(`{ game: "alpha" }`));
  await write("mods/split/client.ts", `export default { game: "beta" };`);
  expect((await tool("reload", { mod: "split" })).text).toContain("name different games");
}, 30_000);

test("each game runs in its own process, and a player in one never gets another game's entities or client mods", async () => {
  await write(
    "mods/alpha-world/server.ts",
    serverMod(`{
  game: "alpha",
  load(world) { if (!world.query("alphaThing").length) world.spawn({ alphaThing: true, pos: [0, 0, 0] }); },
  tick(world) { for (const [, e] of world.query("alphaThing")) { e.count = world.playersInGame().size; e.players = world.players.size; } },
  enterGame(world, player) { world.spawn({ entered: player.id, game: player.game }); },
  exitGame(world, player) { for (const [id, e] of world.query("entered")) if (e.entered === player.id) world.remove(id); },
}`),
  );
  await write("mods/alpha-world/client.ts", `export default { game: "alpha", init() {} };`);
  await write("mods/beta-world/server.ts", serverMod(`{ game: "beta", tick(world) { const [c] = world.query("betaThing"); if (c) c[1].n++; else world.spawn({ betaThing: true, n: 0 }); } }`));
  await write("mods/beta-world/client.ts", `export default { game: "beta", init() {} };`);
  await reload("alpha-world");
  await reload("beta-world");
  expect((await game("alpha")).mods).toEqual(["alpha-world"]);

  await enter("ada", "alpha");
  await enter("bo", "beta");
  const [alpha, beta] = [await game("alpha"), await game("beta")];
  expect(alpha).toMatchObject({ running: true, players: ["ada"] });
  expect(beta).toMatchObject({ running: true, players: ["bo"] });
  expect(new Set([alpha.pid, beta.pid, world.pid]).size).toBe(3);

  await until(() => seen("ada").some((e) => e.alphaThing && e.count === 1));
  expect(seen("ada").find((e) => e.alphaThing)).toMatchObject({ count: 1, players: 1 });
  expect(seen("ada").find((e) => e.entered)).toMatchObject({ entered: "ada", game: "alpha" });
  expect(everSent("ada", "betaThing")).toBe(false);
  expect(everSent("bo", "alphaThing")).toBe(false);
  const loaded = (who: string) => players[who]!.got.flatMap((m) => (m.t === "gameSwitch" && m.mods ? m.mods.map((x: any) => x.name) : m.t === "mod" && m.url ? [m.name] : []));
  expect(loaded("ada")).toContain("alpha-world");
  expect(loaded("ada")).not.toContain("beta-world");
  expect(loaded("bo")).not.toContain("alpha-world");
  expect(players.ada!.got.findLast((m) => m.t === "games").mods).toEqual({ alpha: 1, beta: 1 });

  // Each game's tick times, apart from the hub's.
  await until(async () => (await json("perf")).games.beta?.msPerTick >= 0);
  const { server, games } = await json("perf");
  expect(Object.keys(games).sort()).toEqual(["alpha", "beta"]);
  expect(games.beta.modTicks["beta-world"]).toBeDefined();
  expect(server.modTicks["beta-world"]).toBeUndefined();
}, 60_000);

test("a mod that freezes its game stalls only that game, which restarts without it while the world and other games keep ticking", async () => {
  await write("mods/alpha-freeze/server.ts", serverMod(`{ game: "alpha", message() { while (true); } }`));
  await reload("alpha-freeze");
  const before = (await game("alpha")).pid;
  const betaCount = () => seen("bo").find((e) => e.betaThing)?.n ?? -1;
  players.ada!.ws.send(JSON.stringify({ t: "m", mod: "alpha-freeze", msg: {} }));
  // Alpha is frozen once no tick of it reaches ada for a while; only a real stretch of time shows a silence.
  await until(async () => {
    const n = players.ada!.got.length;
    await Bun.sleep(300);
    return !players.ada!.got.slice(n).some((m) => m.t === "tick");
  });
  const unloaded = () => players.ada!.got.some((m) => m.t === "feed" && m.text.startsWith("alpha-freeze was unloaded"));
  const during = betaCount();
  const started = performance.now();
  expect((await fetch(`${BASE}/api/info`)).ok).toBe(true);
  // Well under the 2 s a frozen world would take.
  expect(performance.now() - started).toBeLessThan(1000);
  await until(() => betaCount() > during + 10);
  expect(unloaded()).toBe(false);
  await until(unloaded);
  const after = await game("alpha");
  expect(after.running).toBe(true);
  expect(after.pid).not.toBe(before);
  expect(after.mods).not.toContain("alpha-freeze");
  // The restarted game still has its player, who keeps getting ticks.
  await restarted("alpha", before);
}, 30_000);

test("a mod that crashes its game's process is blamed and unloaded, and the game restarts with its players", async () => {
  await write("mods/alpha-crash/server.ts", serverMod(`{ game: "alpha", message() { process.exit(3); } }`));
  await reload("alpha-crash");
  const before = (await game("alpha")).pid;
  players.ada!.ws.send(JSON.stringify({ t: "m", mod: "alpha-crash", msg: {} }));
  await until(() => players.ada!.got.some((m) => m.t === "feed" && m.text.startsWith("alpha-crash was unloaded")));
  await restarted("alpha", before);
  expect((await game("alpha")).players).toEqual(["ada"]);
  expect(seen("bo").some((e) => e.betaThing)).toBe(true);
}, 30_000);

test("a game's process that crashes with no mod running, within a minute of a reload, restarts without that reload", async () => {
  await write("mods/alpha-late/server.ts", serverMod(`{ game: "alpha", message() { setTimeout(() => process.exit(4), 0); } }`));
  await reload("alpha-late");
  const before = (await game("alpha")).pid;
  players.ada!.ws.send(JSON.stringify({ t: "m", mod: "alpha-late", msg: {} }));
  await until(() => players.ada!.got.some((m) => m.t === "feed" && m.text.startsWith("alpha-late was unloaded") && m.text.includes("within a minute of this reload")));
  await restarted("alpha", before);
  expect((await game("alpha")).mods).not.toContain("alpha-late");
}, 30_000);

test("switching runs exitGame and enterGame, and a player comes back to where they left a game", async () => {
  // First entry landed ada at alpha's spawn.
  const avatar = async (g: string) => (await found(["player", "pos"], g)).find((e) => e.player === "ada");
  const first = await avatar("alpha");
  expect(first.pos[0]).toBeCloseTo(5, 0);
  expect(first.pos[2]).toBeCloseTo(5, 0);

  // Input is resent until the avatar shows it: the game may still be loading its mods after the restarts above.
  const move = (x: number, done: (e: any) => boolean) =>
    until(async () => {
      players.ada!.ws.send(JSON.stringify({ t: "m", mod: "basics", msg: { x, z: 0 } }));
      return done(await avatar("alpha"));
    });
  await move(1, (e) => e.pos[0] > 6.5);
  await move(0, (e) => e.vel[0] === 0);
  const left = (await avatar("alpha")).pos;
  expect(left[0]).toBeGreaterThan(6);

  await enter("ada", null);
  // The hub's first tick can reach ada before alpha's tick that ran exitGame reaches the world.
  await until(async () => !(await found(["entered"], "alpha")).length && !(await avatar("alpha")));
  expect(await avatar("")).toBeDefined();
  expect(players.ada!.got.findLast((m) => m.t === "games").seats).toContainEqual({ player: "ada", name: "ada", game: null, online: true });

  await enter("ada", "alpha");
  const back = (await avatar("alpha")).pos;
  expect(back[0]).toBeCloseTo(left[0], 0);
  expect(back[2]).toBeCloseTo(left[2], 0);
  expect(await found(["entered"], "alpha")).toHaveLength(1);

  // A mod moves a player with world.enter.
  await write("mods/portal/server.ts", serverMod(`{ message(world, player, msg) { world.enter(player.id, msg.to); } }`));
  await reload("portal");
  const from = players.ada!.got.length;
  players.ada!.ws.send(JSON.stringify({ t: "m", mod: "portal", msg: { to: "beta" } }));
  await until(() => players.ada!.got.slice(from).some((m) => m.t === "gameSwitch" && m.game === "beta" && m.phase === "done"));
  expect((await game("beta")).players.sort()).toEqual(["ada", "bo"]);
  expect((await tool("delete_game", { id: "beta" })).text).toContain("Live mods name the game beta: beta-world");
  await enter("ada", "alpha");
}, 30_000);

test("a game nobody is in saves and stops after a while, and comes back from its save", async () => {
  const count = async () => (await found(["betaThing"], "beta"))[0]?.n as number;
  await enter("bo", null);
  expect((await game("beta")).running).toBe(true);
  await until(async () => !(await game("beta")).running, IDLE_MS + 5000);
  const saved = await count();
  expect(saved).toBeGreaterThan(20);
  // A stopped game stays still, which only a stretch of real time shows.
  await Bun.sleep(500);
  expect(await count()).toBe(saved);

  await enter("bo", "beta");
  expect((await game("beta")).running).toBe(true);
  await until(async () => (await count()) > saved);
}, 30_000);

/** What alpha-hunter counted: each player's bodies it hunted, tick by tick, the players it saw, and each player's messages it heard. */
const tally = async () => (await found(["hunted"], "alpha"))[0] as { hunted: Record<string, number>; players: string[]; heard: Record<string, number> };
const bodiesIn = async (g: string) => (await found(["player"], g)).map((e) => e.player as string);

test("a player who switches games leaves no body in the old one, whose mods never see or hear them again", async () => {
  // A movement mod that never cleans up after its players, so only the engine can.
  await rewrite("mods/basics/server.ts", serverMod(`{ join(world, player) { world.spawn({ player: player.id, pos: [0, 1, 0] }); } }`));
  await reload("basics");
  await write(
    "mods/alpha-hunter/server.ts",
    serverMod(`{
  game: "alpha",
  load(world) { if (!world.query("hunted").length) world.spawn({ hunted: {}, players: [], heard: {} }); },
  enterGame(world, player) { world.spawn({ player: player.id, mount: true }); },
  tick(world) {
    const [[, t]] = world.query("hunted");
    for (const [, e] of world.query("player")) t.hunted[e.player] = (t.hunted[e.player] ?? 0) + 1;
    t.players = [...world.players.keys()].sort();
  },
  message(world, player) { const [[, t]] = world.query("hunted"); t.heard[player.id] = (t.heard[player.id] ?? 0) + 1; },
}`),
  );
  await reload("alpha-hunter");
  await enter("bo", "alpha");
  await enter("ada", null);
  await enter("ada", "alpha");
  await until(async () => (await tally()).hunted.ada > 0 && (await tally()).players.includes("ada"));

  // Input sent right behind the switch goes to the new game, never the old one.
  const from = players.ada!.got.length;
  players.ada!.ws.send(JSON.stringify({ t: "enterGame", game: "beta" }));
  for (let i = 0; i < 5; i++) players.ada!.ws.send(JSON.stringify({ t: "m", mod: "alpha-hunter", msg: {} }));
  await until(() => players.ada!.got.slice(from).some((m) => m.t === "gameSwitch" && m.game === "beta" && m.phase === "done"));
  await until(async () => !(await bodiesIn("alpha")).includes("ada"), 3000);
  const left = await tally();
  await until(async () => (await tally()).hunted.bo! > left.hunted.bo! + 20);
  const after = await tally();
  expect(after.hunted.ada).toBe(left.hunted.ada);
  expect(after.players).toEqual(["bo"]);
  expect(after.heard.ada).toBeUndefined();
}, 30_000);

test("a game that crashes as a player leaves restarts without their body", async () => {
  await write("mods/alpha-trap/server.ts", serverMod(`{ game: "alpha", exitGame(world, player) { if (player.id === "bo") process.exit(7); } }`));
  await reload("alpha-trap");
  await enter("ada", "alpha");
  expect(await bodiesIn("alpha")).toContain("bo");
  const before = (await game("alpha")).pid;
  // Alpha's process dies in bo's exitGame, before it removes anything of theirs.
  await enter("bo", null);
  await restarted("alpha", before);
  expect((await game("alpha")).players).toEqual(["ada"]);
  expect(await bodiesIn("alpha")).not.toContain("bo");
  const left = await tally();
  await until(async () => (await tally()).hunted.ada! > left.hunted.ada! + 20);
  expect((await tally()).hunted.bo).toBe(left.hunted.bo);
}, 30_000);

test("a game that crashes again soon after restarting waits out its backoff, whatever reaches it meanwhile", async () => {
  await write("mods/alpha-crash-a/server.ts", serverMod(`{ game: "alpha", message() { process.exit(8); } }`));
  await write("mods/alpha-crash-b/server.ts", serverMod(`{ game: "alpha", message() { process.exit(9); } }`));
  await reload("alpha-crash-a");
  await reload("alpha-crash-b");
  const first = (await game("alpha")).pid;
  players.ada!.ws.send(JSON.stringify({ t: "m", mod: "alpha-crash-a", msg: {} }));
  await restarted("alpha", first);
  const second = (await game("alpha")).pid;
  // Crashing within seconds of its start, alpha waits a moment before its next process, though ada's input keeps coming.
  players.ada!.ws.send(JSON.stringify({ t: "m", mod: "alpha-crash-b", msg: {} }));
  let crashed = 0;
  let back = 0;
  await until(async () => {
    players.ada!.ws.send(JSON.stringify({ t: "m", mod: "alpha-hunter", msg: {} }));
    if (!crashed && players.ada!.got.some((m) => m.t === "feed" && m.text.startsWith("alpha-crash-b was unloaded"))) crashed = performance.now();
    const g = await game("alpha");
    if (g.pid && g.pid !== second) back = performance.now();
    return back;
  });
  expect(crashed).toBeGreaterThan(0);
  expect(back - crashed).toBeGreaterThan(600);
  await enter("bo", "beta");
}, 30_000);

test("a restarted world puts every player back in their game, and nobody else", async () => {
  // cy is in alpha when the world stops, so alpha's save holds cy's body, but cy never comes back.
  await connect("cy");
  await enter("cy", "alpha");
  await until(async () => (await bodiesIn("alpha")).includes("cy"));
  world.kill("SIGTERM");
  await world.exited;
  for (const p of Object.values(players)) p.ws.close();
  await startWorld();
  await connect("ada");
  expect(players.ada!.got.find((m) => m.t === "welcome")).toMatchObject({ game: "alpha" });
  expect(players.ada!.got.find((m) => m.t === "welcome").mods.map((m: any) => m.name)).toContain("alpha-world");
  await until(() => seen("ada").some((e) => e.alphaThing));
  expect(await game("alpha")).toMatchObject({ running: true, players: ["ada"] });
  // Alpha woke from a save with cy's body and ada's old one: only the body ada got on joining is left.
  expect((await found(["player"], "alpha")).filter((e) => !e.mount).map((e) => e.player)).toEqual(["ada"]);

  // Deleting a game no mod names sends its players back to the hub.
  await rewrite("mods/beta-world/server.ts", serverMod(`{ tick() {} }`));
  await rewrite("mods/beta-world/client.ts", `export default { init() {} };`);
  await reload("beta-world");
  await connect("bo");
  expect(players.bo!.got.find((m) => m.t === "welcome")).toMatchObject({ game: "beta" });
  expect((await tool("delete_game", { id: "beta" })).text).toStartWith("Deleted the game beta");
  await until(() => players.bo!.got.some((m) => m.t === "gameSwitch" && m.game === null && m.phase === "done"));
  expect((await json("list_games")).map((g: any) => g.id)).toEqual(["alpha"]);
}, 60_000);
