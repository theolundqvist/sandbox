import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Entity, ModDb, Player, ServerHooks, ServerMod } from "./api";
import { GameWorld, modDb, type Diff, type Tick } from "./world";

declare var self: Worker;

type Loaded = { id: number; name: string; mod: ServerMod; errors: number; slowTicks: number; ms: number; lastError?: string };
type Event = { from: string; name: string; data: any; to?: string[] };

const world = new GameWorld();
const mods = new Map<string, Loaded>();
let ordered: Loaded[] = [];
let beat: Int32Array;
let trial: string | null = null;
let current: Loaded | null = null;
let events: Event[] = [];

const post = (msg: any) => self.postMessage(msg);

for (const level of ["log", "info", "warn", "error"] as const) {
  console[level] = (...args: any[]) =>
    post({ t: "log", mod: current?.name ?? "engine", level, text: args.map((a) => (typeof a === "string" ? a : Bun.inspect(a))).join(" ") });
}

// ---------- databases ----------
let dbDir = "";
const writers = new Map<string, ModDb>();
const readers = new Map<string, ModDb>();

function ownDb(name: string) {
  const cached = writers.get(name);
  if (cached) return cached;
  const path = join(dbDir, `${name}.sqlite`);
  let db: Database;
  if (trial) {
    const copy = existsSync(path) ? new Database(path, { readonly: true }).serialize() : null;
    // A WAL-mode header makes the in-memory copy unopenable; bytes 18-19 switch it to rollback journaling.
    if (copy) copy[18] = copy[19] = 1;
    db = copy ? Database.deserialize(copy) : new Database(":memory:");
  } else {
    db = new Database(path, { create: true });
    db.run("pragma journal_mode = wal");
    db.run("pragma busy_timeout = 2000");
  }
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
  db.run("pragma busy_timeout = 2000");
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
world.use = (name) => {
  const target = mods.get(name);
  if (!target?.mod.exports) throw new Error(`${name} is not loaded or exports nothing`);
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
  fullPass = true;
}

function guarded<T>(m: Loaded, label: string, fn: () => T): T | undefined {
  const [prev, prevBeat] = [current, Atomics.load(beat, 1)];
  current = m;
  Atomics.store(beat, 1, m.id);
  try {
    return fn();
  } catch (e: any) {
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
  for (const w of ordered) {
    const fn = w !== m ? (w.mod.wrap?.[m.name]?.[hook] as ((...a: any[]) => any) | undefined) : undefined;
    if (!fn) continue;
    const inner = next;
    next = (...a: any[]) => guarded(w, `wrap ${m.name}.${hook}`, () => fn.call(w.mod, inner, world, ...a));
    wrapped = true;
  }
  if (!base && !wrapped) return;
  const started = performance.now();
  const result = next(...args);
  const ms = performance.now() - started;
  m.ms += ms;
  if (hook === "tick") {
    m.slowTicks = ms > 50 ? m.slowTicks + 1 : 0;
    if (m.slowTicks >= 100) fault(m, "every tick took over 50 ms for 5 s", true);
  }
  return result;
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

async function setMod(name: string, id: number, path: string | null) {
  if (!path) {
    mods.delete(name);
    return reorder();
  }
  const loaded: Loaded = { id, name, mod: (await import(path)).default ?? {}, errors: 0, slowTicks: 0, ms: 0 };
  mods.set(name, loaded);
  reorder();
  call(loaded, "load");
}

// ---------- per-player streams ----------
const known = new Map<string, Set<number>>();
const resync = new Set<string>();
let fullPass = true;
let tickCount = 0;

function visible(p: Player, id: number, e: Entity) {
  if (Array.isArray(e.only) && !e.only.includes(p.id)) return false;
  for (const m of ordered) if (m.mod.see && call(m, "see", p, id, e) === false) return false;
  return true;
}

type Out = { reset?: true; set: Record<number, Entity>; unset: Record<number, string[]>; removed: number[]; events?: Omit<Event, "to">[] };

function stream(p: Player, d: Diff, full: boolean): Out {
  const out: Out = { set: {}, unset: {}, removed: [] };
  let seen = known.get(p.id);
  if (!seen || resync.has(p.id)) {
    known.set(p.id, (seen = new Set()));
    full = out.reset = true;
  }
  const show = (id: number, e: Entity) => {
    if (!visible(p, id, e)) {
      if (seen.delete(id)) out.removed.push(id);
    } else if (!seen.has(id)) {
      seen.add(id);
      out.set[id] = e;
    } else {
      if (d.set[id]) out.set[id] = d.set[id];
      if (d.unset[id]) out.unset[id] = d.unset[id];
    }
  };
  if (full) for (const [id, e] of world.entities.raw()) show(id, e);
  else for (const id of new Set([...Object.keys(d.set), ...Object.keys(d.unset)].map(Number))) show(id, world.entities.peek(id)!);
  for (const id of full ? [...seen].filter((id) => !world.entities.has(id)) : d.removed) if (seen.delete(id)) out.removed.push(id);
  const mine = events.filter((ev) => !ev.to || ev.to.includes(p.id)).map(({ from, name, data }) => ({ from, name, data }));
  if (mine.length) out.events = mine;
  return out;
}

function flush() {
  const d = world.delta();
  const full = fullPass || (tickCount % 5 === 0 && ordered.some((m) => m.mod.see));
  const outs: Record<string, string> = {};
  for (const p of world.players.values()) {
    const out = stream(p, d, full);
    if (out.reset || Object.keys(out.set).length || Object.keys(out.unset).length || out.removed.length || out.events) outs[p.id] = JSON.stringify({ t: "tick", ...out });
  }
  fullPass = false;
  resync.clear();
  events = [];
  if (Object.keys(d.set).length || Object.keys(d.unset).length || d.removed.length || Object.keys(outs).length) post({ t: "tick", diff: d, nextId: world.nextId, outs });
}

function tick(dt: number) {
  for (const m of ordered) call(m, "tick", dt);
  tickCount++;
  Atomics.add(beat, 0, 1);
}

self.onmessage = async ({ data: msg }) => {
  switch (msg.t) {
    case "init": {
      beat = new Int32Array(msg.beat);
      world.nextId = msg.nextId;
      for (const [id, e] of Object.entries(msg.entities)) world.entities.set(Number(id), e as any);
      for (const p of msg.players as Player[]) world.players.set(p.id, p);
      trial = msg.trial ?? null;
      dbDir = msg.dbDir;
      world.delta();
      for (const m of msg.mods) {
        try {
          await setMod(m.name, m.id, m.server);
        } catch (e: any) {
          if (trial === m.name) return post({ t: "trial", error: `import: ${e?.stack ?? e}` });
          if (!trial) post({ t: "fault", mod: m.name, error: `import: ${e?.stack ?? e}` });
        }
      }
      if (trial) return runTrial();
      let last = performance.now();
      let busy = 0;
      let ticks = 0;
      setInterval(() => {
        const now = performance.now();
        tick(Math.min((now - last) / 1000, 0.25));
        last = now;
        flush();
        busy += performance.now() - now;
        if (++ticks < 40) return;
        const cost = Object.fromEntries(ordered.filter((m) => m.ms).sort((a, b) => b.ms - a.ms).map((m) => [m.name, +(m.ms / ticks).toFixed(2)]));
        post({ t: "perf", msPerTick: +(busy / ticks).toFixed(2), mods: cost });
        for (const m of ordered) m.ms = 0;
        busy = ticks = 0;
      }, 50);
      return post({ t: "ready" });
    }
    case "mod":
      try {
        await setMod(msg.name, msg.id, msg.server);
        post({ t: "applied", name: msg.name, error: mods.get(msg.name)?.lastError ?? null });
      } catch (e: any) {
        post({ t: "fault", mod: msg.name, error: `import: ${e?.stack ?? e}` });
        post({ t: "applied", name: msg.name, error: `import: ${e?.stack ?? e}` });
      }
      return;
    case "join":
      world.players.set(msg.player.id, msg.player);
      for (const m of ordered) call(m, "join", msg.player);
      return;
    case "resync":
      return void resync.add(msg.id);
    case "see": {
      const p = world.players.get(msg.player);
      // Visibility is checked when an entity changes, so the check runs once per change instead of once per entity per moment.
      const whole = new Map<string, Entity>();
      const shown = new Set<string>();
      const ticks: Tick[] = [];
      for (const t of p ? (msg.ticks as Tick[]) : []) {
        const out: Tick = { at: t.at, reset: t.reset, set: {}, unset: {}, removed: [], activity: t.activity };
        for (const id of t.removed) {
          whole.delete(String(id));
          if (shown.delete(String(id))) out.removed.push(id);
        }
        for (const id of new Set([...Object.keys(t.set), ...Object.keys(t.unset)])) {
          const e = { ...whole.get(id), ...t.set[id] };
          for (const k of t.unset[id] ?? []) delete e[k];
          whole.set(id, e);
          if (!visible(p!, Number(id), e)) {
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
        if (ticks.length % 50 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      return post({ t: "seen", id: msg.id, ticks });
    }
    case "leave": {
      const p = world.players.get(msg.id);
      if (!p) return;
      for (const m of ordered) call(m, "leave", p);
      world.players.delete(msg.id);
      known.delete(msg.id);
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

/** Every live mod runs with the candidate swapped in, but only the candidate's errors fail the test. */
function runTrial() {
  const bot: Player = { id: "trial-bot", name: "trial-bot" };
  world.players.set(bot.id, bot);
  for (const m of ordered) call(m, "join", bot);
  for (let i = 0; i < 20; i++) {
    tick(0.05);
    flush();
  }
  for (const m of ordered) call(m, "leave", bot);
  try {
    JSON.stringify(world.snapshot());
  } catch (e: any) {
    return post({ t: "trial", error: `world is not JSON-serializable: ${e?.message ?? e}` });
  }
  post({ t: "trial", error: null });
}
