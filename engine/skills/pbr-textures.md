# PBR textures

When to use: before giving surfaces a real material (brick, wood, stone, metal, ground) so the textures load with the right colour spaces, tiling and scale.

PBR texture sets are several images of one surface: colour (also called diffuse or albedo), normal (bumps), roughness, metalness and ambient occlusion. Poly Haven and ambientCG give them away under CC0. Pick one by its preview first (finding-assets.md), then download only the maps you use, at 1k unless the surface fills the screen.

## Poly Haven

The API lists every set and its files, and the files are direct links `add_asset` can fetch:

```sh
curl -s "https://api.polyhaven.com/assets?t=textures&c=brick" | jq -r 'to_entries[] | "\(.key)  \(.value.thumbnail_url)"'   # names and previews
curl -s "https://api.polyhaven.com/files/brick_wall_001" | jq -r '.Diffuse["1k"].jpg.url, .nor_gl["1k"].jpg.url, .arm["1k"].jpg.url'
./world add_asset mod=walls name=brick_diffuse.jpg url=<Diffuse url>
```

Take `nor_gl` (OpenGL normals, which three expects), not `nor_dx`. The `arm` map packs AO, roughness and metalness into its red, green and blue channels, the same order three reads them, so one file fills all three slots. HDRI skies come from the same API (`t=hdris`, `.hdri["1k"].hdr.url`).

## ambientCG

Search with `https://ambientcg.com/api/v2/full_json?type=Material&q=brick&include=downloadData,imageData`: each result has `previewImage["256-PNG"]` and zip downloads (`..._1K-JPG.zip`). `add_asset` can't open zips, so download and unzip on your machine and upload each map with `./world add_asset mod=<mod> name=<file> base64=@<file>`. Its normal maps ending in `_NormalGL` are the OpenGL ones.

## Loading a set

Only the colour map is sRGB. Normal, roughness, metalness and AO are data and stay linear (`NoColorSpace`); getting this wrong makes surfaces look washed out or wrongly shiny.

```ts
import * as THREE from "three";
import type { ClientMod } from "../../api";

let wall: THREE.Mesh;
export default {
  init(ctx) {
    const load = (name: string, color = false) => {
      const t = new THREE.TextureLoader().load(ctx.asset(name));
      t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(3, 1.5); // tiles per face: scale so bricks look real-sized next to a player
      t.anisotropy = ctx.renderer.capabilities.getMaxAnisotropy(); // sharp at grazing angles
      return t;
    };
    const arm = load("brick_arm.jpg");
    wall = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 0.4), new THREE.MeshStandardMaterial({
      map: load("brick_diffuse.jpg", true), normalMap: load("brick_nor_gl.jpg"),
      aoMap: arm, roughnessMap: arm, metalnessMap: arm,
    }));
    wall.position.set(0, 1.5, -4);
    wall.castShadow = wall.receiveShadow = true;
    ctx.scene.add(wall);
  },
  dispose(ctx) { ctx.scene.remove(wall); },
} satisfies ClientMod;
```

Entities drawn by the engine (`mesh` component) share materials. Give one entity its own textured material from the client `object` hook, or set `ctx.objects.get(id).material` to a new material.

## Check it

Take a screenshot close up and from a distance, and look at both:
- Stretched or giant bricks mean `repeat` doesn't match the surface size. Set repeat to the size in metres divided by the size one tile covers.
- A pale, flat look means the colour map isn't sRGB, or a data map is.
- Bumps lit from the wrong side mean you loaded the DirectX normal map.
- A surface that is too shiny or mirror-like: a roughness or metalness map is in the wrong slot, or `metalness` is set without a metalness map.
- A seam on every tile means the texture isn't seamless. Poly Haven and ambientCG sets are.

Put the source, author and licence in the mod's `CREDITS.md` (Poly Haven and ambientCG: CC0, credit appreciated).
