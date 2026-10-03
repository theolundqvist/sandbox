# Shaders

When to use: before writing a custom shader effect (water, lava, force fields, holograms, screens, procedural skies, full-screen effects), or porting a Shadertoy shader into the world.

Shadertoy shaders are one function, `mainImage(out vec4 fragColor, in vec2 fragCoord)`, that reads uniforms Shadertoy provides (`iTime`, `iResolution`, `iMouse`, `iChannel0..3`). In three.js a `ShaderMaterial` supplies those uniforms and calls `mainImage` from its own `main`. The shader then paints any mesh: a screen, a portal, a whole sky dome.

Shadertoy blocks scripted downloads (its pages, API and thumbnails answer 403 to tools), so you can't fetch shaders from it. Ask your player to paste the code from the "Image" tab, or write your own. Shaders on Shadertoy are licensed CC BY-NC-SA 3.0 unless the author says otherwise. Credit the author and link in `CREDITS.md`, and don't use NC shaders in anything sold.

## Shadertoy shader on a mesh

```ts
import * as THREE from "three";
import type { ClientMod } from "../../api";

// Paste the Shadertoy "Image" tab here unchanged.
const shadertoy = /* glsl */ `
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
  float v = sin(uv.x * 10.0 + iTime) + sin(uv.y * 10.0 + iTime * 1.3) + sin(length(uv) * 14.0 - iTime * 2.0);
  fragColor = vec4(0.5 + 0.5 * cos(v + vec3(0.0, 2.0, 4.0)), 1.0);
}`;

let screen: THREE.Mesh, mat: THREE.ShaderMaterial;
export default {
  init(ctx) {
    mat = new THREE.ShaderMaterial({
      uniforms: { iTime: { value: 0 }, iResolution: { value: new THREE.Vector3(1024, 512, 1) } }, // the surface's virtual pixel size
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: `uniform float iTime; uniform vec3 iResolution; varying vec2 vUv;\n${shadertoy}\nvoid main() { mainImage(gl_FragColor, vUv * iResolution.xy); }`,
    });
    screen = new THREE.Mesh(new THREE.PlaneGeometry(4, 2), mat);
    screen.position.set(0, 2.5, -6);
    ctx.scene.add(screen);
  },
  frame(_ctx, dt) { mat.uniforms.iTime!.value += dt; },
  dispose(ctx) { ctx.scene.remove(screen); mat.dispose(); },
} satisfies ClientMod;
```

Porting notes:
- Keep `iResolution` in the same aspect ratio as the mesh (here 2:1), or the image stretches.
- `iChannel0..3` are textures: add `uniform sampler2D iChannel0;` and pass a texture loaded from `ctx.asset(...)`. Tick "repeat" in Shadertoy means `RepeatWrapping`. A channel that is another buffer (Buffer A) needs a `WebGLRenderTarget` pass of its own; most single-pass shaders don't.
- `iMouse` can be fed from the pointer, or set to zero.
- `texture()` works as written, since three compiles WebGL2 GLSL 3.0 and converts `gl_FragColor` for you.
- For a full-screen effect over the finished frame, run the same fragment code as a pass in the `render` hook (the `postprocessing` package's `Effect` class takes a `mainImage(inputColor, uv, outputColor)` shader; see libraries.md).

## Lit, shadowed custom materials

A `ShaderMaterial` ignores scene lights and fog. To keep lighting and only change part of the look (wind on grass, a dissolve, a pulse), patch a `MeshStandardMaterial` with `onBeforeCompile`, as the height fog recipe in lighting.md does. Give it a `customProgramCacheKey`, or three reuses the unpatched shader.

## Check it

A blank or magenta mesh means the shader failed to compile. Read your player's `logs`, which carry three's error with a line number. Take a screenshot, look at it, and check `perf`: a heavy raymarching shader across the whole screen can cost more than the rest of the frame. Draw it on a smaller mesh or at lower resolution (render into a `WebGLRenderTarget` half the size).
