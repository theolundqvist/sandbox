import { Database } from "bun:sqlite";
import type { Entity, ModDb, Player, World } from "./api";

export type Diff = { set: Record<number, Entity>; unset: Record<number, string[]>; removed: number[] };

/** Whether two JSON values are equal, the way JSON.stringify would see them, without building strings. */
function same(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a !== a && b !== b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  let n = 0;
  for (const k in a) {
    if (a[k] === undefined) continue;
    if (!same(a[k], b[k])) return false;
    n++;
  }
  for (const k in b) if (b[k] !== undefined) n--;
  return n === 0;
}

/** Plain map iteration, so mods scan the world at full speed; only removals are noted. */
class Entities extends Map<number, Entity> {
  removed = new Set<number>();
  override delete(id: number) {
    this.removed.add(id);
    return super.delete(id);
  }
}

export class GameWorld implements World {
  entities = new Entities();
  players = new Map<string, Player>();
  nextId = 1;
  declare db: ModDb;
  dbOf!: (mod: string) => ModDb;
  emit!: World["emit"];
  use!: World["use"];
  has!: World["has"];
  later!: World["later"];
  async!: World["async"];
  physics!: World["physics"];
  enter!: World["enter"];
  /** A copy of what players last received of each entity. */
  private sent = new Map<number, Entity>();

  spawn(entity: Entity) {
    const id = this.nextId++;
    this.entities.set(id, entity);
    return id;
  }

  remove(id: number) {
    this.entities.delete(id);
  }

  /** Each simulation runs one game, so its players are that game's. */
  playersInGame() {
    return new Map(this.players);
  }

  query(...components: string[]): [number, Entity][] {
    const found: [number, Entity][] = [];
    outer: for (const [id, e] of this.entities) {
      for (const c of components) if (!(c in e)) continue outer;
      found.push([id, e]);
    }
    return found;
  }

  snapshot() {
    return Object.fromEntries(this.entities);
  }

  /**
   * Component-level changes since the last call. Every entity is compared with what players last got, so a change
   * arrives on the next tick however a mod made it, including through a reference it kept from an earlier tick.
   */
  delta(): Diff {
    const diff: Diff = { set: {}, unset: {}, removed: [] };
    for (const [id, e] of this.entities) {
      const prev = this.sent.get(id);
      if (prev && same(e, prev)) continue;
      let changed: Entity | undefined;
      for (const key in e) if (e[key] !== undefined && (!prev || !same(e[key], prev[key]))) (changed ??= {})[key] = e[key];
      if (changed) diff.set[id] = changed;
      if (prev) for (const key in prev) if (prev[key] !== undefined && e[key] === undefined) (diff.unset[id] ??= []).push(key);
      this.sent.set(id, JSON.parse(JSON.stringify(e)));
    }
    for (const id of this.entities.removed) {
      if (this.entities.has(id) || !this.sent.delete(id)) continue;
      diff.removed.push(id);
    }
    this.entities.removed.clear();
    return diff;
  }
}

export function modDb(db: Database): ModDb {
  return {
    run: (sql, ...params) => db.run(sql, ...params),
    all: (sql, ...params) => db.query(sql).all(...params) as any[],
    get: (sql, ...params) => db.query(sql).get(...params) as any,
    transaction: (fn) => db.transaction(fn)(),
  };
}

type Persisted = { entities: Map<number, Entity>; nextId: number };

const WORLD_TABLE = "create table if not exists world (id integer primary key check (id = 1), next_id integer, entities text)";

/** A new world's starting entities, which the server loads the way it loads a rewind. */
export function seedStore(path: string, nextId: number, entities: Record<string, Entity>) {
  const db = new Database(path, { create: true });
  db.run(WORLD_TABLE);
  db.run("insert or replace into world values (1, ?, ?)", [nextId, JSON.stringify(entities)]);
  db.close();
}

export function openStore(path: string) {
  const db = new Database(path, { create: true });
  db.run("pragma busy_timeout = 5000");
  // Saves and timelapse moments commit on the server's main thread every few seconds; without WAL each waits on a disk flush and the timelapse reader blocks them.
  db.run("pragma journal_mode = wal");
  db.run("pragma synchronous = normal");
  db.run(WORLD_TABLE);
  db.run("create table if not exists entity (id integer primary key, data text not null)");
  db.run("create table if not exists snapshots (at integer primary key, next_id integer, entities text)");
  db.run("create table if not exists timelapse (at integer primary key, full integer, data blob, activity text)");
  if (!db.query("select 1 from pragma_table_info('timelapse') where name = 'activity'").get()) db.run("alter table timelapse add column activity text");
  let pending: Moment = { set: {}, unset: {}, removed: [] };
  let sinceFull = -1;
  /** Entities changed since the last save, or "all" when the whole world was replaced. */
  let dirty: Set<number> | "all" = new Set();
  const read = (row: { next_id: number; entities: string } | null, world: Persisted) => {
    if (!row) return false;
    world.nextId = row.next_id;
    world.entities.clear();
    for (const [id, e] of Object.entries(JSON.parse(row.entities))) world.entities.set(Number(id), e as Entity);
    dirty = "all";
    return true;
  };
  const upsert = db.prepare("insert or replace into entity values (?, ?)");
  const remove = db.prepare("delete from entity where id = ?");
  return {
    /** Replaces the world's entities with the save's, never merging into what is there, which could bring back something removed since. */
    load(world: Persisted) {
      const meta = db.query("select next_id, entities from world").get() as { next_id: number; entities: string | null } | null;
      if (!meta?.entities) {
        if (!meta) return false;
        world.nextId = meta.next_id;
        world.entities.clear();
        for (const row of db.query("select id, data from entity").all() as { id: number; data: string }[]) world.entities.set(row.id, JSON.parse(row.data));
        return true;
      }
      return read(meta as { next_id: number; entities: string }, world);
    },
    /** Writes only the entities that changed since the last save, in one transaction. */
    save: db.transaction((world: Persisted) => {
      if (dirty === "all") db.run("delete from entity");
      for (const id of dirty === "all" ? world.entities.keys() : dirty) {
        const e = world.entities.get(id);
        if (e) upsert.run(id, JSON.stringify(e));
        else remove.run(id);
      }
      db.run("insert or replace into world values (1, ?, null)", [world.nextId]);
      dirty = new Set();
    }),
    /** Keeps one snapshot per call for the last hour. */
    snapshot(world: Persisted) {
      db.run("insert or replace into snapshots values (?, ?, ?)", [Date.now(), world.nextId, JSON.stringify(Object.fromEntries(world.entities))]);
      db.run("delete from snapshots where at < ?", [Date.now() - 3_600_000]);
    },
    /** Folds one simulation tick's changes into the next timelapse moment, so recording never diffs the whole world. */
    track(d: Diff) {
      if (dirty !== "all") for (const id of [...Object.keys(d.set), ...Object.keys(d.unset), ...d.removed]) dirty.add(Number(id));
      for (const [id, set] of Object.entries(d.set)) {
        pending.set[id] = { ...pending.set[id], ...set };
        const lost = pending.unset[id]?.filter((k) => !(k in set));
        if (lost) pending.unset[id] = lost;
      }
      for (const [id, keys] of Object.entries(d.unset)) {
        for (const k of keys) delete pending.set[id]?.[k];
        pending.unset[id] = [...new Set([...(pending.unset[id] ?? []), ...keys])];
      }
      for (const id of d.removed) {
        delete pending.set[id];
        delete pending.unset[id];
        pending.removed.push(id);
      }
    },
    /** The next moment records the whole world, as after a rewind replaced it. */
    keyframe() {
      sinceFull = -1;
    },
    /** A timelapse moment; the whole world at the start (full 1) and every 150th (full 2, whose changes also go into the next moment) so old ones can be dropped. */
    record(world: Persisted, activity: Activity[]) {
      const full = sinceFull < 0 ? 1 : sinceFull >= 149 ? 2 : 0;
      sinceFull = full ? 0 : sinceFull + 1;
      const data = full ? Object.fromEntries(world.entities) : pending;
      db.run("insert or replace into timelapse values (?, ?, ?, ?)", [Date.now(), full, Bun.gzipSync(JSON.stringify(data)), JSON.stringify(activity)]);
      if (full !== 2) pending = { set: {}, unset: {}, removed: [] };
      db.run("delete from timelapse where at < ?", [Date.now() - 3 * 3_600_000]);
    },
    snapshots: () => (db.query("select at from snapshots order by at desc").all() as { at: number }[]).map((r) => r.at),
    rewind: (at: number, world: Persisted) => read(db.query("select next_id, entities from snapshots where at = ?").get(at) as any, world),
    close: () => db.close(),
  };
}

/** Changed components per entity, the components they lost, and removed entities. */
export type Moment = { set: Record<string, Entity>; unset: Record<string, string[]>; removed: number[] };
/** `mods`: client builds that went live (a url) or away (null) by this tick; the first tick lists every live one. */
export type Tick = Moment & { at: number; reset?: true; activity?: Activity[]; mods?: Record<string, string | null> };
/** What players saw happen: feed lines, chat (typed or spoken) and mod banners. */
export type Activity = { at: number } & (
  | { t: "feed"; text: string; kind: string }
  | { t: "chat"; from: string; text: string; spoken?: boolean; game?: string }
  | { t: "announce"; mod: string; by: string; title: string; text: string; color: string }
);
