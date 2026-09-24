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
  db.run("create table if not exists world (id integer primary key check (id = 1), next_id integer, entities text)");
  db.run("create table if not exists snapshots (at integer primary key, next_id integer, entities text)");
  db.run("create table if not exists timelapse (at integer primary key, full integer, data blob)");
  let last: Record<string, Entity> | null = null;
  let sinceFull = 0;
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
    /** A timelapse moment: what changed since the last one, with the whole world every 150th so old moments can be dropped. */
    record(world: Persisted) {
      const now: Record<string, Entity> = JSON.parse(JSON.stringify(Object.fromEntries(world.entities)));
      const full = !last || ++sinceFull >= 150;
      if (full) sinceFull = 0;
      db.run("insert or replace into timelapse values (?, ?, ?)", [Date.now(), full ? 1 : 0, Bun.gzipSync(JSON.stringify(full ? now : changes(last!, now)))]);
      last = now;
      db.run("delete from timelapse where at < ?", [Date.now() - 3 * 3_600_000]);
    },
    /** Up to `limit` recorded moments, oldest first, evenly spread. */
    /** Up to `limit` evenly spaced moments as ticks: the first in full, then what changed since the previous one. */
    ticks(limit: number) {
      const rows = db.query("select at, full, data from timelapse order by at").all() as { at: number; full: number; data: Uint8Array<ArrayBuffer> }[];
      const usable = rows.slice(Math.max(0, rows.findIndex((r) => r.full)));
      const every = Math.ceil(usable.length / limit);
      const state: Record<string, Entity> = {};
      let before = new Map<string, Entity | undefined>();
      const touch = (id: string) => before.has(id) || before.set(id, state[id]);
      const ticks: Tick[] = [];
      usable.forEach((row, i) => {
        const data = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(row.data)));
        const set: Record<string, Entity> = row.full ? data : data.set;
        const removed: string[] = row.full ? Object.keys(state).filter((id) => !(id in data)) : data.removed.map(String);
        for (const id of [...Object.keys(set), ...removed]) touch(id);
        Object.assign(state, set);
        for (const id of removed) delete state[id];
        if (i % every) return;
        if (!ticks.length) ticks.push({ at: row.at, reset: true, set: { ...state }, unset: {}, removed: [] });
        else {
          const tick: Tick = { at: row.at, set: {}, unset: {}, removed: [] };
          for (const [id, was] of before) {
            const now = state[id];
            if (!now) {
              if (was) tick.removed.push(Number(id));
            } else if (now !== was) {
              tick.set[id] = now;
              if (was) tick.unset[id] = Object.keys(was).filter((k) => !(k in now));
            }
          }
          ticks.push(tick);
        }
        before = new Map();
      });
      return ticks;
    },
    snapshots: () => (db.query("select at from snapshots order by at desc").all() as { at: number }[]).map((r) => r.at),
    rewind: (at: number, world: Persisted) => read(db.query("select next_id, entities from snapshots where at = ?").get(at) as any, world),
  };
}

export type Tick = { at: number; reset?: true; set: Record<string, Entity>; unset: Record<string, string[]>; removed: number[] };

/** What differs between two moments; changed entities are sent whole, with the keys they lost. */
export function changes(before: Record<string, Entity>, after: Record<string, Entity>) {
  const set: Record<string, Entity> = {};
  const unset: Record<string, string[]> = {};
  for (const [id, e] of Object.entries(after)) {
    const was = before[id];
    if (JSON.stringify(e) === JSON.stringify(was)) continue;
    set[id] = e;
    if (was) unset[id] = Object.keys(was).filter((k) => !(k in e));
  }
  return { set, unset, removed: Object.keys(before).filter((id) => !(id in after)).map(Number) };
}
