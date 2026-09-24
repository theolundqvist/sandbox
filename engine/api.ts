// Module-level variables in mods are wiped on every reload: keep anything that must survive in the world.
import type * as THREE from "three";

export type Entity = Record<string, any>;

export type Player = { id: string; name: string };

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
  /** Functions another mod exported with `exports`. They run as that mod (its world.db, its errors). */
  use<T = any>(mod: string): T;
  /** Runs fn as this mod after ms milliseconds. */
  later(ms: number, fn: (world: World) => void): void;
  /** Runs async work (fetch, APIs, MCP servers); touch the world only inside run(fn), which runs as this mod. */
  async(work: (run: (fn: (world: World) => void) => void) => Promise<void>): void;
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
  playerId: string;
  /** Currently held keys, as KeyboardEvent.code (e.g. "KeyW", "Space"). */
  keys: Set<string>;
  /** Sends a message to this mod's server half. */
  send(msg: any): void;
  /** Functions another client mod exported with `exports`. */
  use<T = any>(mod: string): T;
  /** URL of a file added with add_asset: ctx.asset("dragon.glb") for this mod's, ctx.asset("other-mod/dragon.glb") for another's. */
  asset(name: string): string;
  /** Your block in the game menu (Tab) tab with this title, which is created if no tab has it. Extend the engine's "Game", "Builders", "Mods" and "Help" tabs or another mod's tab by using its title. Removed when this mod reloads. */
  menuTab(title: string): HTMLElement;
  /** Your element in one of the engine's screen areas, where every mod's elements stack instead of overlapping: "left" (middle of the left edge), "right" (bottom right, growing up), "bottom" (bottom centre, growing up). Removed when this mod reloads. */
  hud(area: "left" | "right" | "bottom"): HTMLElement;
  /** Offers an action on E. The engine shows one prompt for the nearest available action of any mod, and E (or tapping the prompt) runs only that one. `distance` returns how far the player is from it, or null while it is out of reach. Returns a function that withdraws it; reloading withdraws it too. */
  interact(action: { label: string | (() => string); distance(): number | null; run(): void }): () => void;
  /** Binds a key (KeyboardEvent.code, e.g. "KeyM") labelled in Cmd+K and Help: run(true) on press, run(false) on release with `hold`, or { down, up }. Never fires while the player types, has the menu, Cmd+K, chat or another mod's panel open. The later of two mods declaring a key wins and both are warned. Tab, Enter, T and E are the engine's and throw; 1 and 2 go to votes while the vote bar shows. Returns a remover; reloading removes it too. */
  key(code: string, label: string, run: ((down: boolean) => void) | { down?(): void; up?(): void }, opts?: { hold?: boolean }): () => void;
  /** Shows el as this mod's window (centred on the page when el is not in the document): frees the mouse, pauses other mods' keys and ctx.keys, closes on Esc and gives the mouse back when closed. Opening a panel closes the open one. */
  panel(el: HTMLElement, opts?: { onClose?(): void }): { close(): void };
  /** True while the player controls the game: not typing, no menu, Cmd+K, chat or panel open. For mods that still listen to keys themselves. */
  inputFree(): boolean;
  /** The shared audio graph: connect sounds to `output` (master volume), or use `listener` (on the camera) for THREE.Audio and THREE.PositionalAudio. Resumed on the player's first click or key. */
  audio: { context: AudioContext; listener: THREE.AudioListener; output: GainNode };
  /** Shakes the camera, fading out over `seconds`. Every mod's shakes add up; the engine offsets the camera only while drawing, so camera.position stays yours. */
  shake(strength: number, seconds: number): void;
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
