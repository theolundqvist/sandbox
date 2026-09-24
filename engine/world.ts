import { Database } from "bun:sqlite";
import type { Entity, ModDb, Player, World } from "./api";

export class GameWorld implements World {
  entities = new Map<number, Entity>();
  players = new Map<string, Player>();
  nextId = 1;
  declare db: ModDb;
  dbOf!: (mod: string) => ModDb;
  private sent = new Map<number, string>();

  spawn(entity: Entity) {
    const id = this.nextId++;
    this.entities.set(id, entity);
    return id;
  }

  remove(id: number) {
    this.entities.delete(id);
  }

  query(...components: string[]): [number, Entity][] {
    return [...this.entities].filter(([, e]) => components.every((c) => c in e));
  }

  snapshot() {
    return Object.fromEntries(this.entities);
  }

  // Diffing serialized entities catches direct mutation, so mods never have to mark anything dirty.
  delta() {
    const set: Record<number, Entity> = {};
    for (const [id, e] of this.entities) {
      const json = JSON.stringify(e);
      if (this.sent.get(id) !== json) {
        this.sent.set(id, json);
        set[id] = e;
      }
    }
    const removed = [...this.sent.keys()].filter((id) => !this.entities.has(id));
    for (const id of removed) this.sent.delete(id);
    return { set, removed };
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
  return {
    load(world: Persisted) {
      const row = db.query("select next_id, entities from world").get() as { next_id: number; entities: string } | null;
      if (!row) return;
      world.nextId = row.next_id;
      for (const [id, e] of Object.entries(JSON.parse(row.entities))) world.entities.set(Number(id), e as Entity);
    },
    save(world: Persisted) {
      db.run("insert or replace into world values (1, ?, ?)", [world.nextId, JSON.stringify(Object.fromEntries(world.entities))]);
    },
  };
}
