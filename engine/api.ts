// Module-level variables in mods are wiped on every reload: keep anything that must survive in the world.
import type * as THREE from "three";

export type Entity = Record<string, any>;

export type Player = { id: string; name: string };

export interface World {
  entities: Map<number, Entity>;
  players: Map<string, Player>;
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
}

type Wrapped<H> = { [K in keyof H]?: H[K] extends ((world: World, ...args: infer A) => void) | undefined ? (next: (...args: A) => void, world: World, ...args: A) => void : never };

export interface ServerMod extends ServerHooks {
  /** Mods run in ascending order (default 0), then by name. */
  order?: number;
  /** Intercept another mod's hooks by its folder name: call next(...) to let it run, change the args, or skip it. */
  wrap?: Record<string, Wrapped<ServerHooks>>;
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
  playerId: string;
  /** Currently held keys, as KeyboardEvent.code (e.g. "KeyW", "Space"). */
  keys: Set<string>;
  /** Sends a message to this mod's server half. */
  send(msg: any): void;
}

export interface ClientHooks {
  init?(ctx: ClientCtx): void;
  frame?(ctx: ClientCtx, dt: number): void;
  /** Undo everything init added: the new version's init runs right after. */
  dispose?(ctx: ClientCtx): void;
}

type ClientWrapped = { [K in keyof ClientHooks]?: (next: (...args: any[]) => void, ctx: ClientCtx, ...args: any[]) => void };

export interface ClientMod extends ClientHooks {
  order?: number;
  wrap?: Record<string, ClientWrapped>;
}
