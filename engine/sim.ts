import { Database } from "bun:sqlite";
import { existsSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Body, Entity, ModDb, Player, ServerHooks, ServerMod } from "./api";
import { installNetwork } from "./box/network";
import { PhysicsIndex } from "./physics";
import { GameWorld, modDb, type Diff, type Tick } from "./world";

type Ground = (x: number, z: number, fromY: number) => number | null;
/** `game` is the game the mod belongs to, or null for a mod every game shares. */
type Loaded = { id: number; name: string; game: string | null; mod: ServerMod; errors: number; slowTicks: number; ms: number; ticks: number[]; lastError?: string; grounds: Set<Ground> };
type Event = { from: string; name: string; data: any; to?: string[] };

const world = new GameWorld();
const physics = new PhysicsIndex();
const mods = new Map<string, Loaded>();
let ordered: Loaded[] = [];
/** The mods that wrap other mods' hooks, and the mods that hide entities, kept apart because hooks run per entity per player. */
let wrappers: Loaded[] = [];
let seers: Loaded[] = [];
let beat: Int32Array;
let trial: string | null = null;
let current: Loaded | null = null;
let events: Event[] = [];
/** Spectators get a player's stream, but no mod's join, leave or players list ever sees them. */
const watchers = new Map<string, Player>();
/** Set while checking what a spectator sees: a hook that throws on someone who isn't a player hides the thing instead of counting against its mod. */
let spectating = false;
/** The game this simulation runs, or null for the world's own hub, and every game players may be moved to. */
let game: string | null = null;
let games = new Set<string>();

const post = (msg: object) => process.send!(msg);
const network = installNetwork(post);

for (const level of ["log", "info", "warn", "error"] as const) {
  console[level] = (...args: any[]) =>
    post({ t: "log", mod: current?.name ?? "engine", level, text: args.map((a) => (typeof a === "string" ? a : Bun.inspect(a))).join(" ") });
}

// ---------- databases ----------
let dbDir = "";
const writers = new Map<string, ModDb>();
const readers = new Map<string, ModDb>();
/** Every open database, closed before the host retires this process. */
const handles: Database[] = [];
/** Under the host's 2 s freeze limit, so a locked database throws in the mod instead of getting it reverted as frozen. */
const BUSY_MS = 1000;

function ownDb(name: string) {
  const cached = writers.get(name);
  if (cached) return cached;
  const path = join(dbDir, `${name}.sqlite`);
  let db: Database;
  if (trial) {
    const source = existsSync(path) ? new Database(path, { readonly: true }) : null;
    const copy = source?.serialize() ?? null;
    source?.close();
    // A WAL-mode header makes the in-memory copy unopenable; bytes 18-19 switch it to rollback journaling.
    if (copy) copy[18] = copy[19] = 1;
    db = copy ? Database.deserialize(copy) : new Database(":memory:");
  } else {
    db = new Database(path, { create: true });
    // First, so that switching to WAL waits out a lock instead of failing.
    db.run(`pragma busy_timeout = ${BUSY_MS}`);
    db.run("pragma journal_mode = wal");
  }
  handles.push(db);
  writers.set(name, modDb(db));
  return writers.get(name)!;
}

function readDb(name: string) {
  if (trial) return ownDb(name);
  const cached = readers.get(name);
  if (cached) return cached;
  const path = join(dbDir, `${name}.sqlite`);
  if (!existsSync(path)) throw new Error(`${name} has no database yet`);
  const db = new Database(path, { readonly: true });
  db.run(`pragma busy_timeout = ${BUSY_MS}`);
  handles.push(db);
  readers.set(name, modDb(db));
  return readers.get(name)!;
}

function caller(what: string) {
  if (!current) throw new Error(`${what} is only available inside a mod hook, later() or run()`);
  return current;
}

Object.defineProperty(world, "db", { get: () => ownDb(caller("world.db").name) });
world.dbOf = readDb;
world.emit = (name, data, to) => void events.push({ from: caller("world.emit").name, name, data, to });
world.later = (ms, fn) => {
  const m = caller("world.later");
  if (!trial) setTimeout(() => mods.get(m.name) === m && guarded(m, "later", () => fn(world)), ms);
};
world.async = (work) => {
  const m = caller("world.async");
  if (trial) return;
  const run = (fn: (w: typeof world) => void) => void (mods.get(m.name) === m && guarded(m, "async run", () => fn(world)));
  work(run).catch((e: any) => {
    if (mods.get(m.name) !== m) return;
    m.lastError = `async: ${e?.stack ?? e}`;
    fault(m, m.lastError, ++m.errors >= 10);
  });
};
world.physics = {
  boxes: (x, z, radius) => physics.boxes(x, z, radius),
  groundAt: (x, z, fromY) => physics.groundAt(x, z, fromY),
  move: (pos, vel, dt, body) => physics.move(pos, vel, dt, body),
  ray: (origin, dir, maxDistance) => physics.ray(origin, dir, maxDistance),
  ground(fn) {
    const m = caller("world.physics.ground");
    const g: Ground = (x, z, fromY) => guarded(m, "ground", () => fn(x, z, fromY)) ?? null;
    m.grounds.add(g);
    reorder();
    return () => void (m.grounds.delete(g) && reorder());
  },
};
/** The mod that spawned each entity, so a wall nobody can see can be traced to its mod. */
const creators = new Map<number, string>();
let made: Record<number, string> = {};
const spawn = world.spawn.bind(world);
world.spawn = (e) => {
  const id = spawn(e);
  if (current) creators.set(id, (made[id] = current.name));
  return id;
};
world.enter = (player, to) => {
  caller("world.enter");
  if (trial || !world.players.has(player) || to === game || (to !== null && !games.has(to))) return false;
  post({ t: "enter", player, game: to });
  return true;
};
world.has = (name) => !!mods.get(name)?.mod.exports;
world.use = (name) => {
  const target = mods.get(name);
  if (!target?.mod.exports) throw new Error(`${name} is not loaded or exports nothing. If your mod works without it, check world.has("${name}") before use.`);
  return Object.fromEntries(
    Object.entries(target.mod.exports).map(([key, fn]) => [
      key,
      (...args: any[]) => {
        const [prev, prevBeat] = [current, Atomics.load(beat, 1)];
        current = target;
        Atomics.store(beat, 1, target.id);
        try {
          return fn.call(target.mod.exports, world, ...args);
        } finally {
          Atomics.store(beat, 1, prevBeat);
          current = prev;
        }
      },
    ]),
  ) as any;
};

// ---------- hooks ----------
function reorder() {
  ordered = [...mods.values()].sort((a, b) => (a.mod.order ?? 0) - (b.mod.order ?? 0) || a.name.localeCompare(b.name));
  wrappers = ordered.filter((m) => m.mod.wrap);
  seers = ordered.filter((m) => m.mod.see);
  physics.grounds = ordered.flatMap((m) => [...m.grounds]);
  fullPass = true;
}

function guarded<T>(m: Loaded, label: string, fn: () => T): T | undefined {
  const [prev, prevBeat] = [current, Atomics.load(beat, 1)];
  current = m;
  Atomics.store(beat, 1, m.id);
  try {
    return fn();
  } catch (e: any) {
    if (spectating) throw e;
    m.lastError = `${label}: ${e?.stack ?? e}`;
    fault(m, m.lastError, ++m.errors >= 10);
  } finally {
    Atomics.store(beat, 1, prevBeat);
    current = prev;
  }
}

function call(m: Loaded, hook: keyof ServerHooks, ...args: any[]): any {
  const base = m.mod[hook] as ((...a: any[]) => any) | undefined;
  let next = (...a: any[]) => guarded(m, hook, () => base?.call(m.mod, world, ...a));
  let wrapped = false;
  for (const w of wrappers) {
    const fn = w !== m ? (w.mod.wrap?.[m.name]?.[hook] as ((...a: any[]) => any) | undefined) : undefined;
    if (!fn) continue;
    const inner = next;
    next = (...a: any[]) => guarded(w, `wrap ${m.name}.${hook}`, () => fn.call(w.mod, inner, world, ...a));
    wrapped = true;
  }
  if (!base && !wrapped) return;
  const watch = (hook === "tick" || hook === "message") && avatars.size > 0 && !trial;
  const before = watch ? placeAvatars() : null;
  const started = performance.now();
  const result = next(...args);
  const ms = performance.now() - started;
  if (before) checkMoves(m, hook, before, hook === "message" ? args : null);
  m.ms += ms;
  if (hook === "tick") {
    m.ticks.push(ms);
    m.slowTicks = ms > 50 ? m.slowTicks + 1 : 0;
    if (m.slowTicks >= 100) fault(m, "every tick took over 50 ms for 5 s", true);
  }
  return result;
}

// ---------- player position corrections ----------
type Vec = [number, number, number];
/** Entities that stand for a player: `player: id` on the entity or on one of its components, by entity id. */
let avatars = new Map<number, string>();
/** Which mod, or the player's own game, last moved each avatar since the last tick went out. */
const movedBy = new Map<number, string>();
/** When each mod last corrected each entity, and how many corrections since then went unlisted. */
const reported = new Map<string, { at: number; count: number }>();
const SELF = "the player's own game";

function findAvatars() {
  avatars = new Map();
  for (const [id, e] of world.entities) {
    if (typeof e.player === "string" && world.players.has(e.player)) avatars.set(id, e.player);
    else for (const k in e) if (typeof e[k]?.player === "string" && world.players.has(e[k].player)) avatars.set(id, e[k].player);
  }
}

const vec = (v: unknown): Vec | null => (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(Number.isFinite) ? [v[0], v[1], v[2]] : null);
const apart = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 0.01;

function placeAvatars() {
  const at = new Map<number, Vec | null>();
  for (const id of avatars.keys()) at.set(id, vec(world.entities.get(id)?.pos));
  return at;
}

/** A hook that moves a player somewhere other than where their own game or another mod just put them corrected that player. */
function checkMoves(m: Loaded, hook: string, before: Map<number, Vec | null>, args: any[] | null) {
  const wanted = args ? (vec(args[1]?.p) ?? vec(args[1]?.pos)) : null;
  for (const [id, from] of before) {
    const to = vec(world.entities.get(id)?.pos);
    if (!from || !to || !apart(from, to)) continue;
    const player = avatars.get(id)!;
    const mine = args?.[0]?.id === player;
    if (mine && wanted && !apart(wanted, to)) {
      movedBy.set(id, SELF);
      continue;
    }
    const earlier = movedBy.get(id);
    movedBy.set(id, m.name);
    if (mine && wanted) report(m, hook, id, player, from, to, wanted, SELF);
    else if (earlier && earlier !== m.name) report(m, hook, id, player, from, to, null, earlier);
  }
}

function report(m: Loaded, hook: string, id: number, player: string, from: Vec, to: Vec, wanted: Vec | null, overruled: string) {
  const key = `${m.name} ${id}`;
  const now = Date.now();
  const last = reported.get(key);
  if (last && now - last.at < 1000) return void last.count++;
  reported.set(key, { at: now, count: 0 });
  const r = (v: Vec) => v.map((n) => Math.round(n * 100) / 100);
  post({ t: "correction", at: now, mod: m.name, hook, player, entity: id, overruled, from: r(from), to: r(to), wanted: wanted && r(wanted), repeats: last?.count ?? 0 });
}

function fault(m: Loaded, error: string, fatal: boolean) {
  if (trial) {
    if (trial === m.name) post({ t: "trial", error });
    return;
  }
  post({ t: "log", mod: m.name, level: "error", text: error });
  if (fatal && mods.get(m.name) === m) {
    mods.delete(m.name);
    reorder();
    post({ t: "fault", mod: m.name, error });
  }
}

async function setMod(name: string, id: number, path: string | null, game: string | null = null) {
  if (!path) {
    mods.delete(name);
    return reorder();
  }
  const loaded: Loaded = { id, name, game, mod: (await import(path)).default ?? {}, errors: 0, slowTicks: 0, ms: 0, ticks: [], grounds: new Set() };
  mods.set(name, loaded);
  reorder();
  call(loaded, "load");
}

// ---------- players coming and going ----------
/**
 * Joining the world or switching in from another game: shared mods get join either way, this game's mods get join only on joining.
 * Bodies made by then go where the player left this game, or to its spawn; enterGame comes after, so a game mod that places the player itself has the last word.
 */
function arrive(p: Player, switched: boolean, at: Vec | undefined) {
  world.players.set(p.id, p);
  for (const m of ordered) if (!switched || !m.game) call(m, "join", p);
  if (at) for (const [, e] of world.query("player", "pos")) if (e.player === p.id) e.pos = [...at];
  for (const m of ordered) if (m.game) call(m, "enterGame", p);
}

/** A player's body is any entity whose `player` is their id: whichever mod made it, it goes with them, so no game keeps someone who isn't in it. */
function removeBodies(gone: (player: string) => boolean) {
  for (const [id, e] of world.entities) if (typeof e.player === "string" && gone(e.player)) world.remove(id);
}

function depart(p: Player, switched: boolean) {
  for (const m of ordered) if (m.game) call(m, "exitGame", p);
  for (const m of ordered) if (!switched || !m.game) call(m, "leave", p);
  removeBodies((player) => player === p.id);
  world.players.delete(p.id);
  known.delete(p.id);
  behind.delete(p.id);
}

// ---------- per-player streams ----------
const known = new Map<string, Set<number>>();
const resync = new Set<string>();
let fullPass = true;
let tickCount = 0;

/** The entities in `list` that player p may not see: an `only` list without them, or a mod's see hook saying no. */
function hiddenFrom(p: Player, list: Iterable<[number, Entity]>) {
  const hidden = new Set<number>();
  const entries = [...list];
  for (const [id, e] of entries) if (Array.isArray(e.only) && !e.only.includes(p.id)) hidden.add(id);
  spectating = watchers.has(p.id) || !world.players.has(p.id);
  try {
    // One mod at a time over every entity, so each mod's see is timed once per pass instead of once per entity.
    for (const m of seers) {
      const started = performance.now();
      if (wrappers.some((w) => w !== m && w.mod.wrap?.[m.name]?.see)) {
        for (const [id, e] of entries) {
          try {
            if (!hidden.has(id) && call(m, "see", p, id, e) === false) hidden.add(id);
          } catch {
            hidden.add(id);
          }
        }
        continue;
      }
      const [prev, prevBeat] = [current, Atomics.load(beat, 1)];
      current = m;
      Atomics.store(beat, 1, m.id);
      try {
        for (const [id, e] of entries) {
          if (hidden.has(id)) continue;
          try {
            if (m.mod.see!(world, p, id, e) === false) hidden.add(id);
          } catch (err: any) {
            if (spectating) hidden.add(id);
            else {
              m.lastError = `see: ${err?.stack ?? err}`;
              fault(m, m.lastError, ++m.errors >= 10);
            }
          }
        }
      } finally {
        Atomics.store(beat, 1, prevBeat);
        current = prev;
        m.ms += performance.now() - started;
      }
    }
  } finally {
    spectating = false;
  }
  return hidden;
}

const visible = (p: Player, id: number, e: Entity) => !hiddenFrom(p, [[id, e]]).size;

type Out = { reset?: true; set: Record<number, Entity>; unset: Record<number, string[]>; removed: number[]; events?: Omit<Event, "to">[]; makers?: Record<number, string> };

/** Changes to entities farther than this from a player's avatar reach that player every 2 s instead of every tick. */
const NEAR = 150;
const CATCH_UP_TICKS = 40;
/** Per player, the far entities that changed since the player last got them, and which components. */
const behind = new Map<string, Map<number, Set<string>>>();

/** Where each player's avatar stands, for interest management. */
function eyes() {
  const at = new Map<string, Vec>();
  for (const [id, player] of avatars) {
    const e = world.entities.get(id);
    const pos = vec(e?.pos);
    if (pos && (e!.player === player || !at.has(player))) at.set(player, pos);
  }
  return at;
}

function stream(p: Player, d: Diff, full: boolean, eye: Vec | undefined, catchUp: boolean): Out {
  const out: Out = { set: {}, unset: {}, removed: [] };
  let seen = known.get(p.id);
  if (!seen || resync.has(p.id)) {
    known.set(p.id, (seen = new Set()));
    behind.delete(p.id);
    full = out.reset = true;
  }
  let late = behind.get(p.id);
  if (!late) behind.set(p.id, (late = new Map()));
  const near = (id: number, e: Entity) => {
    if (!eye || e.far === true || typeof e.player === "string" || avatars.has(id)) return true;
    const pos = vec(e.pos);
    return !pos || Math.hypot(pos[0] - eye[0], pos[2] - eye[2]) <= NEAR;
  };
  /** Sends the components of a far entity that changed while it was far, as they are now. */
  const catchUpOn = (id: number, e: Entity) => {
    const keys = late.get(id);
    if (!keys) return;
    late.delete(id);
    for (const k of keys) {
      if (e[k] !== undefined) out.set[id] = { ...out.set[id], [k]: e[k] };
      else if (!out.unset[id]?.includes(k)) (out.unset[id] ??= []).push(k);
    }
  };
  const list = full ? world.entities : [...new Set([...Object.keys(d.set), ...Object.keys(d.unset)].map(Number))].map((id) => [id, world.entities.get(id)!] as [number, Entity]);
  const hidden = hiddenFrom(p, list);
  for (const [id, e] of list) {
    if (hidden.has(id)) {
      late.delete(id);
      if (seen.delete(id)) out.removed.push(id);
    } else if (!seen.has(id)) {
      seen.add(id);
      out.set[id] = e;
      // A solid with nothing drawn shows as a wireframe named after the mod that made it.
      if (e.solid && !e.mesh && creators.has(id)) (out.makers ??= {})[id] = creators.get(id)!;
    } else if (d.set[id] || d.unset[id]) {
      if (near(id, e)) {
        if (d.set[id]) out.set[id] = d.set[id];
        if (d.unset[id]) out.unset[id] = d.unset[id];
        catchUpOn(id, e);
      } else {
        let keys = late.get(id);
        if (!keys) late.set(id, (keys = new Set()));
        for (const k in d.set[id]) keys.add(k);
        for (const k of d.unset[id] ?? []) keys.add(k);
      }
    }
  }
  for (const id of late.keys()) {
    const e = world.entities.get(id);
    if (!e || !seen.has(id)) late.delete(id);
    else if (catchUp || near(id, e)) catchUpOn(id, e);
  }
  for (const id of full ? [...seen].filter((id) => !world.entities.has(id)) : d.removed) if (seen.delete(id)) out.removed.push(id);
  const mine = events.filter((ev) => !ev.to || ev.to.includes(p.id)).map(({ from, name, data }) => ({ from, name, data }));
  if (mine.length) out.events = mine;
  return out;
}

/** A start's first tick goes out even when nothing changed: the world process starts the typecheck's warm-up on the hub's first tick, idle or not. */
function flush(initial: boolean) {
  const d = world.delta();
  for (const id in d.set) physics.update(+id, world.entities.get(+id));
  for (const id in d.unset) physics.update(+id, world.entities.get(+id));
  for (const id of d.removed) {
    physics.update(id, undefined);
    creators.delete(id);
  }
  const outs: Record<string, string> = {};
  // Each player gets a full visibility pass every 5th tick, on a different tick from the others so the passes don't pile up.
  let i = 0;
  const at = eyes();
  for (const p of [...world.players.values(), ...watchers.values()]) {
    const out = stream(p, d, fullPass || (seers.length > 0 && (tickCount + i) % 5 === 0), at.get(p.id), (tickCount + i++ * 7) % CATCH_UP_TICKS === 0);
    if (out.reset || Object.keys(out.set).length || Object.keys(out.unset).length || out.removed.length || out.events) outs[p.id] = JSON.stringify({ t: "tick", ...out });
  }
  fullPass = false;
  resync.clear();
  events = [];
  movedBy.clear();
  for (const id in made) if (!world.entities.has(+id)) creators.delete(+id);
  if (initial || Object.keys(d.set).length || Object.keys(d.unset).length || d.removed.length || Object.keys(outs).length) post({ t: "tick", diff: d, nextId: world.nextId, outs, made });
  made = {};
}

function tick(dt: number) {
  if (tickCount % 20 === 0) findAvatars();
  for (const m of ordered) call(m, "tick", dt);
  tickCount++;
  Atomics.add(beat, 0, 1);
}

/** A simulation's process shares its heartbeat with the world process through a file: memory-mapped, or on Windows, where Bun can't map one, copied in by a thread of its own and once more as the process exits. */
function shareBeat(file: string) {
  if (process.platform !== "win32") {
    const mapped = Bun.mmap(file);
    return new Int32Array(mapped.buffer, mapped.byteOffset, 2);
  }
  const shared = new Int32Array(new SharedArrayBuffer(8));
  new Worker(new URL("./beat.ts", import.meta.url)).postMessage({ file, beat: shared.buffer });
  const fd = openSync(file, "r+");
  process.on("exit", () => writeSync(fd, new Uint8Array(shared.buffer), 0, 8, 0));
  return shared;
}

let loop: ReturnType<typeof setInterval> | undefined;

const receive = async (msg: any) => {
  switch (msg.t) {
    case "init": {
      beat = msg.beatFile ? shareBeat(msg.beatFile) : new Int32Array(2);
      game = msg.game ?? null;
      games = new Set(msg.games ?? []);
      world.nextId = msg.nextId;
      for (const [id, e] of Object.entries(msg.entities)) world.entities.set(Number(id), e as any);
      for (const p of msg.players as Player[]) world.players.set(p.id, p);
      for (const [id, mod] of Object.entries(msg.creators ?? {})) creators.set(Number(id), mod as string);
      for (const id of msg.watchers as string[]) watchers.set(id, { id, name: id, game });
      trial = msg.trial ?? null;
      dbDir = msg.dbDir;
      world.delta();
      // Bodies from a save or a crashed process whose players aren't in this simulation go before any mod loads; the first tick tells the world process.
      removeBodies((player) => !world.players.has(player));
      for (const [id, e] of world.entities) physics.update(id, e);
      for (const m of msg.mods) {
        try {
          await setMod(m.name, m.id, m.server, m.game ?? null);
        } catch (e: any) {
          if (trial === m.name) return post({ t: "trial", error: `import: ${e?.stack ?? e}` });
          if (!trial) post({ t: "fault", mod: m.name, error: `import: ${e?.stack ?? e}` });
        }
      }
      if (trial) return runTrial();
      let firstTick = true;
      let last = performance.now();
      let times: number[] = [];
      let engine: number[] = [];
      const modMs = () => ordered.reduce((sum, m) => sum + m.ms, 0);
      loop = setInterval(() => {
        const now = performance.now();
        const before = modMs();
        tick(Math.min((now - last) / 1000, 0.25));
        last = now;
        flush(firstTick);
        firstTick = false;
        for (const w of walks.splice(0)) post({ t: "answer", id: w.id, value: walk(w.from, w.to, w.body ?? {}) });
        times.push(performance.now() - now);
        engine.push(times.at(-1)! - (modMs() - before));
        if (times.length < 40) return;
        const ticks = times.length;
        const cost = Object.fromEntries(ordered.filter((m) => m.ms).sort((a, b) => b.ms - a.ms).map((m) => [m.name, +(m.ms / ticks).toFixed(2)]));
        const sorted = times.sort((a, b) => a - b);
        const at = (p: number) => +sorted[Math.floor(ticks * p)].toFixed(2);
        const spikes = Object.fromEntries(
          ordered
            .filter((m) => m.ticks.length)
            .map((m) => {
              const own = m.ticks.sort((a, b) => a - b);
              return [m.name, { p95: +own[Math.floor(own.length * 0.95)]!.toFixed(2), max: +own.at(-1)!.toFixed(2) }] as const;
            })
            .sort((a, b) => b[1].max - a[1].max),
        );
        post({ t: "perf", msPerTick: +(sorted.reduce((a, b) => a + b, 0) / ticks).toFixed(2), p50: at(0.5), p95: at(0.95), max: +sorted[ticks - 1].toFixed(2), engine: +engine.sort((a, b) => a - b)[Math.floor(ticks / 2)]!.toFixed(2), mods: cost, modTicks: spikes });
        for (const m of ordered) [m.ms, m.ticks] = [0, []];
        times = [];
        engine = [];
      }, 50);
      return post({ t: "ready" });
    }
    case "mod":
      try {
        await setMod(msg.name, msg.id, msg.server, msg.game ?? null);
        post({ t: "applied", name: msg.name, error: mods.get(msg.name)?.lastError ?? null });
      } catch (e: any) {
        post({ t: "fault", mod: msg.name, error: `import: ${e?.stack ?? e}` });
        post({ t: "applied", name: msg.name, error: `import: ${e?.stack ?? e}` });
      }
      return;
    case "join":
      return arrive(msg.player, !!msg.switched, msg.at);
    case "games":
      return void (games = new Set(msg.ids));
    case "watch":
      return void watchers.set(msg.id, { id: msg.id, name: msg.id, game });
    case "unwatch":
      watchers.delete(msg.id);
      behind.delete(msg.id);
      return void known.delete(msg.id);
    case "resync":
      return void resync.add(msg.id);
    case "see": {
      // A player in a game still sees the hub's timelapse, as someone who isn't in it.
      const p: Player = world.players.get(msg.player) ?? { id: msg.player, name: msg.player, game };
      // Visibility is checked when an entity changes, so the check runs once per change instead of once per entity per moment.
      const whole = new Map<string, Entity>();
      const shown = new Set<string>();
      const ticks: Tick[] = [];
      let slice = performance.now();
      for (const t of msg.ticks as Tick[]) {
        const out: Tick = { at: t.at, reset: t.reset, set: {}, unset: {}, removed: [], activity: t.activity, mods: t.mods };
        for (const id of t.removed) {
          whole.delete(String(id));
          if (shown.delete(String(id))) out.removed.push(id);
        }
        for (const id of new Set([...Object.keys(t.set), ...Object.keys(t.unset)])) {
          const e = { ...whole.get(id), ...t.set[id] };
          for (const k of t.unset[id] ?? []) delete e[k];
          whole.set(id, e);
          if (!visible(p, Number(id), e)) {
            if (shown.delete(id)) out.removed.push(Number(id));
          } else if (!shown.has(id)) {
            shown.add(id);
            out.set[id] = e;
          } else {
            if (t.set[id]) out.set[id] = t.set[id];
            if (t.unset[id]) out.unset[id] = t.unset[id];
          }
        }
        ticks.push(out);
        // Lets the simulation tick between slices of a long history.
        if (performance.now() - slice > 8) {
          await new Promise((r) => setTimeout(r, 0));
          slice = performance.now();
        }
      }
      return post({ t: "answer", id: msg.id, value: ticks });
    }
    case "close":
      // Nothing may reach a database once it is closed: no tick, and no mod's later() or async work.
      clearInterval(loop);
      mods.clear();
      for (const db of handles.splice(0)) db.close();
      return post({ t: "closed" });
    case "walk":
      return void walks.push(msg);
    case "leave": {
      const p = world.players.get(msg.id);
      if (p) depart(p, !!msg.switched);
      return;
    }
    case "msg": {
      const p = world.players.get(msg.id);
      const m = mods.get(msg.mod);
      if (p && m) call(m, "message", p, msg.msg);
      return;
    }
  }
};

// ---------- walk test ----------
/** Walk tests wait for the next tick to go out, so they see every entity spawned before they were asked. */
const walks: { id: number; from: Vec; to: Vec; body?: Body }[] = [];
const WALK_SPEED = 4;
const GRAVITY = 20;

/** Walks a body in a straight line from one feet position toward another under the live physics, and names whatever stops it. */
function walk(from: Vec, to: Vec, body: Body) {
  const { radius = 0.35, height = 1.8, step = 0.45 } = body;
  let pos: number[] = [...from];
  let vel = [0, 0, 0];
  const left = () => Math.hypot(to[0] - pos[0]!, to[2] - pos[2]!);
  const total = left();
  let best = total;
  let lastGain = 0;
  const dt = 0.05;
  for (let t = 0; t < total / WALK_SPEED * 3 + 5; t += dt) {
    const d = left();
    if (d < 0.3) return { outcome: "reached", at: pos, seconds: +t.toFixed(1) };
    const dir = [(to[0] - pos[0]!) / d, (to[2] - pos[2]!) / d];
    const moved = physics.move(pos, [dir[0]! * WALK_SPEED, vel[1]! - GRAVITY * dt, dir[1]! * WALK_SPEED], dt, { radius, height, step });
    [pos, vel] = [moved.pos, moved.vel];
    if (pos[1]! < Math.min(from[1], to[1]) - 30) return { outcome: "fell", at: pos, walked: +(total - left()).toFixed(1), ground: physics.groundAt(pos[0]!, pos[2]!) };
    if (left() < best - 0.05) [best, lastGain] = [left(), t];
    if (t - lastGain > 1) return { outcome: "stopped", at: pos, walked: +(total - best).toFixed(1), short: +best.toFixed(1), by: blocker(pos, dir as [number, number], radius, height, step) };
  }
  return { outcome: "stopped", at: pos, walked: +(total - best).toFixed(1), short: +best.toFixed(1), by: null };
}

/** The solid box or terrain in the way just ahead of feet at pos, walking along dir. */
function blocker(pos: number[], dir: [number, number], radius: number, height: number, step: number) {
  const [x, y, z] = [pos[0]! + dir[0] * (radius + 0.3), pos[1]!, pos[2]! + dir[1] * (radius + 0.3)];
  for (const b of physics.boxes(x, z, radius)) {
    if (b.y + b.hy <= y + step || b.y - b.hy >= y + height) continue;
    const e = world.entities.get(b.id);
    return {
      entity: b.id,
      box: { center: [b.x, b.y, b.z].map((n) => +n.toFixed(2)), size: [b.hx * 2, b.hy * 2, b.hz * 2].map((n) => +n.toFixed(2)) },
      mesh: !!e?.mesh && e.mesh.opacity !== 0,
      components: Object.keys(e ?? {}),
      mod: creators.get(b.id) ?? null,
    };
  }
  for (const m of ordered)
    for (const g of m.grounds) {
      const h = g(x, z, y);
      if (typeof h === "number" && h > y + step) return { terrain: m.name, groundAt: +h.toFixed(2), rise: +(h - y).toFixed(2) };
    }
  return null;
}

/** What arrives while init still loads mods waits for it, so no mod misses a player's join. */
let initialized: Promise<unknown> = Promise.resolve();
const deliver = (msg: any) => (msg.t === "init" ? (initialized = receive(msg).catch(() => {})) : initialized.then(() => receive(msg)));
process.on("message", (msg) => {
  if (!network.receive(msg)) void deliver(msg);
});
process.on("disconnect", () => process.exit());

/** Every live mod runs with the candidate swapped in, but only the candidate's errors fail the test. */
function runTrial() {
  post({ t: "ticking" });
  const bot: Player = { id: "trial-bot", name: "trial-bot", game };
  arrive(bot, false, undefined);
  for (let i = 0; i < 20; i++) {
    tick(0.05);
    flush(false);
  }
  depart(bot, false);
  try {
    JSON.stringify(world.snapshot());
  } catch (e: any) {
    return post({ t: "trial", error: `world is not JSON-serializable: ${e?.message ?? e}` });
  }
  post({ t: "trial", error: null });
}
