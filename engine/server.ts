import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { frontFile } from "./front";
import { createCli, joinCodes, joinCommand, joinScript, type Task } from "./cli";
import { ENGINE_KEYS, hasGit, Mods } from "./mods";
import { latencies, openRecord, route } from "./record";
import { Sims } from "./sims";
import type { Perf } from "./simhost";
import { freeVoice, savedVoice, speak, transcribe, type Voice } from "./voice";
import { openStore, type Activity, type Tick } from "./world";

const ENGINE = import.meta.dir;
const DATA = process.env.SANDBOX_DATA ?? join(ENGINE, "../data");
const ROOT = join(DATA, "world");
const BUILD = join(DATA, "build");
const SPEECH = join(DATA, "speech");
const DB = join(DATA, "db");
const PORT = Number(process.env.PORT ?? 7777);

export type Config = { name: string; rules: "open" | "additive"; start: "basics" | "hills" | "blank"; invite: string; hostKey: string; host?: string; password?: string; agents?: false };
type Conn = { name: string; ua: string; at: number; spectator?: true };

const token = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const readJson = <T>(file: string, fallback: T): T => (existsSync(join(DATA, file)) ? JSON.parse(readFileSync(join(DATA, file), "utf8")) : fallback);
const writeJson = (file: string, value: unknown) => writeFileSync(join(DATA, file), JSON.stringify(value, null, 2));

mkdirSync(DB, { recursive: true });
const config = readJson<Config>("config.json", { name: "Sandbox", rules: "open", start: "basics", invite: token(), hostKey: token() });
writeJson("config.json", config);
const keys = readJson<Record<string, string>>("keys.json", {});
const owners = readJson<Record<string, string>>("owners.json", {});
const nameByKey = (key: string | null) => (key ? keys[key] : undefined);

const STARTS: Record<Config["start"], string[]> = { basics: ["basics"], hills: ["basics", "hills"], blank: [] };
if (!existsSync(ROOT)) {
  mkdirSync(join(ROOT, "mods"), { recursive: true });
  for (const mod in owners) delete owners[mod];
  for (const mod of STARTS[config.start]) {
    cpSync(join(ENGINE, "seed/mods", mod), join(ROOT, "mods", mod), { recursive: true });
    owners[mod] = "world";
  }
  writeJson("owners.json", owners);
}
const newHistory = hasGit && !existsSync(join(ROOT, ".git"));
if (newHistory) {
  Bun.spawnSync(["git", "init", "-q"], { cwd: ROOT });
  Bun.spawnSync(["git", "config", "user.name", "sandbox"], { cwd: ROOT });
  Bun.spawnSync(["git", "config", "user.email", "sandbox@sandbox"], { cwd: ROOT });
}
// Seed mods nobody has edited follow engine updates; edited ones are left alone.
const seeded = readJson<Record<string, string>>("seeded.json", {});
const refreshed = new Set<string>();
const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
for (const file of new Bun.Glob("mods/**/*").scanSync(join(ENGINE, "seed"))) {
  const seed = readFileSync(join(ENGINE, "seed", file), "utf8");
  const target = join(ROOT, file);
  const current = existsSync(target) ? sha(readFileSync(target, "utf8")) : null;
  if (current && current === seeded[file] && current !== sha(seed)) {
    writeFileSync(target, seed);
    refreshed.add(file.split(/[\\/]/)[1]!);
  }
  if (existsSync(target) && sha(readFileSync(target, "utf8")) === sha(seed)) seeded[file] = sha(seed);
}
writeJson("seeded.json", seeded);
cpSync(join(ENGINE, "api.ts"), join(ROOT, "api.ts"));
writeFileSync(join(ROOT, ".gitignore"), "node_modules\n");
if (!existsSync(join(ROOT, "package.json"))) writeFileSync(join(ROOT, "package.json"), JSON.stringify({ private: true }, null, 2));
// An imported world comes without the packages its mods added; its lockfile brings back the same ones, so mods that use them reload.
if (existsSync(join(ROOT, "bun.lock")) && !existsSync(join(ROOT, "node_modules"))) Bun.spawnSync([process.execPath, "install"], { cwd: ROOT, env: { ...process.env, BUN_BE_BUN: "1" } });
cpSync(join(ENGINE, "GUIDE.md"), join(ROOT, "GUIDE.md"));
writeFileSync(
  join(ROOT, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        lib: ["ESNext", "DOM"],
        target: "ESNext",
        module: "Preserve",
        moduleResolution: "bundler",
        moduleDetection: "force",
        allowImportingTsExtensions: true,
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        typeRoots: [join(ENGINE, "../node_modules/@types")],
        types: ["bun"],
        paths: {
          "three": [join(ENGINE, "../node_modules/@types/three")],
          "three/addons/*": [join(ENGINE, "../node_modules/@types/three/examples/jsm/*")],
          "three/*": [join(ENGINE, "../node_modules/@types/three/*")],
        },
      },
      include: ["**/*.ts"],
    },
    null,
    2,
  ),
);
// Mods are committed when they go live, so the history keeps each as it was last accepted; a start commits only the files the engine writes, and only when they changed.
if (hasGit) {
  const engineFiles = newHistory ? ["."] : ["api.ts", "GUIDE.md", "tsconfig.json", ".gitignore", "package.json"];
  Bun.spawnSync(["git", "add", "--", ...engineFiles], { cwd: ROOT });
  Bun.spawnSync(["git", "commit", "-qm", newHistory ? "new world" : "engine update", "--", ...engineFiles], { cwd: ROOT, stdout: "ignore" });
}

const record = openRecord(join(DATA, "record.sqlite"));
const logs: { at: number; mod: string; level: string; text: string; player?: string }[] = [];
const clientPerf = new Map<string, { at: number } & Record<string, unknown>>();
/** Each player's last join: ms until their first frame and the mods that took longest to start. */
const joins = new Map<string, { firstFrameMs: number; slowestMods: Record<string, number> }>();
/** Mod versions already named in the feed for a slow start or slow frames, so each is named once. */
const slowNamed = new Set<string>();
function nameSlow(mod: string, what: "start" | "frames", text: string) {
  const live = mods.running.get(mod);
  const key = `${mod} v${live?.version} ${what}`;
  if (!live || slowNamed.has(key)) return;
  slowNamed.add(key);
  feed(text);
}
/** Per player, the mods that took 16 ms or more of each frame, with how many 2 s reports in a row they have. */
const slowFrames = new Map<string, Record<string, number>>();
const feedLog: { at: number; text: string; kind: string }[] = [];
const chatLog: { seq: number; from: string; text: string; spoken?: boolean; claudes?: boolean; game?: string }[] = [];
const chatWaiters = new Set<() => void>();
let chatSeq = 0;
/** Feed lines, chat and banners since the last timelapse moment. */
let happened: Activity[] = [];
/** Lines to "claudes" reach only other Claudes' tool results and the Builders tab, never the players' chat. A player's line carries the title of the game they said it in. */
function chat(from: string, text: string, how?: "spoken" | "claudes") {
  const spoken = how === "spoken" || undefined;
  const claudes = how === "claudes" || undefined;
  const gameId = sockets.has(from) ? sims.gameOf(from) : null;
  const game = (gameId && sims.games.get(gameId)?.title) || undefined;
  chatLog.push({ seq: ++chatSeq, from, text, spoken, claudes, game });
  record.add("chat", from, { text, how, game });
  if (!claudes) happened.push({ at: Date.now(), t: "chat", from, text: text.slice(0, 200), spoken, game });
  console.log(`[chat] ${claudes ? "[claudes] " : ""}${game ? `[${game}] ` : ""}${from}${spoken ? " (voice)" : ""}: ${text}`);
  if (chatLog.length > 2000) chatLog.shift();
  broadcast(claudes ? { t: "talk", from, text } : { t: "chat", from, text, spoken, game });
  for (const wake of chatWaiters) wake();
}
const sockets = new Map<string, ServerWebSocket<Conn>>();
/** Visitors with an invite watching the world live behind the join screen: no player, unseen and read-only. */
const spectators = new Map<string, ServerWebSocket<Conn>>();

/** Players' verdicts on the live version of each mod; more than half of those online voting undo reverts it. The author's own votes don't count. */
const votes = new Map<string, { version: number; love: Set<string>; undo: Set<string> }>();
function react(from: string, mod: string, kind: string) {
  const live = mods.running.get(mod);
  if (!live || from === live.author || (kind !== "love" && kind !== "undo")) return;
  let v = votes.get(mod);
  if (v?.version !== live.version) votes.set(mod, (v = { version: live.version, love: new Set(), undo: new Set() }));
  if (v[kind].has(from)) return;
  v[kind].add(from);
  v[kind === "love" ? "undo" : "love"].delete(from);
  const needed = Math.floor(sockets.size / 2) + 1;
  record.add("action", from, { what: "vote", mod, kind, version: live.version });
  broadcast({ t: "votes", mod, love: v.love.size, undo: v.undo.size, needed });
  chat("game", kind === "love" ? `${from} loves ${mod} by ${live.author}` : `${from} votes to undo ${mod} by ${live.author} (${v.undo.size}/${needed})`);
  if (v.undo.size < needed) return;
  votes.delete(mod);
  mods.revert(mod, `the players voted it out`);
}

/** Whether each player's Claude is waiting on the chat, busy, or gone, so players know if anyone hears them. */
type Presence = "listening" | "working" | "offline";
const claudes = new Map<string, { state: Presence; at: number; task?: Task }>();
const builder = (name: string) => ({ state: claudes.get(name)?.state ?? "offline", task: claudes.get(name)?.task });
function presence(name: string, state: Presence) {
  const changed = claudes.get(name)?.state !== state;
  claudes.set(name, { ...claudes.get(name), state, at: Date.now() });
  if (!changed) return;
  broadcast({ t: "claude", name, ...builder(name) });
  record.add("claude", name, { state });
}
function setTask(name: string, task: Task) {
  claudes.set(name, { state: "working", ...claudes.get(name), at: Date.now(), task });
  broadcast({ t: "claude", name, ...builder(name) });
}

/** What each mod is, from the last banner its builder gave it. */
const about = readJson<Record<string, { title: string; text: string; color: string }>>("about.json", {});
setInterval(() => {
  for (const [name, c] of claudes) if (c.state === "working" && Date.now() - c.at > 120_000) presence(name, "offline");
}, 15_000);
/** Websocket traffic per player since the last server sample. */
const traffic = new Map<string, { outKB: number; out: number; maxKB: number; inKB: number; in: number }>();
function usage(name: string) {
  const t = traffic.get(name) ?? { outKB: 0, out: 0, maxKB: 0, inKB: 0, in: 0 };
  traffic.set(name, t);
  return t;
}
function sent(name: string, text: string) {
  const t = usage(name);
  t.out++;
  t.outKB += text.length / 1024;
  t.maxKB = Math.max(t.maxKB, text.length / 1024);
}
const broadcast = (msg: object) => {
  const text = JSON.stringify(msg);
  for (const [name, ws] of sockets) {
    ws.send(text);
    sent(name, text);
  }
};
/** A mod that logs an error every tick records at most 20 a minute. */
const errorBudget = new Map<string, { minute: number; n: number }>();
function log(mod: string, level: string, text: string, player?: string) {
  logs.push({ at: Date.now(), mod, level, text, player });
  if (logs.length > 1000) logs.shift();
  if (!level.endsWith("error")) return;
  const minute = Math.floor(Date.now() / 60_000);
  const budget = errorBudget.get(mod)?.minute === minute ? errorBudget.get(mod)! : { minute, n: 0 };
  errorBudget.set(mod, budget);
  if (++budget.n <= 20) record.add("error", player ?? null, { mod, level, text: text.slice(0, 500) });
}
function feed(text: string, kind = "info") {
  feedLog.push({ at: Date.now(), text, kind });
  if (feedLog.length > 50) feedLog.shift();
  happened.push({ at: Date.now(), t: "feed", text: text.slice(0, 200), kind });
  broadcast({ t: "feed", text, kind });
  console.log(`[feed] ${text}`);
}

const mods = new Mods(ROOT, BUILD, join(DATA, "mods.json"), {
  // Players in other games get null, which unloads the mod where a move to another game left it behind and does nothing elsewhere.
  client: (name, url, game) => {
    let loaded = false;
    for (const [player, ws] of sockets) {
      const loads = !game || sims.gameOf(player) === game;
      const text = JSON.stringify({ t: "mod", name, url: loads ? url : null });
      ws.send(text);
      sent(player, text);
      loaded ||= loads;
    }
    for (const ws of spectators.values()) ws.send(JSON.stringify({ t: "mod", name, url: game ? null : url }));
    return loaded;
  },
  feed,
  record: record.add,
});
const sims = new Sims(DATA, DB, () => mods.list(), {
  deliver: (id, text) => {
    (sockets.get(id) ?? spectators.get(id))?.send(text, true);
    sent(id, text);
  },
  notify: (id, msg) => sockets.get(id)?.send(JSON.stringify(msg)),
  clientMods: (game) => clientMods(game),
  log,
  fault: (mod, error) => {
    log(mod, "error", error);
    mods.revert(mod, error);
  },
  reloadedJustBefore: (game) => mods.reloadedJustBefore(game),
  hubTick: (diff) => store.track(diff),
  changed: () => broadcast(gamesMessage()),
});
mods.sims = sims;
/** The world's own simulation: every player outside a game, and the whole world when it has no games. */
const hub = sims.hub;
/** The picker's live data: the games, where every player is, and how many live mods each game has. */
function gamesMessage() {
  const counts: Record<string, number> = {};
  for (const m of mods.list()) if (m.game) counts[m.game] = (counts[m.game] ?? 0) + 1;
  return { t: "games", games: sims.games.list(), seats: sims.seatList(), mods: counts };
}

const store = openStore(join(DATA, "world.sqlite"));
store.load(hub);
await mods.loadAll(owners);
// The launcher restarts a world that crashed right after a reload without that reload.
const crashed = process.env.SANDBOX_REVERT;
if (crashed) {
  const why = "the world crashed within a minute of this reload, so it was undone. Its files still have the change: find what crashed the server before reloading it again.";
  log(crashed, "error", why);
  mods.rollBack(crashed, why);
}
hub.start();
if (process.env.SANDBOX_NOTICE) feed(process.env.SANDBOX_NOTICE, "error");
for (const mod of refreshed) await mods.reload(mod, "world", owners[mod] ?? "world");
setInterval(() => store.save(hub), 5000);
store.snapshot(hub);
setInterval(() => store.snapshot(hub), 60_000);
setInterval(() => {
  store.record(hub, happened.slice(-30));
  happened = [];
}, 2000);
/** Reloads from the world's git history, for timelapse moments recorded before activity was stored. */
function olderReloads(): Activity[] {
  if (!hasGit) return [];
  const log = Bun.spawnSync(["git", "log", "--since=3 hours ago", "--format=%at %an|%s"], { cwd: ROOT }).stdout.toString();
  return log.split("\n").flatMap((row) => {
    const [, at, who, subject] = row.match(/^(\d+) (.+?)\|(\S+ v\d+)$/) ?? [];
    return at ? [{ at: Number(at) * 1000, t: "feed" as const, text: `${who} reloaded ${subject}`, kind: "ok" }] : [];
  });
}
const timelapse = new Worker(new URL("./timelapse.ts", import.meta.url));
const jobs = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
let jobSeq = 0;
timelapse.onmessage = ({ data }) => {
  const job = jobs.get(data.id);
  jobs.delete(data.id);
  if (data.error) job?.reject(new Error(data.error));
  else job?.resolve(data);
};
const inWorker = <T>(msg: object) =>
  new Promise<T>((resolve, reject) => {
    const id = ++jobSeq;
    jobs.set(id, { resolve, reject });
    timelapse.postMessage({ ...msg, id });
  });
/** Viewers opening the timelapse within a few seconds of each other share one build. */
let built: { at: number; ticks: Promise<Tick[]> } | null = null;
async function timelapseFor(who: string | null) {
  if (!built || Date.now() - built.at > 10_000) {
    const live = Object.fromEntries([...mods.running].filter(([, m]) => !m.build.game).map(([name, m]) => [name, m.build.client]));
    built = { at: Date.now(), ticks: inWorker<{ ticks: Tick[] }>({ t: "build", path: join(DATA, "world.sqlite"), limit: 900, older: olderReloads(), builds: BUILD, live }).then((r) => r.ticks) };
  }
  const seen = who ? await hub.visibleTo(who, await built.ticks) : await built.ticks;
  return (await inWorker<{ gz: Uint8Array<ArrayBuffer> }>({ t: "encode", ticks: seen })).gz;
}
function shutdown() {
  record.close();
  store.save(hub);
  sims.saveAll();
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown);
// Windows has no SIGTERM to send, so the launcher asks over IPC; a launcher that died without asking closes the channel.
process.on("message", (msg: any) => msg?.t === "stop" && shutdown());
process.on("disconnect", shutdown);

const clientBuild = await Bun.build({ entrypoints: [join(ENGINE, "client/main.ts")], target: "browser", external: ["three", "three/*"] });
if (!clientBuild.success) throw new AggregateError(clientBuild.logs, "client build failed");
const clientJs = await clientBuild.outputs[0]!.text();
const build = Bun.hash(clientJs).toString(36);

const status = () => ({
  world: config.name,
  rules: config.rules === "additive" ? "additive: you can add mods and change your own, never someone else's" : "open: anyone can change any mod",
  online: [...sockets.keys()],
  mods: [...mods.running].map(([name, m]) => {
    const v = votes.get(name)?.version === m.version ? votes.get(name) : undefined;
    return { name, author: m.author, version: m.version, game: m.build.game, server: !!m.build.server, client: !!m.build.client, about: about[name], usedBy: mods.users(name), owns: m.source?.owns.length ? m.source.owns : undefined, love: v?.love.size ?? 0, undo: v?.undo.size ?? 0 };
  }),
  undoNeeded: Math.floor(sockets.size / 2) + 1,
  controls: { engineKeys: sims.games.list().length ? { ...ENGINE_KEYS, KeyG: "the games picker" } : ENGINE_KEYS, ...mods.controls() },
  games: sims.summary().map((g) => ({ id: g.id, title: g.title, status: g.status, mods: g.mods, players: g.players })),
  entities: hub.entities.size,
  recent: feedLog.slice(-15).map((f) => f.text),
  voice: voiceKey() ? "on: what players say arrives as chat" : "off",
});

const perf = () => ({
  server: { ...hub.perf, budget: "a tick is due every 50 ms; mods is each mod's average ms per tick, modTicks its p95 and slowest tick hook over the last 2 s" },
  games: sims.perfByGame(),
  entities: hub.entities.size,
  players: Object.fromEntries([...clientPerf].map(([name, { at, ...p }]) => [name, { ...p, secondsOld: Math.round((Date.now() - at) / 1000) }])),
  joins: Object.fromEntries(joins),
});

/** Every 10 s: simulation tick times, how long the main thread stalled, process CPU and memory, and each player's websocket traffic. */
const http = latencies();
const simWindow: Perf[] = [];
let lastPerf = hub.perf;
/** The same per running game, which ticks in its own process. */
const gameWindows = new Map<string, Perf[]>();
const lastGamePerf = new Map<string, Perf>();
let lagMs = 0;
let lagAt = performance.now();
let cpu = process.cpuUsage();
setInterval(() => {
  const now = performance.now();
  lagMs = Math.max(lagMs, now - lagAt - 100);
  lagAt = now;
  if (hub.perf && hub.perf !== lastPerf) simWindow.push((lastPerf = hub.perf));
  for (const [game, p] of Object.entries(sims.perfByGame())) {
    if (!p || p === lastGamePerf.get(game)) continue;
    lastGamePerf.set(game, p);
    gameWindows.set(game, [...(gameWindows.get(game) ?? []), p]);
  }
}, 100);
const r = (v: number) => Math.round(v * 10) / 10;
/** The worst of a window's tick times. */
const tickTimes = (window: Perf[]) => ({
  avg: r(Math.max(0, ...window.map((p) => p.msPerTick))),
  p50: r(Math.max(0, ...window.map((p) => p.p50))),
  p95: r(Math.max(0, ...window.map((p) => p.p95))),
  max: r(Math.max(0, ...window.map((p) => p.max))),
  engine: r(Math.max(0, ...window.map((p) => p.engine))),
});
setInterval(() => {
  const used = process.cpuUsage(cpu);
  cpu = process.cpuUsage();
  const modMaxMs: Record<string, number> = {};
  for (const p of [...simWindow, ...[...gameWindows.values()].flat()]) for (const [name, t] of Object.entries(p.modTicks)) modMaxMs[name] = Math.max(modMaxMs[name] ?? 0, t.max);
  record.add("server", null, {
    tick: tickTimes(simWindow),
    games: gameWindows.size ? Object.fromEntries([...gameWindows].map(([game, window]) => [game, tickTimes(window)])) : undefined,
    mods: simWindow.at(-1)?.mods,
    modMaxMs,
    lagMs: Math.round(lagMs),
    cpuPct: Math.round((used.user + used.system) / 100_000),
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
    heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
    entities: hub.entities.size,
    online: sockets.size,
    ws: Object.fromEntries([...traffic].map(([name, t]) => [name, { outKB: Math.round(t.outKB), out: t.out, maxKB: r(t.maxKB), inKB: r(t.inKB), in: t.in }])),
    http: http.take(),
  });
  simWindow.length = 0;
  gameWindows.clear();
  lagMs = 0;
  traffic.clear();
}, 10_000);

/** Feed lines wait a moment, so a reload or a tab open for a few seconds says nothing. */
const joiningLine = new Map<string, ReturnType<typeof setTimeout>>();
const leavingLine = new Map<string, ReturnType<typeof setTimeout>>();
/** The world's one invite link, from the launcher, and whether it only works on the host's Wi-Fi because the relay is down. */
let invite = { link: null as string | null, wifiOnly: false };
const codes = joinCodes();
const shots = new Map<string, (data: string) => void>();
const cli = createCli({
  data: DATA,
  root: ROOT,
  dbDir: DB,
  rules: () => config.rules,
  owners,
  saveOwners: () => writeJson("owners.json", owners),
  mods,
  sims,
  logs,
  feed,
  chat,
  chatLog,
  presence,
  setTask,
  announce: (a) => {
    happened.push({ at: Date.now(), t: "announce", ...a });
    about[a.mod] = { title: a.title, text: a.text, color: a.color };
    writeJson("about.json", about);
    broadcast({ t: "announce", ...a, author: mods.running.get(a.mod)?.author });
  },
  nextChat: () => new Promise<void>((resolve) => chatWaiters.add(function wake() { chatWaiters.delete(wake); resolve(); })),
  status,
  perf,
  record,
  screenshot: (who) =>
    new Promise((resolve, reject) => {
      const ws = sockets.get(who);
      if (!ws) return reject(new Error(`${who} doesn't have the game open, so there is nothing to see. Check with query_world and logs instead, or set your task blocked with the status "needs your game open".`));
      const id = crypto.randomUUID();
      const timer = setTimeout(
        () =>
          shots.delete(id) &&
          reject(new Error(`${who}'s game didn't send a picture within 10 s; its computer is busy or the tab is frozen. Check with query_world and logs instead, and try again later.`)),
        10_000,
      );
      shots.set(id, (data) => {
        clearTimeout(timer);
        shots.delete(id);
        resolve(data);
      });
      ws.send(JSON.stringify({ t: "shot", id }));
    }),
  sendToGame: (who, msg) => !!sockets.get(who)?.send(JSON.stringify(msg)),
});

/** The key the host added in the game, else an ElevenLabs one from the environment, which belongs to its EU data-residency stack. */
const ownVoice = (): Voice | null =>
  savedVoice(process.env.SANDBOX_SECRETS) ?? (process.env.ELEVENLABS_API_KEY ? { provider: "ElevenLabs", key: process.env.ELEVENLABS_API_KEY, host: "https://api.eu.residency.elevenlabs.io" } : null);
/** The host's own key wins; without one, free voice. */
const voiceKey = (): Voice | null => ownVoice() ?? freeVoice(process.env.SANDBOX_SECRETS);

/** ctx.speak: each line is made once and served from this world, so every player hearing it costs one call. */
const speaking = new Map<string, Promise<string>>();
async function speech(text: string, speaker: string | undefined) {
  if (!text) throw new Error("Give ctx.speak some text.");
  if (text.length > 2000) throw new Error("ctx.speak takes 2,000 characters at most.");
  if (speaker !== undefined && !/^[A-Za-z0-9]{8,40}$/.test(speaker)) throw new Error("A voice is an ElevenLabs voice id.");
  const id = sha(`${speaker ?? ""}\n${text}`);
  const url = `/speech/${id}.mp3`;
  if (existsSync(join(SPEECH, `${id}.mp3`))) return url;
  if (!speaking.has(id))
    speaking.set(
      id,
      (async () => {
        const own = ownVoice();
        const voice = own?.provider === "ElevenLabs" ? own : freeVoice(process.env.SANDBOX_SECRETS);
        const mp3 = voice && (await speak(voice, text, speaker));
        if (!mp3) throw new Error("Speech needs an ElevenLabs key, or free voice, which this host doesn't have.");
        mkdirSync(SPEECH, { recursive: true });
        writeFileSync(join(SPEECH, `${id}.mp3`), mp3);
        return url;
      })().finally(() => speaking.delete(id)),
    );
  return speaking.get(id)!;
}

/** Joins waiting for the host to answer whether a new computer may play as a name that's already someone's. */
const asking = new Map<string, (allow: boolean) => void>();

/** The player playing on the host's computer, named when players are told who can turn voice on. */
function hostIs(body: { host?: string }, name: string) {
  if (body.host !== config.hostKey || config.host === name) return;
  config.host = name;
  writeJson("config.json", config);
}

/** The client builds a player in this game loads: every shared mod and the game's own. */
const clientMods = (game: string | null) =>
  [...mods.running].filter(([, m]) => m.build.client && (!m.build.game || m.build.game === game)).map(([name, m]) => ({ name, url: m.build.client! }));
const html = (file: string) => new Response(Bun.file(join(ENGINE, "client", file)), { headers: { "content-type": "text/html" } });
const bearer = (req: Request) => req.headers.get("authorization")?.replace(/^Bearer /, "") ?? new URL(req.url).searchParams.get("key");

const server = Bun.serve<Conn>({
  port: PORT,
  idleTimeout: 255,
  fetch: timed(async (req, server) => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/") return html("index.html");
    if (path === "/client.js") return new Response(clientJs, { headers: { "content-type": "text/javascript" } });
    const front = await frontFile(path);
    if (front) return front;
    if (path.startsWith("/vendor/three/")) {
      const file = Bun.file(join(ENGINE, "../node_modules/three", path.slice("/vendor/three/".length).replaceAll("..", "")));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    }
    if (path.startsWith("/assets/")) {
      const [mod, name] = path.slice("/assets/".length).split("/").map(decodeURIComponent);
      const file = Bun.file(join(ROOT, "mods", mod ?? "", "assets", name ?? ""));
      if (![mod, name].every((part) => /^\w[\w.-]*$/.test(part ?? "")) || !(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file);
    }
    if (/^\/speech\/[0-9a-f]{64}\.mp3$/.test(path)) {
      const file = Bun.file(join(SPEECH, path.slice("/speech/".length)));
      return (await file.exists()) ? new Response(file, { headers: { "content-type": "audio/mpeg", "cache-control": "max-age=31536000, immutable" } }) : new Response("not found", { status: 404 });
    }
    if (path.startsWith("/build/")) {
      const file = Bun.file(join(BUILD, path.slice("/build/".length).replaceAll("..", "")));
      return (await file.exists()) ? new Response(file, { headers: { "cache-control": "max-age=31536000, immutable" } }) : new Response("not found", { status: 404 });
    }

    if (path.startsWith("/api/host/")) {
      if (bearer(req) !== config.hostKey) return new Response(null, { status: 401 });
      const body = req.method === "POST" ? await req.json() : {};
      switch (path.slice("/api/host/".length)) {
        case "players":
          return Response.json([...new Set(Object.values(keys))].map((name) => ({ name, online: sockets.has(name) })));
        case "remove": {
          for (const [key, name] of Object.entries(keys)) if (name === body.name) delete keys[key];
          writeJson("keys.json", keys);
          sockets.get(body.name)?.close(4002, "Removed by the host");
          feed(`${body.name} was removed by the host`, "info");
          return Response.json({});
        }
        case "public":
          invite = { link: body.link ?? null, wifiOnly: !!body.wifiOnly };
          broadcast({ t: "public", ...invite });
          return Response.json({});
        case "snapshots":
          return Response.json(store.snapshots());
        case "voice":
          broadcast({ t: "voice", on: !!voiceKey() });
          return Response.json({});
        case "activity":
          return Response.json(
            record.activity({
              minutes: Number(url.searchParams.get("minutes") ?? 60),
              who: url.searchParams.get("who") ?? undefined,
              kind: url.searchParams.get("kind") ?? undefined,
              limit: Number(url.searchParams.get("limit") ?? 200),
              summary: url.searchParams.get("summary") !== "false",
            }),
          );
        case "rewind": {
          if (!store.rewind(Number(body.at), hub)) return Response.json({ error: "That moment is no longer saved." }, { status: 404 });
          store.save(hub);
          hub.restart();
          store.keyframe();
          feed(`The host rewound the world to ${new Date(Number(body.at)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, "error");
          return Response.json({});
        }
      }
    }
    if (path === "/api/timelapse") {
      // The host watches from the main menu without joining, and sees everything.
      const host = bearer(req) === config.hostKey;
      const who = host ? null : (nameByKey(bearer(req)) ?? null);
      if (!host && !who) return new Response(null, { status: 401 });
      try {
        const started = performance.now();
        const body = await timelapseFor(who);
        record.add("action", who ?? "host", { what: "timelapse", ms: Math.round(performance.now() - started), bytes: body.length });
        return new Response(body, { headers: { "content-type": "application/json", "content-encoding": "gzip" } });
      } catch (e: any) {
        built = null;
        log("engine", "error", `timelapse: ${e.message}`);
        return Response.json({ error: "The timelapse couldn't be built." }, { status: 500 });
      }
    }
    if (path === "/api/status") return nameByKey(bearer(req)) ? Response.json(status()) : new Response(null, { status: 401 });
    if (path === "/api/join-code" && req.method === "POST") {
      const key = bearer(req);
      if (!nameByKey(key)) return new Response(null, { status: 401 });
      if (config.agents === false) return new Response("The host turned agents off for this world.\n", { status: 403 });
      // Players reach the world by its invite link; without one, at the address their game came from.
      const base = invite.link?.split("/#")[0] ?? url.searchParams.get("base");
      if (!base) return new Response("Give ?base=<this world's address>.\n", { status: 400 });
      return Response.json(joinCommand(base, codes.mint(key!, base), config.name));
    }
    if (path.startsWith("/join/")) {
      const entry = codes.take(path.slice(6));
      const who = entry && config.agents !== false && nameByKey(entry.key);
      // The player pipes this into sh, so a refusal is a script that says why.
      if (!who) return new Response("echo 'This install command expired or was used already. Copy a new one from the Agent page of the game menu.' >&2\nexit 1\n");
      return new Response(joinScript(config.name, entry.base, who, entry.key), { headers: { "content-type": "text/x-shellscript" } });
    }
    if (path === "/api/voice" && req.method === "POST") {
      const who = nameByKey(bearer(req));
      if (!who) return new Response(null, { status: 401 });
      // Bun's req.blob() types every body as text, and providers go by the recording's type.
      const audio = new Blob([await req.arrayBuffer()], { type: req.headers.get("content-type") ?? "" });
      const started = performance.now();
      const voice = voiceKey();
      if (!voice) return new Response(null, { status: 409 });
      transcribe(voice, audio).then(
        (text) => {
          record.add("action", who, { what: "voice", ms: Math.round(performance.now() - started), bytes: audio.size, heard: !!text });
          if (text) chat(who, text, "spoken");
        },
        (error) => {
          console.log(`[voice] ${who}: ${error.message}`);
          sockets.get(who)?.send(JSON.stringify({ t: "voice-failed", refused: !!error.refused, provider: voice.provider, reason: error.reason }));
          record.add("error", who, { mod: "voice", level: "error", text: String(error.message).slice(0, 500) });
        },
      );
      return new Response(null, { status: 204 });
    }
    if (path === "/api/speak" && req.method === "POST") {
      if (!nameByKey(bearer(req))) return new Response(null, { status: 401 });
      const body = await req.json();
      return speech(String(body.text ?? "").trim(), body.voice).then(
        (url) => Response.json({ url }),
        (error) => {
          console.log(`[speak] ${error.message}`);
          return Response.json({ error: error.reason ?? (error.provider ? "Speech didn't go through. Try again." : error.message) }, { status: 400 });
        },
      );
    }
    if (path === "/api/info") return Response.json({ id: basename(DATA), name: config.name, rules: config.rules, online: sockets.size, build, password: !!config.password, agents: config.agents !== false });
    if (path === "/api/join" && req.method === "POST") {
      const body = await req.json();
      const known = nameByKey(body.key);
      if (known) {
        hostIs(body, known);
        return Response.json({ key: body.key, name: known, invite: config.invite });
      }
      if (body.invite !== config.invite && body.invite !== config.hostKey) return Response.json({ error: "You need an invite link from the host." }, { status: 403 });
      if (config.password && body.invite !== config.hostKey && body.password !== config.password)
        return Response.json({ error: body.password ? "That password isn't right." : "This world has a password. Ask the host for it.", password: true }, { status: 403 });
      const name = String(body.name ?? "").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{1,15}$/.test(name)) return Response.json({ error: "Names are 2–16 letters, digits, - or _." }, { status: 400 });
      if (sockets.has(name) || (claudes.get(name)?.state ?? "offline") !== "offline")
        return Response.json({ error: "Someone is playing as that name right now. If it's you, close the game there first." }, { status: 409 });
      // An offline player's name goes to a new computer only when the host lets it in; the old key then stops working.
      if (Object.values(keys).includes(name) && body.host !== config.hostKey) {
        const host = config.host ? sockets.get(config.host) : undefined;
        if (!host) return Response.json({ error: `The host isn't in the game to let you in as ${name}. Pick another name.` }, { status: 409 });
        const id = token();
        const allowed = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 60_000);
          asking.set(id, (allow) => (clearTimeout(timer), resolve(allow)));
          host.send(JSON.stringify({ t: "let-in", id, name }));
        });
        asking.delete(id);
        if (!allowed) return Response.json({ error: `The host didn't let you in as ${name}. Pick another name.` }, { status: 409 });
      }
      for (const [old, owner] of Object.entries(keys)) if (owner === name) delete keys[old];
      const key = token() + token();
      keys[key] = name;
      writeJson("keys.json", keys);
      hostIs(body, name);
      return Response.json({ key, name, invite: config.invite });
    }

    if ((path === "/cli" || path.startsWith("/cli/")) && config.agents === false) return new Response("The host turned agents off for this world.\n", { status: 403 });
    if (path === "/cli" || path.startsWith("/cli/")) return cli(req, nameByKey(bearer(req)) ?? null, path.slice(5) || "help");

    if (path === "/ws") {
      const invite = url.searchParams.get("invite");
      if (invite === config.invite || invite === config.hostKey) {
        if (spectators.size >= 8) return new Response("too many spectators", { status: 503 });
        return server.upgrade(req, { data: { name: `~${token()}`, ua: "", at: Date.now(), spectator: true } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      const name = nameByKey(url.searchParams.get("key"));
      // A game whose name was claimed from another device reloads into the join screen.
      if (!name) return server.upgrade(req, { data: { name: "", ua: "", at: Date.now() } }) ? undefined : new Response("unknown key", { status: 401 });
      return server.upgrade(req, { data: { name, ua: req.headers.get("user-agent") ?? "", at: Date.now() } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  }),
  websocket: {
    perMessageDeflate: true,
    open(ws) {
      const { name } = ws.data;
      if (!name) return ws.close(4001, "You joined from another device");
      if (ws.data.spectator) {
        spectators.set(name, ws);
        hub.send({ t: "watch", id: name });
        ws.send(JSON.stringify({ t: "welcome", playerId: name, mods: clientMods(null) }));
        return;
      }
      const previous = sockets.get(name);
      sockets.set(name, ws);
      if (previous) previous.close(4000, "Opened in another tab");
      const game = sims.gameOf(name);
      ws.send(
        JSON.stringify({
          t: "welcome",
          playerId: name,
          world: config.name,
          rules: config.rules,
          invite: config.invite,
          ...invite,
          voice: !!voiceKey(),
          host: config.host ?? null,
          game,
          mods: clientMods(game),
          feed: feedLog.slice(-8),
          claudes: Object.fromEntries([...claudes.keys()].map((name) => [name, builder(name)])),
          talk: chatLog.filter((c) => c.claudes).map(({ from, text }) => ({ from, text })),
        }),
      );
      // After the welcome, so the game knows who it is when the games arrive.
      if (previous) {
        sims.resync(name);
        ws.send(JSON.stringify(gamesMessage()));
      } else sims.join(name);
      if (leavingLine.has(name)) {
        clearTimeout(leavingLine.get(name));
        leavingLine.delete(name);
      } else if (!previous) {
        joiningLine.set(name, setTimeout(() => (joiningLine.delete(name), feed(`${name} joined`, "info")), 3_000));
      }
      record.add("session", name, { event: previous ? "rejoin" : "join", ua: ws.data.ua.slice(0, 200) });
    },
    message(ws, raw) {
      if (ws.data.spectator) return;
      const t = usage(ws.data.name);
      t.in++;
      t.inKB += raw.length / 1024;
      const msg = JSON.parse(String(raw));
      if (msg.t === "m") sims.message(ws.data.name, msg.mod, msg.msg);
      else if (msg.t === "chat") chat(ws.data.name, String(msg.text));
      else if (msg.t === "resync") sims.resync(ws.data.name);
      else if (msg.t === "let-in" && ws.data.name === config.host) asking.get(String(msg.id))?.(msg.allow === true);
      else if (msg.t === "enterGame") {
        const game = typeof msg.game === "string" ? msg.game : null;
        const refused = sims.enter(ws.data.name, game);
        if (refused) ws.send(JSON.stringify({ t: "gameSwitch", game, phase: "failed", reason: refused }));
        else record.add("action", ws.data.name, { what: "game", detail: game ?? "hub" });
      }
      else if (msg.t === "react") react(ws.data.name, String(msg.mod), String(msg.kind));
      else if (msg.t === "keys") mods.reportKeys(msg.keys);
      else if (msg.t === "shot") shots.get(msg.id)?.(String(msg.data));
      else if (msg.t === "error") log(msg.mod, "client-error", `${ws.data.name}'s game: ${String(msg.text).slice(0, 2000)}`, ws.data.name);
      else if (msg.t === "log") log(String(msg.mod), `client-${msg.level}`, `${ws.data.name}'s game: ${String(msg.text).slice(0, 2000)}`, ws.data.name);
      else if (msg.t === "perf") {
        const { t, at, ...report } = msg;
        clientPerf.set(ws.data.name, { ...report, at: Date.now() });
        ws.send(JSON.stringify({ t: "pong", at }));
        samplePlayer(ws.data.name, report);
        const before = slowFrames.get(ws.data.name) ?? {};
        const slow = Object.entries<number>(report.modsMsPerFrame ?? {}).filter(([, ms]) => ms >= 16);
        slowFrames.set(ws.data.name, Object.fromEntries(slow.map(([mod]) => [mod, (before[mod] ?? 0) + 1])));
        // Five reports in a row is 10 s.
        for (const [mod, ms] of slow) if (before[mod] === 4) nameSlow(mod, "frames", `${mod} takes ${Math.round(ms)} ms of every frame in ${ws.data.name}'s game`);
      } else if (msg.t === "loaded") {
        joins.set(ws.data.name, { firstFrameMs: msg.firstFrameMs, slowestMods: msg.slowestMods });
        for (const [mod, ms] of Object.entries<number>(msg.slowestMods ?? {})) if (ms > 500) nameSlow(mod, "start", `${mod} took ${(ms / 1000).toFixed(1)} s to start in ${ws.data.name}'s game`);
        record.add("session", ws.data.name, { loaded: true, firstFrameMs: msg.firstFrameMs, modsMs: msg.modsMs, slowestMods: msg.slowestMods, screen: msg.screen });
      } else if (msg.t === "act") record.add("action", ws.data.name, { what: String(msg.what).slice(0, 40), detail: String(msg.detail ?? "").slice(0, 120) });
    },
    close(ws) {
      if (ws.data.spectator) {
        spectators.delete(ws.data.name);
        hub.send({ t: "unwatch", id: ws.data.name });
        return;
      }
      if (sockets.get(ws.data.name) !== ws) return;
      sockets.delete(ws.data.name);
      clientPerf.delete(ws.data.name);
      slowFrames.delete(ws.data.name);
      clientWindow.delete(ws.data.name);
      record.add("session", ws.data.name, { event: "leave", seconds: Math.round((Date.now() - ws.data.at) / 1000) });
      sims.leave(ws.data.name);
      const { name } = ws.data;
      if (joiningLine.has(name)) {
        clearTimeout(joiningLine.get(name));
        joiningLine.delete(name);
      } else leavingLine.set(name, setTimeout(() => (leavingLine.delete(name), feed(`${name} left`, "info")), 10_000));
    },
  },
});

function timed(handle: (req: Request, server: Server<Conn>) => Promise<Response | undefined>) {
  return async (req: Request, server: Server<Conn>) => {
    const started = performance.now();
    try {
      return await handle(req, server);
    } finally {
      http.add(`${req.method} ${route(new URL(req.url).pathname)}`, performance.now() - started);
    }
  };
}

/** Games report every 2 s; the record keeps one row per 10 s with the worst frame times of those reports. */
const clientWindow = new Map<string, any[]>();
function samplePlayer(name: string, report: any) {
  const reports = [...(clientWindow.get(name) ?? []), report];
  clientWindow.set(name, reports);
  if (reports.length < 5) return;
  clientWindow.delete(name);
  const worst = (key: string) => Math.max(...reports.map((r) => r[key] ?? 0));
  const { drawCallsPerFrame, trianglesPerFrame, sceneObjects, entities, pingMs, downloadKBps, heapMB, geometries, textures, modsMsPerFrame, msPerFrame, hidden } = report;
  record.add("client", name, {
    fps: Math.min(...reports.map((r) => r.fps)),
    p95FrameMs: worst("p95FrameMs"),
    slowestFrameMs: worst("slowestFrameMs"),
    msPerFrame,
    drawCalls: drawCallsPerFrame,
    triangles: trianglesPerFrame,
    sceneObjects,
    geometries,
    textures,
    entities,
    pingMs,
    downloadKBps,
    heapMB,
    mods: Object.fromEntries(Object.entries(modsMsPerFrame ?? {}).slice(0, 5)),
    hidden,
    pressed: reports.reduce((all, r) => {
      for (const [key, n] of Object.entries(r.pressed ?? {})) all[key] = (all[key] ?? 0) + (n as number);
      return all;
    }, {}),
  });
}

const base = `http://localhost:${server.port}`;
// The host link carries the host key, so it goes only to a terminal, never into a log file.
console.log(process.stdout.isTTY ? `\n  ${config.name} is running.\n  Host link (keep private): ${base}/#invite=${config.hostKey}\n` : `${config.name} is running on ${base}`);
process.send?.({ port: server.port });
