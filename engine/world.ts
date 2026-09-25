import { Database } from "bun:sqlite";
import type { Entity, ModDb, Player, World } from "./api";

export type Diff = { set: Record<number, Entity>; unset: Record<number, string[]>; removed: number[] };

/** Records which entities mods reach, so a tick only diffs what could have changed. */
class TrackedMap extends Map<number, Entity> {
  touched = new Set<number>();
  deleted = new Set<number>();
  private tracking = false;

  track() {
    this.tracking = true;
    return this;
  }
  override get(id: number) {
    if (this.tracking) this.touched.add(id);
    return super.get(id);
  }
  override set(id: number, e: Entity) {
    if (this.tracking) this.touched.add(id);
    return super.set(id, e);
  }
  override delete(id: number) {
    if (this.tracking) this.deleted.add(id);
    return super.delete(id);
  }
  override forEach(fn: (e: Entity, id: number, map: Map<number, Entity>) => void) {
    for (const [id, e] of this) fn(e, id, this);
  }
  override *entries(): MapIterator<[number, Entity]> {
    for (const pair of super.entries()) {
      if (this.tracking) this.touched.add(pair[0]);
      yield pair;
    }
  }
  override *values(): MapIterator<Entity> {
    for (const [, e] of this.entries()) yield e;
  }
  override [Symbol.iterator]() {
    return this.entries();
  }
  /** Reads without marking anything touched. */
  raw() {
    return super.entries();
  }
  peek(id: number) {
    return super.get(id);
  }
}

export class GameWorld implements World {
  entities = new TrackedMap().track();
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
  /** What players last received of each entity, as JSON. */
  private sent = new Map<number, string>();
  private cursor: number[] = [];

  spawn(entity: Entity) {
    const id = this.nextId++;
    this.entities.set(id, entity);
    return id;
  }

  remove(id: number) {
    this.entities.delete(id);
  }

  query(...components: string[]): [number, Entity][] {
    const found: [number, Entity][] = [];
    outer: for (const [id, e] of this.entities.raw()) {
      for (const c of components) if (!(c in e)) continue outer;
      this.entities.touched.add(id);
      found.push([id, e]);
    }
    return found;
  }

  snapshot() {
    return Object.fromEntries(this.entities.raw());
  }

  /**
   * Component-level changes since the last call. Entities mods reached this tick are diffed; a rolling 5% scan
   * catches mutations through references a mod kept from an earlier tick, so those arrive within a second.
   */
  delta(): Diff {
    const { touched, deleted } = this.entities;
    if (!this.cursor.length) this.cursor = [...new Set([...this.sent.keys(), ...[...this.entities.raw()].map(([id]) => id)])];
    const scan = this.cursor.splice(0, Math.max(64, Math.ceil(this.entities.size / 20)));
    const diff: Diff = { set: {}, unset: {}, removed: [] };
    for (const id of deleted) touched.add(id);
    for (const id of scan) touched.add(id);
    for (const id of touched) {
      const e = this.entities.peek(id);
      const prev = this.sent.get(id);
      if (!e) {
        if (prev !== undefined) {
          diff.removed.push(id);
          this.sent.delete(id);
        }
        continue;
      }
      const json = JSON.stringify(e);
      if (prev === json) continue;
      this.sent.set(id, json);
      const old: Entity = prev === undefined ? {} : JSON.parse(prev);
      let changed: Entity | undefined;
      for (const key in e) if (!(key in old) || JSON.stringify(e[key]) !== JSON.stringify(old[key])) (changed ??= {})[key] = e[key];
      if (changed) diff.set[id] = changed;
      for (const key in old) if (!(key in e)) (diff.unset[id] ??= []).push(key);
    }
    touched.clear();
    deleted.clear();
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

export function openStore(path: string) {
  const db = new Database(path, { create: true });
  db.run("pragma busy_timeout = 5000");
  // Saves and timelapse moments commit on the server's main thread every few seconds; without WAL each waits on a disk flush and the timelapse reader blocks them.
  db.run("pragma journal_mode = wal");
  db.run("pragma synchronous = normal");
  db.run("create table if not exists world (id integer primary key check (id = 1), next_id integer, entities text)");
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
    load(world: Persisted) {
      const meta = db.query("select next_id, entities from world").get() as { next_id: number; entities: string | null } | null;
      if (!meta?.entities) {
        if (!meta) return false;
        world.nextId = meta.next_id;
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
  };
}

/** Changed components per entity, the components they lost, and removed entities. */
export type Moment = { set: Record<string, Entity>; unset: Record<string, string[]>; removed: number[] };
export type Tick = Moment & { at: number; reset?: true; activity?: Activity[] };
/** What players saw happen: feed lines, chat (typed or spoken) and mod banners. */
export type Activity = { at: number } & (
  | { t: "feed"; text: string; kind: string }
  | { t: "chat"; from: string; text: string; spoken?: boolean }
  | { t: "announce"; mod: string; by: string; title: string; text: string; color: string }
);
