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
  later!: World["later"];
  async!: World["async"];
  private sent = new Map<number, Map<string, string>>();
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
    for (const [id, e] of this.entities.raw()) {
      if (components.every((c) => c in e)) {
        this.entities.touched.add(id);
        found.push([id, e]);
      }
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
    for (const id of new Set([...touched, ...deleted, ...scan])) {
      const e = this.entities.peek(id);
      const prev = this.sent.get(id);
      if (!e) {
        if (prev) {
          diff.removed.push(id);
          this.sent.delete(id);
        }
        continue;
      }
      const seen = prev ?? new Map<string, string>();
      if (!prev) this.sent.set(id, seen);
      let changed: Entity | undefined;
      for (const key in e) {
        const json = JSON.stringify(e[key]);
        if (seen.get(key) === json) continue;
        seen.set(key, json);
        (changed ??= {})[key] = e[key];
      }
      if (changed) diff.set[id] = changed;
      for (const key of seen.keys()) {
        if (key in e) continue;
        seen.delete(key);
        (diff.unset[id] ??= []).push(key);
      }
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
  db.run("create table if not exists world (id integer primary key check (id = 1), next_id integer, entities text)");
  db.run("create table if not exists snapshots (at integer primary key, next_id integer, entities text)");
  const read = (row: { next_id: number; entities: string } | null, world: Persisted) => {
    if (!row) return false;
    world.nextId = row.next_id;
    world.entities.clear();
    for (const [id, e] of Object.entries(JSON.parse(row.entities))) world.entities.set(Number(id), e as Entity);
    return true;
  };
  return {
    load: (world: Persisted) => read(db.query("select next_id, entities from world").get() as any, world),
    save(world: Persisted) {
      db.run("insert or replace into world values (1, ?, ?)", [world.nextId, JSON.stringify(Object.fromEntries(world.entities))]);
    },
    /** Keeps one snapshot per call for the last hour. */
    snapshot(world: Persisted) {
      db.run("insert or replace into snapshots values (?, ?, ?)", [Date.now(), world.nextId, JSON.stringify(Object.fromEntries(world.entities))]);
      db.run("delete from snapshots where at < ?", [Date.now() - 3_600_000]);
    },
    snapshots: () => (db.query("select at from snapshots order by at desc").all() as { at: number }[]).map((r) => r.at),
    rewind: (at: number, world: Persisted) => read(db.query("select next_id, entities from snapshots where at = ?").get(at) as any, world),
  };
}
