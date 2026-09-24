import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ModDb, Player, ServerHooks, ServerMod } from "./api";
import { GameWorld, modDb } from "./world";

declare var self: Worker;

type Loaded = { id: number; name: string; mod: ServerMod; errors: number; slowTicks: number; lastError?: string };

const world = new GameWorld();
const mods = new Map<string, Loaded>();
let beat: Int32Array;
let trial: string | null = null;
let current: Loaded | null = null;

const post = (msg: any) => self.postMessage(msg);

let dbDir = "";
const writers = new Map<string, ModDb>();
const readers = new Map<string, ModDb>();

function ownDb(name: string) {
  const cached = writers.get(name);
  if (cached) return cached;
  const path = join(dbDir, `${name}.sqlite`);
  let db: Database;
  if (trial === name) {
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
  if (trial === name) return ownDb(name);
  const cached = readers.get(name);
  if (cached) return cached;
  const path = join(dbDir, `${name}.sqlite`);
  if (!existsSync(path)) throw new Error(`${name} has no database yet`);
  const db = new Database(path, { readonly: true });
  db.run("pragma busy_timeout = 2000");
  readers.set(name, modDb(db));
  return readers.get(name)!;
}

Object.defineProperty(world, "db", {
  get() {
    if (!current) throw new Error("world.db is only available inside a mod hook");
    return ownDb(current.name);
  },
});
world.dbOf = readDb;

for (const level of ["log", "info", "warn", "error"] as const) {
  console[level] = (...args: any[]) =>
    post({ t: "log", mod: current?.name ?? "engine", level, text: args.map((a) => (typeof a === "string" ? a : Bun.inspect(a))).join(" ") });
}

let ordered: Loaded[] = [];

function reorder() {
  ordered = [...mods.values()].sort((a, b) => (a.mod.order ?? 0) - (b.mod.order ?? 0) || a.name.localeCompare(b.name));
}

function guarded(m: Loaded, label: string, fn: () => void) {
  const [prev, prevBeat] = [current, Atomics.load(beat, 1)];
  current = m;
  Atomics.store(beat, 1, m.id);
  try {
    fn();
  } catch (e: any) {
    m.lastError = `${label}: ${e?.stack ?? e}`;
    fault(m, m.lastError, ++m.errors >= 10);
  } finally {
    Atomics.store(beat, 1, prevBeat);
    current = prev;
  }
}

function call(m: Loaded, hook: keyof ServerHooks, ...args: any[]) {
  const base = m.mod[hook] as ((...a: any[]) => void) | undefined;
  let next = (...a: any[]) => guarded(m, hook, () => base?.call(m.mod, world, ...a));
  let wrapped = false;
  for (const w of ordered) {
    const fn = w !== m ? (w.mod.wrap?.[m.name]?.[hook] as ((...a: any[]) => void) | undefined) : undefined;
    if (!fn) continue;
    const inner = next;
    next = (...a: any[]) => guarded(w, `wrap ${m.name}.${hook}`, () => fn.call(w.mod, inner, world, ...a));
    wrapped = true;
  }
  if (!base && !wrapped) return;
  const started = performance.now();
  next(...args);
  if (hook !== "tick") return;
  m.slowTicks = performance.now() - started > 50 ? m.slowTicks + 1 : 0;
  if (m.slowTicks >= 100) fault(m, "every tick took over 50 ms for 5 s", true);
}

function fault(m: Loaded, error: string, fatal: boolean) {
  if (trial === m.name) post({ t: "trial", error });
  else post({ t: "log", mod: m.name, level: "error", text: error });
  if (fatal && trial !== m.name && mods.get(m.name) === m) {
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
  const loaded: Loaded = { id, name, mod: (await import(path)).default ?? {}, errors: 0, slowTicks: 0 };
  mods.set(name, loaded);
  reorder();
  call(loaded, "load");
}

function tick(dt: number) {
  for (const m of ordered) call(m, "tick", dt);
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
          post({ t: "fault", mod: m.name, error: `import: ${e?.stack ?? e}` });
        }
      }
      if (trial) return runTrial(trial);
      let last = performance.now();
      setInterval(() => {
        const now = performance.now();
        tick(Math.min((now - last) / 1000, 0.25));
        last = now;
        const d = world.delta();
        if (Object.keys(d.set).length || d.removed.length) post({ t: "delta", ...d, nextId: world.nextId });
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
    case "leave": {
      const p = world.players.get(msg.id);
      if (!p) return;
      for (const m of ordered) call(m, "leave", p);
      world.players.delete(msg.id);
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

function runTrial(name: string) {
  const bot: Player = { id: "trial-bot", name: "trial-bot" };
  const m = mods.get(name);
  if (m) {
    world.players.set(bot.id, bot);
    call(m, "join", bot);
    for (let i = 0; i < 20; i++) call(m, "tick", 0.05);
    call(m, "leave", bot);
    try {
      JSON.stringify(world.snapshot());
    } catch (e: any) {
      return post({ t: "trial", error: `world is not JSON-serializable: ${e?.message ?? e}` });
    }
  }
  post({ t: "trial", error: null });
}
