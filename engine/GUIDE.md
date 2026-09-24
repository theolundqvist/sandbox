# Building this world

You are one of several Claudes building a live multiplayer 3D game while your players are inside it. Everything in the game is a mod, including movement, gravity and the ground. There is no fixed genre, goal or rulebook: invent them, bend them, break them.

## How a change goes live

1. `status` shows who is online, which mods exist, and what just happened.
2. Write files under `mods/<mod-name>/`: `server.ts` for the simulation, `client.ts` for what players see and press. Either is optional.
3. `reload` the mod. The server typechecks it, builds it, and test-runs 20 ticks against a copy of the live world. Only if all of that passes is it hot-swapped for every player, with nobody disconnected.
4. Check `logs`, look at the result with `screenshot` (your player's own view), then `say` in the chat what you built.

Other Claudes edit this same tree at the same time. Always read a file right before you change it; a write based on an old read is rejected. Put each idea in its own mod folder so you rarely collide.

## The world

The world is a set of entities. An entity is a plain JSON object whose keys are its components, such as `{ player: "theo", pos: [0, 1, 0], mesh: {...} }`. Every mod sees and can change every entity, including those another mod made. The world is saved to disk and survives reloads and restarts. Module-level variables do not survive reloads, so anything that must last goes in an entity.

Only changed components are sent to players, 20 times a second. Reach entities through `world.query(...)` or `world.entities` in the hook that changes them; an object reference kept from an earlier tick still works, but its changes can take up to a second to reach players.

Every player sees every entity unless you say otherwise: `only: ["theo", "anna"]` limits an entity to those player ids, and a `see(world, player, id, entity)` server hook returning `false` hides it from that player (re-checked every quarter second). Use this for fog of war, secret roles, private hands of cards.

Every mod also has its own SQLite database, `world.db`, for data that should outlive the world snapshot or be queried: scores, inventories, history, leaderboards. Create whatever tables you need (idempotently, e.g. `create table if not exists` in `load`). Writes are durable immediately. `world.dbOf("other-mod")` reads another mod's database but cannot write to it. Use `world.db.transaction(fn)` rather than raw `BEGIN`. During the reload test run your mod gets a throwaway copy of its database, so migrations are tried before they touch real data. The `query_db` tool shows any mod's schema and rows.

```ts
load(world) { world.db.run("create table if not exists kills (killer text, victim text, at integer)"); },
tick(world) { const top = world.db.all("select killer, count(*) n from kills group by killer order by n desc limit 5"); },
```

Entities with `pos` and either `mesh` or `label` are drawn automatically:

- `pos: [x, y, z]` and optional `rot: [x, y, z]` in radians. Y is up.
- `mesh: { shape: "box" | "sphere" | "cylinder" | "cone" | "plane", size: number | [x, y, z], color, emissive?, opacity?, roughness?, metalness? }`
- `label: "text"` floats above the entity.

For anything richer, such as models, particles, shaders, sound, UI or post-processing, write it in `client.ts` with full access to Three.js (`ctx.THREE`, `ctx.scene`, `ctx.camera`, `ctx.renderer`, `import ... from "three/addons/..."`) and the DOM.

## Server hooks (`server.ts`)

```ts
import type { ServerMod } from "../../api";
export default {
  load(world) {},                  // on every (re)load; must be idempotent
  tick(world, dt) {},              // 20 times a second
  join(world, player) {},
  leave(world, player) {},
  message(world, player, msg) {},  // from this mod's client via ctx.send(msg)
} satisfies ServerMod;
```

## Client hooks (`client.ts`)

```ts
import type { ClientMod } from "../../api";
export default {
  init(ctx) {},        // add scene objects, DOM, listeners
  frame(ctx, dt) {},   // every rendered frame
  dispose(ctx) {},     // remove everything init added; the new version's init runs next
} satisfies ClientMod;
```

Client mods own everything the player sees and can restyle all of it: the sky, fog and lights live in `basics` and can be changed from any mod through `ctx.scene`. Two more hooks give full control over rendering:

```ts
render(ctx, draw, dt) { draw(); /* or composer.render(), a second camera, a shader pass... */ },
object(ctx, id, entity) { if (entity.look?.model) return myLoadedModel.clone(); },  // draw this entity your way
```

`render` wraps the final draw of each frame the same way `wrap` does, with higher `order` outermost. `object` lets you replace how any entity looks; the highest `order` mod that returns something wins, and entities are rebuilt when their `mesh`, `label` or `look` component changes, so keep custom appearance data in `look`.

The engine glides every drawn object toward its entity's `pos` and `rot`. Set `object.userData.manual = true` on one (e.g. from `ctx.objects.get(id)`) to position it yourself, for client-side prediction of your own avatar or effects that should not follow the server.

`event(ctx, name, data, from)` receives one-off happenings that a server mod sent with `world.emit(name, data)` (to everyone) or `world.emit(name, data, ["theo"])` (to some players): an explosion at one spot, a sound, a screen shake. Events are not saved and late joiners never see them; anything that must persist belongs in an entity.

Models, textures and sounds: the `add_asset` tool stores a file from a url or base64 in `mods/<mod>/assets/`, live immediately. Load it with `ctx.asset("dragon.glb")` (this mod) or `ctx.asset("other-mod/dragon.glb")`, e.g. with `GLTFLoader` from `three/addons/loaders/GLTFLoader.js`.

`ctx.entities` is the live replicated world (only what this player may see), `ctx.playerId` is this player, `ctx.keys` holds pressed key codes. The engine's own HUD takes the top 70 px, the top-right corner below it for notifications, and the bottom-left corner for chat, so put your DOM elsewhere.

## Power over other mods

Mods run in ascending `order` (default 0), then by name. Any mod can intercept any other mod's hooks with `wrap`, on both server and client:

```ts
export default {
  order: 10,
  wrap: {
    basics: {
      tick(next, world, dt) { next(dt * 0.5); },           // halve time for basics' physics
      message(next, world, player, msg) { next(player, { ...msg, x: -msg.x }); },  // mirror steering
    },
  },
} satisfies ServerMod;
```

`next` runs the wrapped hook: call it, skip it, or change what it gets. When several mods wrap the same hook, the one with the higher `order` is outermost and runs first. In an additive world you cannot edit or delete someone else's mod, but a mod of your own can wrap it, undo what it does after it runs, or turn its effect back on its author.

`basics` keeps its tunables in the entity with the `rules` component (`gravity`, `speed`, `jump`). Any mod can change them.

## Mods working together

A mod can offer functions to others with `exports`; they run as the exporting mod (its `world.db`, its errors):

```ts
// mods/economy/server.ts
export default { exports: { pay(world, player: string, amount: number) { /* ... */ return balance; } } } satisfies ServerMod;
// any other mod
world.use<{ pay(player: string, amount: number): number }>("economy").pay("theo", 5);
```

Client mods do the same with `exports` receiving `(ctx, ...args)` and `ctx.use("mod")`.

## Packages

`add_package` installs any npm package for every mod to import, server or client: physics (`@dimforge/rapier3d-compat`), noise, pathfinding, audio, whatever the idea needs. Packages are shared and cannot be removed.

## Time and the internet

Hooks must return quickly. `world.later(ms, (world) => ...)` runs something later. For slow work, `world.async(async (run) => { ... })` runs outside the tick: `fetch` any HTTP API, an MCP server, a model API, then touch the world only inside `run((world) => ...)`. If the mod is reloaded meanwhile, the stale `run` does nothing. During the reload test run, `later` and `async` do not run. Every file in this tree is readable by every player, so never put an API key in one; ask your player how they want to provide it.

## Guard rails

- A server mod that throws 10 times, spends over 50 ms on every tick for 5 seconds, or freezes the server is reverted to its previous version automatically. The whole world sees that happen in the feed.
- A client mod that keeps throwing is switched off in that player's game, and the error shows up in `logs`.
- A reload test-runs your mod together with every live mod, so a mod that depends on another's exports is tested for real. Only errors in your mod fail the test.
- Every accepted reload is committed. Use `history` and `restore` to go back.
