# Lighting

When to use: before changing how the world is lit (sun, shadows, lamps, torches, night, fog, glow, god rays, colour grading, 2D lights) so you pick a technique that fits the look and the frame budget.

The basics mod owns the default lights: a hemisphere light plus a sun (a `DirectionalLight` with shadows), the sky colour and `Fog(60, 220)`. Changing the world's lighting usually means editing or removing those first, so two mods don't each add a sun. Take a screenshot after every lighting change and look at it.

Costs were measured in software rendering at 1280x720, where a plain daylight frame takes 76 ms (40 ms with no lights). Read them as relative weights and check `perf` on a real player.

| Technique | Look | Use for | Cost |
|---|---|---|---|
| Sun and cascaded shadows | crisp shadows near you, soft far away | big outdoor worlds | about 1.8x the basic sun |
| Spot cone and fake beam | stage light, flashlight, lighthouse | night scenes, focus | about the same as no lights |
| Point lights | torches, lamps, glowing pickups | small local light | cheap without shadows; each shadowed one draws the scene 6 more times |
| Environment map (HDRI) | realistic reflections and ambient light; a photo sky | anything PBR or metallic | about 1.5x |
| God rays | light shafts streaming past objects | sunsets, temples, forests | about 3x (post-processing) |
| Fog and height fog | depth, mood, mist lying in valleys | every outdoor scene | free |
| Bloom, AO and grading | glow, contact shadows, a film look | the final polish | heavy (AO most) |
| 2D lights with shadows | top-down light and darkness | 2D games in `ctx.layer()` | under 1 ms per frame |
| Light probes and lightmaps | soft bounced light without real-time cost | static rooms, levels | free per frame |
| Day-night cycle | sun moves, sky and light change colour | survival, farming, any long session | free |
| Radiance cascades | true 2D global illumination | experiments | untested |

## Sun and cascaded shadows

One shadow map stretched over a large world goes blurry. Cascaded shadow maps (CSM) give the player several, sharp near and coarse far. Use three's addon (no package). Remove basics' sun first, because CSM adds its own lights.

```ts
import { CSM } from "three/addons/csm/CSM.js";
import * as THREE from "three";
import type { ClientMod } from "../../api";

let csm: CSM, fill: THREE.HemisphereLight;
const ready = new WeakSet<THREE.Material>();
export default {
  init(ctx) {
    csm = new CSM({ camera: ctx.camera, parent: ctx.scene, cascades: 3, maxFar: 150, shadowMapSize: 2048, lightDirection: new THREE.Vector3(-1, -1.5, -0.6).normalize(), lightIntensity: 2.5 });
    fill = new THREE.HemisphereLight("#cfe3ff", "#4a5a3a", 1);
    ctx.scene.add(fill);
  },
  frame(ctx) {
    ctx.scene.traverse((o) => { // every lit material needs setupMaterial once, including ones made later
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && !Array.isArray(m) && "isMeshStandardMaterial" in m && !ready.has(m)) (ready.add(m), csm.setupMaterial(m));
    });
    csm.update();
  },
  dispose(ctx) { csm.remove(); csm.dispose(); ctx.scene.remove(fill); },
} satisfies ClientMod;
```

For a small world, keep one `DirectionalLight` and fit its shadow box tightly (`sun.shadow.camera.left/right/top/bottom`) around the player instead.

## Spot cone and fake volumetric beam

A `SpotLight` lights a cone and can cast shadows. Real volumetric light is expensive, so fake the visible beam: an open cone mesh, bright at the lamp and fading out, drawn additively.

```ts
const spot = new THREE.SpotLight("#ffe7b0", 120, 20, 0.45, 0.4, 2); // colour, intensity, range, cone angle, soft edge, decay
spot.position.set(0, 7, -6); spot.target.position.set(0, 0, -6);
spot.castShadow = true; spot.shadow.mapSize.set(1024, 1024); spot.shadow.bias = -0.0005;
const h = 7, geo = new THREE.ConeGeometry(Math.tan(0.45) * h, h, 32, 1, true).translate(0, -h / 2, 0);
const beam = new THREE.Mesh(geo, new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  uniforms: { color: { value: new THREE.Color("#ffe7b0") } },
  vertexShader: "varying float vY; void main() { vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: "uniform vec3 color; varying float vY; void main() { gl_FragColor = vec4(color * 0.25 * vY * vY, 1.0); }",
}));
beam.position.copy(spot.position);
ctx.scene.add(spot, spot.target, beam); // remove all three in dispose
```

Aim the beam with the light: `beam.lookAt(target)` then `beam.rotateX(-Math.PI / 2)`. The same additive trick on a camera-facing sprite makes window shafts and lamp halos.

## Point lights and the shadow budget

```ts
const lamp = new THREE.PointLight("#ff8a3d", 25, 10, 2); // colour, intensity, range in metres, decay
lamp.castShadow = true; // each shadowed point light renders the scene 6 more times: one or two per world
lamp.shadow.mapSize.set(512, 512);
lamp.add(new THREE.Mesh(new THREE.SphereGeometry(0.08), new THREE.MeshBasicMaterial({ color: "#ff8a3d" }))); // the visible bulb
ctx.scene.add(lamp);
```

Many torches: give most of them no shadow and a short range, flicker their `intensity` in `frame`, and add bloom so the bulbs glow. Every light added or removed makes three recompile every lit material (a hitch). Keep the number of lights fixed and switch them by `intensity` rather than adding and removing them.

## Environment map (HDRI)

An HDR photo of a sky or room lights every `MeshStandardMaterial` from all directions and gives metals something to reflect. Poly Haven has free CC0 HDRIs (see pbr-textures.md for the API). `add_asset` the 1k `.hdr` (1.4 MB) and prefilter it once:

```ts
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";

const sky = await new HDRLoader().loadAsync(ctx.asset("sky.hdr"));
sky.mapping = THREE.EquirectangularReflectionMapping;
const pmrem = new THREE.PMREMGenerator(ctx.renderer);
const env = pmrem.fromEquirectangular(sky).texture; pmrem.dispose();
ctx.scene.environment = env; // light and reflections
ctx.scene.background = sky; // optional: the photo as the sky
ctx.scene.fog = null; // a flat fog colour would cut a band across a photo sky
```

The environment gives no shadows: keep a sun for those, at a lower intensity. Without an HDRI, `new RoomEnvironment()` from `three/addons/environments/RoomEnvironment.js` through `pmrem.fromScene(...)` gives neutral studio reflections.

## God rays

Light shafts from a bright source behind objects, as a post-processing pass from the `postprocessing` package (libraries.md has the composer basics). The rays come from an unlit mesh: anything in front of it casts a shaft.

```ts
import { EffectComposer, EffectPass, GodRaysEffect, RenderPass } from "postprocessing";

const sun = new THREE.Mesh(new THREE.SphereGeometry(3, 24, 12), new THREE.MeshBasicMaterial({ color: "#ffd9a0", fog: false }));
sun.position.set(0, 6, -40); ctx.scene.add(sun);
composer = new EffectComposer(ctx.renderer, { frameBufferType: THREE.HalfFloatType });
composer.addPass(new RenderPass(ctx.scene, ctx.camera));
composer.addPass(new EffectPass(ctx.camera, new GodRaysEffect(ctx.camera, sun, { density: 0.96, decay: 0.93, weight: 0.4, exposure: 0.6, samples: 60, blur: true })));
// render(ctx, draw, dt) { composer.render(dt); } as in libraries.md
```

Keep the sun mesh's position following the real light's direction (camera position plus direction times distance) so the rays match the shadows.

## Fog and height fog

Distance fog is one line: `scene.fog = new THREE.Fog(color, near, far)` or `new THREE.FogExp2(color, density)`. Set `scene.background` to the same colour so the horizon disappears. Height fog lies in low ground and thins with height. Patch each lit material once:

```ts
const FLOOR = 0, FALLOFF = 0.6; // densest at y = FLOOR, thinning by e every 1/FALLOFF metres up
const patched = new Set<THREE.Material>();
function heightFog(m: THREE.Material) {
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace("#include <fog_pars_vertex>", "#include <fog_pars_vertex>\nvarying vec3 vFogWorld;")
      .replace("#include <fog_vertex>", "#include <fog_vertex>\nvFogWorld = (inverse(viewMatrix) * mvPosition).xyz;");
    s.fragmentShader = s.fragmentShader.replace("#include <fog_pars_fragment>", "#include <fog_pars_fragment>\nvarying vec3 vFogWorld;")
      .replace("#include <fog_fragment>", `#ifdef USE_FOG
        #ifdef FOG_EXP2
          float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
        #else
          float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
        #endif
        fogFactor *= exp(-max(vFogWorld.y - ${FLOOR.toFixed(1)}, 0.0) * ${FALLOFF.toFixed(2)});
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
      #endif`);
  };
  m.customProgramCacheKey = () => "height-fog"; // without it three reuses the unpatched shader
  m.needsUpdate = true;
}
// init: ctx.scene.fog = new THREE.FogExp2("#c9d3dc", 0.06); ctx.scene.background = new THREE.Color("#c9d3dc");
// frame: traverse the scene and heightFog() each MeshStandardMaterial not yet in `patched` (other mods add materials later)
// dispose: put the old fog back; for each patched material set onBeforeCompile = () => {}, customProgramCacheKey = () => "", needsUpdate = true
```

The shader handles both fog types. If it read `fogDensity` alone, it would fail to compile once another mod switched to linear `Fog`, and every patched object would vanish.

## Bloom, ambient occlusion and colour grading

One composer for the whole look: AO first (from `n8ao`), then bloom, tone mapping and grading merged into one `EffectPass`. Installs and the composer's `render` hook are in libraries.md.

```ts
const ao: any = new N8AOPostPass(ctx.scene, ctx.camera, size.x, size.y);
ao.configuration.aoRadius = 2; ao.configuration.intensity = 2;
composer.addPass(ao);
composer.addPass(new EffectPass(ctx.camera,
  new BloomEffect({ intensity: 1.2, luminanceThreshold: 0.7, mipmapBlur: true }),
  new ToneMappingEffect({ mode: ToneMappingMode.AGX }),
  new HueSaturationEffect({ hue: -0.05, saturation: 0.25 }), // warmer, richer
  new BrightnessContrastEffect({ contrast: 0.15 }),
  new VignetteEffect({ darkness: 0.45 })));
```

AO costs the most. Offer a setting to turn it off. For a named film look, `LUT3DEffect` takes a `.cube` colour table loaded with `LUTCubeLoader` from `three/addons/loaders/LUTCubeLoader.js` (untested here).

## 2D lights with shadows and glow

For top-down or side-on games drawn on a canvas in `ctx.layer()`, fill the screen dark, then for each light fill its visibility polygon (rays cast to every wall corner) with a radial gradient using `"lighter"` blending so lights add up. A blurred bright dot (`shadowBlur`) gives the glow.

```ts
type Box = [number, number, number, number]; // x, y, w, h in canvas pixels
function hit(ox: number, oy: number, dx: number, dy: number, segs: number[][]) { // nearest wall along a ray
  let best = 1e4;
  for (const [x1, y1, x2, y2] of segs) {
    const sx = x2! - x1!, sy = y2! - y1!, den = dx * sy - dy * sx; if (Math.abs(den) < 1e-9) continue;
    const u = ((x1! - ox) * sy - (y1! - oy) * sx) / den, v = ((x1! - ox) * dy - (y1! - oy) * dx) / den;
    if (u > 0 && v >= 0 && v <= 1) best = Math.min(best, u);
  }
  return [ox + dx * best, oy + dy * best];
}
function light(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, walls: Box[]) {
  const all: Box[] = [...walls, [0, 0, g.canvas.width, g.canvas.height]];
  const segs = all.flatMap(([a, b, w, h]) => [[a, b, a + w, b], [a + w, b, a + w, b + h], [a + w, b + h, a, b + h], [a, b + h, a, b]]);
  const angles = all.flatMap(([a, b, w, h]) => [[a, b], [a + w, b], [a + w, b + h], [a, b + h]]).flatMap(([cx, cy]) => { const t = Math.atan2(cy! - y, cx! - x); return [t - 1e-4, t, t + 1e-4]; }).sort((p, q) => p - q);
  g.beginPath();
  angles.forEach((t, i) => { const [px, py] = hit(x, y, Math.cos(t), Math.sin(t), segs); i ? g.lineTo(px!, py!) : g.moveTo(px!, py!); });
  const grad = g.createRadialGradient(x, y, 0, x, y, r); grad.addColorStop(0, color); grad.addColorStop(1, "transparent");
  g.fillStyle = grad; g.fill();
}
// each frame: g.fillStyle = "#0b0d14"; g.fillRect(...); g.globalCompositeOperation = "lighter";
// light(g, x, y, 420, "rgba(255,190,110,0.9)", walls); ...; g.globalCompositeOperation = "source-over";
// draw the walls on top, then a glow: g.shadowColor = "#ffcf8a"; g.shadowBlur = 30; fill a small circle at the light; g.shadowBlur = 0;
```

Fine for a handful of lights and a few dozen walls. Beyond that, draw lights into a lower-resolution offscreen canvas and scale it up.

## Light probes and baked lightmaps

A light probe captures the light around a point once and applies it as soft ambient light to everything: cheap bounce light that matches the sky and ground.

```ts
import { LightProbeGenerator } from "three/addons/lights/LightProbeGenerator.js";

const target = new THREE.WebGLCubeRenderTarget(64), cam = new THREE.CubeCamera(0.1, 500, target);
cam.position.set(0, 2, 0);
cam.update(ctx.renderer, ctx.scene); // again when the surroundings change a lot (day to night), never every frame
const probe = await LightProbeGenerator.fromCubeRenderTarget(ctx.renderer, target); // async in r186
probe.intensity = 1; target.dispose();
ctx.scene.add(probe);
```

A lightmap is a texture of light baked ahead of time (Blender: Bake, into a second UV set). Load it as the material's `lightMap`. It reads the geometry's `uv1` attribute when `channel = 1`:

```ts
lightMap.colorSpace = THREE.SRGBColorSpace; lightMap.channel = 1;
mesh.material = new THREE.MeshStandardMaterial({ map, lightMap, lightMapIntensity: 1 });
```

For baking in the browser, `three/addons/misc/ProgressiveLightMap.js` accumulates soft shadows into lightmaps over a few seconds (untested here).

## Day-night cycle

Own one sun and one hemisphere light, and drive their angle, colour and intensity and the sky colour from a clock. Remove basics' lights and sky colour first.

```ts
const DAY = 240; // seconds per full day
const sun = new THREE.DirectionalLight(), sky = new THREE.HemisphereLight(), moon = new THREE.DirectionalLight("#8fa8ff", 0.25);
const noon = new THREE.Color("#9fc7e8"), dusk = new THREE.Color("#f08a4b"), night = new THREE.Color("#060914"), bg = new THREE.Color();
let t = DAY * 0.3;
// init: sun.castShadow = true; size sun.shadow.camera; ctx.scene.background = bg; ctx.scene.fog = new THREE.Fog(bg, 60, 220);
//       moon.position.set(-30, 60, 20); ctx.scene.add(sun, sun.target, sky, moon);
// frame(ctx, dt):
t += dt;
const a = ((t / DAY) % 1) * Math.PI * 2, h = Math.sin(a); // h: 1 at noon, -1 at midnight
const p = ctx.camera.position; // keep the shadow box around the player
sun.position.set(p.x + Math.cos(a) * 80, p.y + h * 80, p.z + 30); sun.target.position.copy(p);
const day = THREE.MathUtils.smoothstep(h, -0.1, 0.3), low = 1 - Math.abs(h);
sun.intensity = 2.5 * day; sun.color.set("#fff4e0").lerp(dusk, low * low * day);
sky.intensity = 0.15 + 1.2 * day; sky.color.copy(night).lerp(noon, day); sky.groundColor.set("#2a2f22");
bg.copy(night).lerp(noon, day).lerp(dusk, low ** 6 * 0.7);
```

For everyone to see the same time of day, keep the clock on the server (an entity with the time) and read it on the client instead of `t += dt`. A physical sky that follows the sun is in libraries.md (`@takram/three-atmosphere`).

## Radiance cascades (untested)

Radiance cascades compute real 2D global illumination: light bouncing, colour bleeding and soft shadows from any glowing pixel. It is several render passes, far beyond a short recipe, and nothing here has tested it in this engine. Start from Jason McGhee's step-by-step three.js/WebGL2 tutorial with full source at https://jason.today/rc, and the original paper and reference code at https://github.com/Raikiri/RadianceCascadesPaper. Run it as a full-screen pass in the `render` hook or on a canvas in `ctx.layer()`, and measure with `perf`.
