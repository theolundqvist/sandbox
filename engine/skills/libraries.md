# Libraries

When to use: before adding physics, pathfinding, crowd or animal AI, particles, post-processing, shadows, a sky, fast raycasts, 3D text, VRM avatars or compressed models, so you start from a library recipe known to work in this engine.

Each entry below was installed with `add_package` and run in a world. Use anything else on npm too: these are the ones with a tested recipe.

## Install rules

- `./world add_package name=<npm name>` installs for every mod, server and client. Import it like any module.
- Client mods share the engine's three.js (r186). Packages that import `three` or `three/examples/jsm/...` get the engine's copy, so never bundle a second three.
- No types? The reload fails with `TS7016`. Add the `@types/<name>` package if one exists (yuka has one), or add a `types.d.ts` in your mod with `declare module "<name>";` and type the objects as `any`.
- A mod's module state starts fresh on every reload. Libraries that hold state (a physics world, a steering manager) rebuild it from your entities in `load`, and you write results back to entities in `tick`.
- Libraries that ship WebAssembly need `await init()` at the top of the file (Rapier, recast). The top-level await works in server and client mods.
- `load` and `tick` that block for more than 2 seconds get the mod reverted. Keep generation steps (navmesh building) small.

## Catalog

| Need | Package | Where it runs | Cost measured here |
|---|---|---|---|
| Physics: stacks, ragdoll-free rigid bodies, joints | `@dimforge/rapier3d-compat` | server (shared by all players) | 0.14 ms per tick for 10 crates |
| Navmesh pathfinding | `recast-navigation` | server | 0.01 ms per tick; building a 50 m mesh 0.05 s |
| Steering AI: flocks, flee, seek, wander | `yuka` + `@types/yuka` | server | 0.07 ms per tick for 12 animals |
| Post-processing: bloom, tone mapping, vignette, grading, god rays | `postprocessing` | client | heavy: about 2x the frame in software rendering |
| Ambient occlusion | `n8ao` (with `postprocessing`) | client | the heaviest effect here; offer a setting to turn it off |
| Cascaded sun shadows over large worlds | none: `three/addons/csm/CSM.js` | client | about 1.8x a frame with the basic sun |
| Physical sky, sun and aerial haze | `@takram/three-atmosphere` + `@takram/three-geospatial` | client | about 3x the frame in software rendering |
| Particles: fire, smoke, sparks, magic | `three.quarks` | client | under 0.1 ms per frame for 80 particles a second |
| Fast raycasts against big meshes | `three-mesh-bvh` | client or server | 500 rays on 32k triangles: 1.6 ms (1,060 ms without) |
| Crisp 3D text in any language | `troika-three-text` | client | no measurable cost |
| VRM anime-style avatars with spring hair and faces | `@pixiv/three-vrm` | client | 0.6 ms per frame; the model's triangles dominate |
| Smaller models (meshopt + WebP) | `@gltf-transform/cli` on your machine, no package | your machine | Soldier.glb 2.2 MB to 555 KB |

Dropped: `realism-effects` (imports `WebGLMultipleRenderTargets`, which three removed; unmaintained since 2023), `three-csm` (the same code ships as three's CSM addon), `@takram/three-clouds` (needs five hand-wired texture assets, drew no clouds in testing and costs more than the whole frame; use a Poly Haven HDRI sky from pbr-textures.md or lighting.md instead).

Frame costs were measured in software rendering (SwiftShader) at 1280x720, where a plain frame takes 76 ms. They show relative weight, not real GPU times. Check `perf` on your player after adding an effect.

## Physics with Rapier (server)

`./world add_package name=@dimforge/rapier3d-compat`. Run it in `server.ts` so every player sees the same simulation. The server writes each body's position and rotation to its entity; the engine draws it. A kinematic capsule follows each player so they can shove things. Engine solids are not in Rapier's world: add colliders for the ones bodies should hit.

```ts
import RAPIER from "@dimforge/rapier3d-compat";
import type { ServerMod } from "../../api";

await RAPIER.init();
const sim = new RAPIER.World({ x: 0, y: -20, z: 0 });
sim.createCollider(RAPIER.ColliderDesc.cuboid(200, 0.5, 200).setTranslation(0, -0.5, 0)); // ground top at y = 0
const bodies = new Map<number, RAPIER.RigidBody>(), pushers = new Map<number, RAPIER.RigidBody>();
const euler = ({ x, y, z, w }: RAPIER.Rotation) => [Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + y * y)), Math.asin(Math.max(-1, Math.min(1, 2 * (w * y + x * z)))), Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z))];

export default {
  load(world) {
    if (!world.query("crate").length) for (let row = 0; row < 4; row++) for (let i = 0; i < 4 - row; i++)
      world.spawn({ crate: { q: [0, 0, 0, 1] }, pos: [i - (3 - row) / 2, 0.5 + row * 1.01, -6], rot: [0, 0, 0], mesh: { shape: "box", size: 1, color: "#9a6b3c" } });
    for (const [id, e] of world.query("crate")) { // module state is fresh after a reload: rebuild bodies from entities
      const [qx, qy, qz, qw] = e.crate.q, body = sim.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(e.pos[0], e.pos[1], e.pos[2]).setRotation({ x: qx, y: qy, z: qz, w: qw }));
      sim.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setDensity(0.5), body);
      bodies.set(id, body);
    }
  },
  tick(world, dt) {
    for (const [id, e] of world.query("player", "pos")) {
      if (!pushers.has(id)) sim.createCollider(RAPIER.ColliderDesc.capsule(0.5, 0.4), pushers.set(id, sim.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased())).get(id));
      pushers.get(id)!.setNextKinematicTranslation({ x: e.pos[0], y: e.pos[1], z: e.pos[2] });
    }
    sim.timestep = dt; sim.step();
    for (const [id, body] of bodies) {
      const e = world.entities.get(id); if (!e) continue;
      const p = body.translation(), q = body.rotation();
      e.pos = [p.x, p.y, p.z]; e.rot = euler(q); e.crate = { q: [q.x, q.y, q.z, q.w] };
    }
  },
} satisfies ServerMod;
```

For cosmetic debris only one player sees, the same code can run in `client.ts` (untested here).

## Navmesh with recast-navigation (server)

`./world add_package name=recast-navigation`. Build the mesh from the ground and solid boxes, rebuild it when solids change, and walk entities along `computePath`. Leave basics' 400 m ground slab out (use a smaller quad): generating over it takes seconds and trips the freeze guard. An entity outside the mesh gets empty paths; snap it back with `query.findClosestPoint`.

```ts
import { init, NavMeshQuery } from "recast-navigation";
import { generateSoloNavMesh } from "recast-navigation/generators";
import type { ServerMod, World } from "../../api";

await init();
let query: NavMeshQuery;
function navMeshOf(world: World) { // a 50 m ground quad plus every solid box (axis-aligned)
  const positions = [-25, 0, -25, 25, 0, -25, 25, 0, 25, -25, 0, 25], indices = [0, 2, 1, 0, 3, 2];
  for (const [, e] of world.query("solid", "pos")) {
    const s = typeof e.solid === "object" ? e.solid.size : e.mesh.size, [w, h, d] = typeof s === "number" ? [s, s, s] : s, base = positions.length / 3;
    if (w > 50 || d > 50) continue;
    for (const y of [-h / 2, h / 2]) for (const [x, z] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]) positions.push(e.pos[0] + x, e.pos[1] + y, e.pos[2] + z);
    for (const f of [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]) indices.push(base + f);
  }
  const { success, navMesh } = generateSoloNavMesh(positions, indices, { cs: 0.3, ch: 0.2, walkableRadius: 2, walkableHeight: 9, walkableClimb: 2 });
  if (!success) throw new Error("navmesh failed");
  return new NavMeshQuery(navMesh);
}
export default {
  load(world) {
    if (!world.query("walker").length) world.spawn({ walker: { path: [] }, pos: [0, 0.5, -4], mesh: { shape: "sphere", size: 1, color: "#e0533d" } });
    query = navMeshOf(world);
  },
  tick(world, dt) {
    for (const [, e] of world.query("walker")) {
      if (!e.walker.path.length) { e.walker = { path: query.computePath({ x: e.pos[0], y: 0, z: e.pos[2] }, query.findRandomPoint().randomPoint).path.map((p) => [p.x, p.z]) }; continue; }
      const [tx, tz] = e.walker.path[0], dx = tx - e.pos[0], dz = tz - e.pos[2], dist = Math.hypot(dx, dz), step = Math.min(dist, 3 * dt);
      e.pos = [e.pos[0] + (dx / (dist || 1)) * step, 0.5, e.pos[2] + (dz / (dist || 1)) * step];
      if (dist < 0.05) e.walker = { path: e.walker.path.slice(1) };
    }
  },
} satisfies ServerMod;
```

## Steering AI with yuka (server)

`./world add_package name=yuka` and `./world add_package name=@types/yuka`. A flock of sheep that wanders, keeps together and flees the nearest player. Yuka knows nothing about engine solids, so the animals walk through walls: steer them along a navmesh path, or check `world.physics.ray` before moving.

```ts
import { AlignmentBehavior, CohesionBehavior, EntityManager, FleeBehavior, SeparationBehavior, Vector3, Vehicle, WanderBehavior } from "yuka";
import type { ServerMod } from "../../api";

const manager = new EntityManager(), sheep = new Map<number, Vehicle>(), threat = new Vector3(0, 0, 999);
export default {
  load(world) {
    if (!world.query("sheep").length) for (let i = 0; i < 12; i++) world.spawn({ sheep: true, pos: [Math.random() * 8 - 4, 0.4, -10 + Math.random() * 8 - 4], mesh: { shape: "box", size: [0.6, 0.6, 1], color: "#f2efe6" } });
    for (const [id, e] of world.query("sheep")) {
      const v = Object.assign(new Vehicle(), { maxSpeed: 3, updateNeighborhood: true, neighborhoodRadius: 4 });
      v.position.set(e.pos[0], 0, e.pos[2]);
      v.steering.add(Object.assign(new WanderBehavior(), { weight: 0.5 })).add(new SeparationBehavior()).add(new AlignmentBehavior()).add(new CohesionBehavior()).add(Object.assign(new FleeBehavior(threat, 6), { weight: 4 }));
      manager.add(v); sheep.set(id, v);
    }
  },
  tick(world, dt) {
    let near = Infinity;
    for (const [, p] of world.query("player", "pos")) for (const v of sheep.values()) { const d = v.position.squaredDistanceTo(new Vector3(p.pos[0], 0, p.pos[2])); if (d < near) (near = d), threat.set(p.pos[0], 0, p.pos[2]); }
    manager.update(dt);
    for (const [id, v] of sheep) { const e = world.entities.get(id); if (e) (e.pos = [v.position.x, 0.4, v.position.z]), (e.rot = [0, Math.atan2(v.velocity.x, v.velocity.z), 0]); }
  },
} satisfies ServerMod;
```

## Post-processing with postprocessing (client)

`./world add_package name=postprocessing`. One `EffectComposer` replaces the final draw through the `render` hook. Put all effects in one `EffectPass`: it merges them into a single shader. Only one mod should own the composer. Other mods add effects through its `exports` instead of drawing twice. More effects (god rays, AO and grading) are in lighting.md.

```ts
import { BloomEffect, EffectComposer, EffectPass, RenderPass, ToneMappingEffect, ToneMappingMode, VignetteEffect } from "postprocessing";
import * as THREE from "three";
import type { ClientMod } from "../../api";

let composer: EffectComposer;
const size = new THREE.Vector2();
export default {
  init(ctx) {
    composer = new EffectComposer(ctx.renderer, { frameBufferType: THREE.HalfFloatType });
    composer.addPass(new RenderPass(ctx.scene, ctx.camera));
    composer.addPass(new EffectPass(ctx.camera, new BloomEffect({ intensity: 2, luminanceThreshold: 0.6, mipmapBlur: true }), new ToneMappingEffect({ mode: ToneMappingMode.AGX }), new VignetteEffect({ darkness: 0.5 })));
  },
  render(ctx, draw, dt) {
    ctx.renderer.getSize(size);
    if (size.x !== composer.inputBuffer.width / ctx.renderer.getPixelRatio()) composer.setSize(size.x, size.y);
    composer.render(dt); // replaces draw()
  },
  dispose() { composer.dispose(); },
} satisfies ClientMod;
```

Bloom picks up what is brighter than the threshold: emissive materials (`emissive`, `emissiveIntensity` above 1) glow, lit surfaces do not.

## Ambient occlusion with N8AO (client)

`./world add_package name=n8ao` (plus `postprocessing`), and a `types.d.ts` with `declare module "n8ao";`. Darkens corners and contact points. It is the most expensive effect in this list, so measure with `perf` and consider a setting.

```ts
import { N8AOPostPass } from "n8ao";
import { EffectComposer, EffectPass, RenderPass, SMAAEffect } from "postprocessing";
import * as THREE from "three";
import type { ClientMod } from "../../api";

let composer: EffectComposer;
const size = new THREE.Vector2();
export default {
  init(ctx) {
    ctx.renderer.getSize(size);
    composer = new EffectComposer(ctx.renderer, { frameBufferType: THREE.HalfFloatType });
    composer.addPass(new RenderPass(ctx.scene, ctx.camera));
    const ao: any = new N8AOPostPass(ctx.scene, ctx.camera, size.x, size.y);
    ao.configuration.aoRadius = 2; // metres: about the size of the gaps to darken
    ao.configuration.intensity = 3;
    composer.addPass(ao);
    composer.addPass(new EffectPass(ctx.camera, new SMAAEffect()));
  },
  render(ctx, draw, dt) {
    ctx.renderer.getSize(size);
    if (size.x !== composer.inputBuffer.width / ctx.renderer.getPixelRatio()) composer.setSize(size.x, size.y);
    composer.render(dt);
  },
  dispose() { composer.dispose(); },
} satisfies ClientMod;
```

## Cascaded shadows with three's CSM addon (client)

No package. Sharp shadows near the player and soft ones far away, over a whole large world. Take basics' sun out first, because CSM brings its own lights. The recipe is in lighting.md ("Sun and cascaded shadows").

## Physical sky with @takram/three-atmosphere (client)

`./world add_package name=@takram/three-atmosphere` and `./world add_package name=@takram/three-geospatial`. A sky, sun colour and distant haze computed from real atmospheric scattering for any date and place. It downloads its precomputed tables from the library's CDN. Remove basics' background colour and fog, or the fog draws a band across the sky.

```ts
import { AerialPerspectiveEffect, DEFAULT_PRECOMPUTED_TEXTURES_URL, getSunDirectionECEF, PrecomputedTexturesLoader, SkyLightProbe, SkyMaterial, SunDirectionalLight } from "@takram/three-atmosphere";
import { Ellipsoid, Geodetic, radians } from "@takram/three-geospatial";
import { EffectComposer, EffectPass, RenderPass, ToneMappingEffect, ToneMappingMode } from "postprocessing";
import * as THREE from "three";
import type { ClientMod } from "../../api";

const toECEF = Ellipsoid.WGS84.getNorthUpEastFrame(new Geodetic(radians(18), radians(59), 0).toECEF()); // put the world at 59°N 18°E
const sunDir = new THREE.Vector3();
let sky: THREE.Mesh<THREE.PlaneGeometry, SkyMaterial>, sun: SunDirectionalLight, fill: SkyLightProbe, air: AerialPerspectiveEffect, composer: EffectComposer;
export default {
  init(ctx) {
    const t = new PrecomputedTexturesLoader().setType(ctx.renderer).load(DEFAULT_PRECOMPUTED_TEXTURES_URL);
    sky = Object.assign(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new SkyMaterial(t)), { frustumCulled: false });
    sun = Object.assign(new SunDirectionalLight({ distance: 80, transmittanceTexture: t.transmittanceTexture }), { castShadow: true });
    fill = new SkyLightProbe({ irradianceTexture: t.irradianceTexture });
    air = new AerialPerspectiveEffect(ctx.camera, t);
    for (const it of [sky.material, sun, fill, air]) it.worldToECEFMatrix.copy(toECEF);
    ctx.scene.background = null; ctx.renderer.toneMappingExposure = 10; // physical units
    ctx.scene.add(sky, sun, sun.target, fill);
    composer = new EffectComposer(ctx.renderer, { frameBufferType: THREE.HalfFloatType });
    composer.addPass(new RenderPass(ctx.scene, ctx.camera));
    composer.addPass(new EffectPass(ctx.camera, air, new ToneMappingEffect({ mode: ToneMappingMode.AGX })));
  },
  frame() {
    getSunDirectionECEF(new Date("2026-06-21T16:30:00Z"), sunDir); // advance the date for a day cycle
    for (const it of [sky.material, sun, fill, air]) it.sunDirection.copy(sunDir);
    sun.update(); fill.update();
  },
  render(ctx, draw, dt) { composer.render(dt); },
  dispose(ctx) { ctx.scene.remove(sky, sun, sun.target, fill); composer.dispose(); ctx.renderer.toneMappingExposure = 1; },
} satisfies ClientMod;
```

Cheaper skies: three's `Sky` addon (`three/addons/objects/Sky.js`), or an HDRI photo sky (lighting.md, "Environment map").

## Particles with three.quarks (client)

`./world add_package name=three.quarks`. One `BatchedRenderer` draws every particle system in a few draw calls. For effects every player sees at the same moment, trigger them from a server `world.emit` and start or move the system in the `event` hook.

```ts
import * as THREE from "three";
import { BatchedRenderer, Bezier, ColorRange, ConeEmitter, ConstantValue, IntervalValue, ParticleSystem, PiecewiseBezier, RenderMode, SizeOverLife, Vector4 } from "three.quarks";
import type { ClientMod } from "../../api";

let batch: BatchedRenderer, fire: ParticleSystem;
function glow() { // a soft round sprite, no asset needed
  const c = Object.assign(document.createElement("canvas"), { width: 64, height: 64 }), g = c.getContext("2d")!, r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "#fff"); r.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
export default {
  init(ctx) {
    batch = new BatchedRenderer();
    fire = new ParticleSystem({
      looping: true, duration: 1, worldSpace: true, renderMode: RenderMode.BillBoard,
      startLife: new IntervalValue(0.6, 1.2), startSpeed: new IntervalValue(2, 4), startSize: new IntervalValue(0.3, 0.7),
      startColor: new ColorRange(new Vector4(1, 0.8, 0.2, 1), new Vector4(1, 0.25, 0.05, 1)),
      emissionOverTime: new ConstantValue(80), shape: new ConeEmitter({ radius: 0.3, angle: 0.3 }),
      material: new THREE.MeshBasicMaterial({ map: glow(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
      behaviors: [new SizeOverLife(new PiecewiseBezier([[new Bezier(1, 0.8, 0.4, 0), 0]]))],
    });
    fire.emitter.rotation.x = -Math.PI / 2; // the cone points along +z; turn it up
    fire.emitter.position.set(0, 0.2, -6);
    batch.addSystem(fire);
    ctx.scene.add(batch, fire.emitter);
  },
  frame(_ctx, dt) { batch.update(dt); },
  dispose(ctx) { ctx.scene.remove(batch, fire.emitter); fire.dispose(); },
} satisfies ClientMod;
```

## Fast raycasts with three-mesh-bvh (client or server)

`./world add_package name=three-mesh-bvh`. Build the tree once per geometry and give the mesh the accelerated raycast. Set it per mesh: patching `THREE.Mesh.prototype` would change every other mod's meshes.

```ts
import * as THREE from "three";
import { acceleratedRaycast, MeshBVH } from "three-mesh-bvh";

const geo = new THREE.TorusKnotGeometry(1.5, 0.5, 400, 40); // 32k triangles
geo.boundsTree = new MeshBVH(geo);
const knot = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
knot.raycast = acceleratedRaycast;
const ray = new THREE.Raycaster(new THREE.Vector3(0, 2.5, 0), new THREE.Vector3(0, 0, -1));
ray.firstHitOnly = true; // the nearest hit only, much faster
const hits: THREE.Intersection[] = [];
knot.raycast(ray, hits); // or ray.intersectObject(knot)
```

## 3D text with troika-three-text (client)

`./world add_package name=troika-three-text`, a `types.d.ts` with `declare module "troika-three-text";`, and a `.ttf`, `.otf` or `.woff` font added with `add_asset` (troika can't read `.woff2`; open-licence fonts in the google/fonts repository on GitHub work as raw links). Sharp at any distance, with outlines. The game loads fonts only from the world, and troika looks up characters its font lacks on a CDN the game can't reach, so pick a font that has every character you show.

```ts
import { Text } from "troika-three-text";
import type { ClientMod } from "../../api";

let sign: any;
export default {
  init(ctx) {
    sign = new Text();
    sign.font = ctx.asset("sign.ttf"); // the font you added with add_asset
    sign.text = "Welcome to the arena";
    sign.fontSize = 0.6; sign.anchorX = "center"; sign.anchorY = "middle";
    sign.color = "#ffffff"; sign.outlineWidth = 0.03; sign.outlineColor = "#000000";
    sign.position.set(0, 3.5, -6);
    sign.sync(); // builds the glyphs off the main thread; call again after changing text
    ctx.scene.add(sign);
  },
  frame(ctx) { sign.quaternion.copy(ctx.camera.quaternion); }, // face the camera; drop for a fixed sign
  dispose(ctx) { ctx.scene.remove(sign); sign.dispose(); },
} satisfies ClientMod;
```

## VRM avatars with @pixiv/three-vrm (client)

`./world add_package name=@pixiv/three-vrm`. VRM is the format for anime-style avatars (VRoid Studio, VRoid Hub). Add the `.vrm` file with `add_asset` (the three-vrm repository's sample models work as raw GitHub links). `vrm.update(dt)` runs the spring bones (hair, clothes), look-at and facial expressions.

```ts
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { ClientMod } from "../../api";

let vrm: VRM | undefined, t = 0;
export default {
  async init(ctx) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(ctx.asset("avatar.vrm"));
    vrm = gltf.userData.vrm as VRM;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.rotateVRM0(vrm); // VRM 0.x models face the other way; no-op for 1.0
    vrm.scene.position.set(0, 0, -5);
    ctx.scene.add(vrm.scene);
  },
  frame(_ctx, dt) {
    if (!vrm) return;
    t += dt;
    vrm.humanoid.getNormalizedBoneNode("leftUpperArm")!.rotation.z = 1.1 + 0.4 * Math.sin(t * 6); // wave
    vrm.humanoid.getNormalizedBoneNode("rightUpperArm")!.rotation.z = 1.2; // arm down
    vrm.expressionManager?.setValue("happy", 0.5 + 0.5 * Math.sin(t * 2));
    vrm.update(dt);
  },
  dispose(ctx) { if (vrm) { ctx.scene.remove(vrm.scene); VRMUtils.deepDispose(vrm.scene); } },
} satisfies ClientMod;
```

## Smaller models with glTF-Transform and meshopt (your machine)

No package in the world. Shrink a model on your machine before `add_asset` (which takes at most 50 MiB), then load it with three's meshopt decoder:

```sh
bunx @gltf-transform/cli optimize model.glb model.opt.glb --compress meshopt --texture-compress webp
./world add_asset mod=<mod> name=model.glb base64=@model.opt.glb   # @file uploads the file itself
```

```ts
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(ctx.asset("model.glb"));
```

`bunx @gltf-transform/cli copy model.gltf model.glb` packs a `.gltf` with separate `.bin` and texture files into the single file `add_asset` needs. `inspect model.glb` lists its meshes, textures and sizes.
