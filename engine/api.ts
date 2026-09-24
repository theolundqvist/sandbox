// Module-level variables in mods are wiped on every reload: keep anything that must survive in the world.
import type * as THREE from "three";

export type Entity = Record<string, any>;

export type Player = { id: string; name: string };

/** A solid entity's box: centre, half extents and yaw. */
export type SolidBox = { readonly id: number; readonly x: number; readonly y: number; readonly z: number; readonly hx: number; readonly hy: number; readonly hz: number; readonly yaw: number };

/** An upright cylinder standing on its feet position. Defaults: radius 0.35, height 1.8, step 0.45 (the highest ledge it walks up). */
export type Body = { radius?: number; height?: number; step?: number };

/** `id` is the solid entity hit, or null for ground from a `ground` provider. */
export type RayHit = { distance: number; point: number[]; id: number | null };

/** Collision against terrain from `ground` and entities with `pos` and `solid`: a box centred on pos, turned by rot[1], sized by `solid: { size: [x, y, z] }`, `solid: n` or, for `solid: true`, mesh.size. */
export interface Physics {
  /** Solid boxes whose footprint comes within radius of (x, z). */
  boxes(x: number, z: number, radius: number): SolidBox[];
  /** Height of the highest surface under (x, z) at or just above fromY (default: any height), or null if there is none. */
  groundAt(x: number, z: number, fromY?: number): number | null;
  /** Moves a body with its feet at pos by vel for dt seconds: slides along boxes, steps up ledges, lands on floors. Returns new arrays. */
  move(pos: number[], vel: number[], dt: number, body?: Body): { pos: number[]; vel: number[]; grounded: boolean };
  /** First box or ground surface along dir from origin, within maxDistance. Boxes the origin is inside are ignored. */
  ray(origin: number[], dir: number[], maxDistance: number): RayHit | null;
  /** Adds terrain: fn gives the ground height under a body at (x, fromY, z), or null; higher than the body can step is a wall. Reloading removes it. */
  ground(fn: (x: number, z: number, fromY: number) => number | null): () => void;
}

export interface ModDb {
  run(sql: string, ...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  all<T = any>(sql: string, ...params: any[]): T[];
  get<T = any>(sql: string, ...params: any[]): T | null;
  /** Runs fn atomically; nests safely. Use this instead of raw BEGIN/COMMIT. */
  transaction<T>(fn: () => T): T;
}

export interface World {
  entities: Map<number, Entity>;
  players: Map<string, Player>;
  /** The calling mod's own SQLite database. Writes are durable immediately. */
  db: ModDb;
  /** Another mod's database, read-only. */
  dbOf(mod: string): ModDb;
  /** One-off event for client mods' `event` hook (explosions, sounds, screen shake). `to` limits it to those player ids. */
  emit(name: string, data?: any, to?: string[]): void;
  /** Functions another mod exported with `exports`. They run as that mod (its world.db, its errors). Throws if that mod is not live. */
  use<T = any>(mod: string): T;
  /** Whether that mod is live with exports: check it before use() when your mod works without the other one. */
  has(mod: string): boolean;
  /** Runs fn as this mod after ms milliseconds. */
  later(ms: number, fn: (world: World) => void): void;
  /** Runs async work (fetch, APIs, MCP servers); touch the world only inside run(fn), which runs as this mod. */
  async(work: (run: (fn: (world: World) => void) => void) => Promise<void>): void;
  /** Collision queries against solid entities and terrain. */
  physics: Physics;
  spawn(entity: Entity): number;
  remove(id: number): void;
  query(...components: string[]): [number, Entity][];
}

export interface ServerHooks {
  /** Runs when the mod is loaded or reloaded. Must be idempotent. */
  load?(world: World): void;
  tick?(world: World, dt: number): void;
  join?(world: World, player: Player): void;
  leave?(world: World, player: Player): void;
  /** A message a client mod sent with ctx.send. */
  message?(world: World, player: Player, msg: any): void;
  /** Return false to hide an entity from a player (fog of war, hidden roles). Entities with `only: [playerIds]` are hidden from everyone else without a hook. */
  see?(world: World, player: Player, id: number, entity: Entity): boolean | void;
}

type Wrapped<H> = {
  [K in keyof H]?: H[K] extends ((world: World, ...args: infer A) => infer R) | undefined ? (next: (...args: A) => R, world: World, ...args: A) => R : never;
};

export interface ServerMod extends ServerHooks {
  /** Mods run in ascending order (default 0), then by name. */
  order?: number;
  /** Intercept another mod's hooks by its folder name: call next(...) to let it run, change the args, or skip it. */
  wrap?: Record<string, Wrapped<ServerHooks>>;
  /** Functions other mods call as world.use("<this mod>").fn(...args); they receive (world, ...args). */
  exports?: Record<string, (world: World, ...args: any[]) => any>;
}

export interface ClientCtx {
  THREE: typeof THREE;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** Replicated copy of the server world. Entities with `pos` and `mesh` are drawn automatically. */
  entities: Map<number, Entity>;
  /** Scene objects the default renderer made, by entity id. */
  objects: Map<number, THREE.Object3D>;
  /** The same collision queries as the server's world.physics, over the replicated entities. */
  physics: Physics;
  playerId: string;
  /** Currently held keys, as KeyboardEvent.code (e.g. "KeyW", "Space"). */
  keys: Set<string>;
  /** Sends a message to this mod's server half. */
  send(msg: any): void;
  /** Functions another client mod exported with `exports`. Throws if that mod is not live. */
  use<T = any>(mod: string): T;
  /** Whether that client mod is live with exports: check it before use() when your mod works without the other one. */
  has(mod: string): boolean;
  /** URL of a file added with add_asset: ctx.asset("dragon.glb") for this mod's, ctx.asset("other-mod/dragon.glb") for another's. */
  asset(name: string): string;
  /** Your block in the game menu (Tab) tab with this title, which is created if no tab has it. Extend the engine's "Game", "Builders", "Mods" and "Help" tabs or another mod's tab by using its title. Removed when this mod reloads. */
  menuTab(title: string): HTMLElement;
  /** Your element in one of the engine's screen areas, where every mod's elements stack instead of overlapping: "left" (middle of the left edge), "right" (bottom right, growing up), "bottom" (bottom centre, growing up). Removed when this mod reloads. */
  hud(area: "left" | "right" | "bottom"): HTMLElement;
  /** Offers an action on E. The engine shows one prompt for the nearest available action of any mod, and E (or tapping the prompt) runs only that one. `distance` returns how far the player is from it, or null while it is out of reach. Returns a function that withdraws it; reloading withdraws it too. */
  interact(action: { label: string | (() => string); distance(): number | null; run(): void }): () => void;
}

export interface ClientHooks {
  init?(ctx: ClientCtx): void;
  frame?(ctx: ClientCtx, dt: number): void;
  /** Undo everything init added: the new version's init runs right after. */
  dispose?(ctx: ClientCtx): void;
  /** Wraps the final draw of each frame: call draw() or replace it (post-processing, shaders, split-screen). */
  render?(ctx: ClientCtx, draw: () => void, dt: number): void;
  /** Return your own Object3D to draw this entity, or nothing to leave it to others. Highest `order` asks first. */
  object?(ctx: ClientCtx, id: number, entity: Entity): THREE.Object3D | null | undefined | void;
  /** A one-off event a server mod sent with world.emit. `from` is the emitting mod. */
  event?(ctx: ClientCtx, name: string, data: any, from: string): void;
}

type ClientWrapped = { [K in keyof ClientHooks]?: (next: (...args: any[]) => any, ctx: ClientCtx, ...args: any[]) => any };

export interface ClientMod extends ClientHooks {
  order?: number;
  wrap?: Record<string, ClientWrapped>;
  /** Called as ctx.use("<this mod>").fn(...args); they receive (ctx, ...args). */
  exports?: Record<string, (ctx: ClientCtx, ...args: any[]) => any>;
}

/** Another mod's exports as callers see them, typed from its source so a breaking change fails your typecheck and its reload:
 *  `world.use<Exports<typeof import("../economy/server").default>>("economy").pay("theo", 5)`. */
export type Exports<M extends { exports?: Record<string, (first: any, ...args: any[]) => any> }> = {
  [K in keyof NonNullable<M["exports"]>]: NonNullable<M["exports"]>[K] extends (first: any, ...args: infer A) => infer R ? (...args: A) => R : never;
};
