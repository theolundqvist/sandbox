# Finding assets

When to use: before adding any model, texture, HDRI sky, sound or shader from the web, so you search the right free libraries, choose by looking at previews, and check the result in the world.

## Where to search

| Source | What | Licence | How to search | How to download |
|---|---|---|---|---|
| Poly Haven | PBR textures, HDRI skies, models | CC0 | API: `https://api.polyhaven.com/assets?t=textures` (or `hdris`, `models`), `&c=<category>`; each result has `thumbnail_url` | `https://api.polyhaven.com/files/<id>` lists direct `dl.polyhaven.org` links `add_asset` can fetch |
| ambientCG | PBR textures | CC0 | API: `https://ambientcg.com/api/v2/full_json?type=Material&q=<words>&include=downloadData,imageData`; previews in `previewImage["256-PNG"]` | zips only: download, unzip and upload on your machine |
| Sketchfab | models of everything | per model (check `license.label`; CC BY needs credit) | API: `https://api.sketchfab.com/v3/search?type=models&downloadable=true&q=<words>`; previews in `thumbnails.images[].url` | needs the player's Sketchfab login: ask them to download the glTF into this folder |
| Kenney | low-poly kits, sprites, UI, sounds | CC0 | kenney.nl/assets; each asset page shows previews | the asset page links a zip (`kenney.nl/media/pages/assets/.../kenney_<name>.zip`) |
| Quaternius | low-poly characters, animals, nature, with animations | CC0 | quaternius.com | zips from the pack page |
| OpenGameArt | models, sprites, music, sound effects | per file (CC0, CC BY, GPL...) | `https://opengameart.org/art-search-advanced?keys=<words>` (3D: `&field_art_type_tid[]=10`); previews under `sites/default/files/styles/thumbnail/` | direct file links on each page |
| Shadertoy | shaders | CC BY-NC-SA unless stated | blocks scripted access (403) | ask the player to paste the code; see shaders.md |

Also direct: the three.js and Khronos sample models (raw GitHub links), freesound previews (`cdn.freesound.org/previews/...mp3`). Poly Pizza and Sketchfab block direct downloads.

## Choose by looking, not by downloading

Never download candidates just to browse: models and texture sets are megabytes each, while previews are a few kilobytes. Collect 8 to 16 preview URLs from a search, tile them into one numbered grid image, look at it, and pick by number. Save this as `grid.ts` in this folder:

```ts
// bun grid.ts out.png <image-url>...  Tiles previews into one numbered grid (1, 2, 3... in argument order).
import sharp from "sharp";
const [out, ...urls] = Bun.argv.slice(2);
// Numbers are drawn as seven-segment rectangles, so the label needs no installed fonts.
const SEG = ["1110111", "0010010", "1011101", "1011011", "0111010", "1101011", "1101111", "1010010", "1111111", "1111011"];
const BARS = [[2, 0, 12, 3], [0, 2, 3, 12], [13, 2, 3, 12], [2, 13, 12, 3], [0, 15, 3, 12], [13, 15, 3, 12], [2, 26, 12, 3]];
const digits = (n: number) => [...String(n)].map((d, k) => BARS.filter((_, j) => SEG[+d]![j] === "1").map(([x, y, w, h]) => `<rect x="${8 + k * 20 + x!}" y="${6 + y!}" width="${w}" height="${h}" fill="#fff"/>`).join("")).join("");
const S = 256, cols = Math.min(4, urls.length), rows = Math.ceil(urls.length / cols);
const tiles = await Promise.allSettled(urls.map(async (url, i) => {
  const res = await fetch(url!, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const img = await sharp(Buffer.from(await res.arrayBuffer())).resize(S, S, { fit: "contain", background: "#222" }).png().toBuffer();
  const label = Buffer.from(`<svg width="${S}" height="${S}"><rect width="${12 + 20 * String(i + 1).length}" height="42" fill="#000" opacity="0.8"/>${digits(i + 1)}</svg>`);
  return [{ input: img, left: (i % cols) * S, top: Math.floor(i / cols) * S }, { input: label, left: (i % cols) * S, top: Math.floor(i / cols) * S }];
}));
tiles.forEach((t, i) => t.status === "rejected" && console.error(`${i + 1}: ${t.reason}`));
await sharp({ create: { width: cols * S, height: rows * S, channels: 3, background: "#111" } })
  .composite(tiles.flatMap((t) => (t.status === "fulfilled" ? t.value : []))).png().toFile(out!);
console.log(`${out}: ${urls.length} tiles, ${cols}x${rows}`);
```

```sh
curl -s "https://api.polyhaven.com/assets?t=textures&c=brick" | jq -r 'to_entries[:12][] | .value.thumbnail_url' | xargs bun grid.ts grid.png
```

Then open `grid.png` and look at it. Bun installs `sharp` on first run when no `node_modules` folder is above this one; otherwise run `bun add sharp` in an empty folder first. Keep the list of URLs in the same order, so number 5 in the grid is the fifth URL.

## After downloading

1. Upload: `./world add_asset mod=<mod> name=<file> url=<direct link>`, or for files on your machine `base64=@<file>`. `add_asset` takes one `.glb`, `.gltf`, `.bin`, `.vrm`, `.fbx`, `.png`, `.jpg`, `.webp`, `.ktx2`, `.hdr`, `.ogg`, `.mp3`, `.wav`, `.ttf`, `.otf`, `.woff`, `.woff2` or `.json` file of at most 50 MiB, and the game loads files only from the world, never from another site. Pack a `.gltf` with separate files into one `.glb`, and shrink big models, with glTF-Transform (libraries.md, "Smaller models").
2. Place it where the player will see it, take a screenshot, and look at it.
3. Fix what's wrong, then screenshot again:
   - Scale: compare it with the player (about 1.8 m tall). Measure with `new THREE.Box3().setFromObject(model).getSize(v)` and scale to the size you want.
   - Orientation: models often face +z or lie on their side. Rotate the root so it stands up and faces the way it moves.
   - Ground: lift it so its lowest point (`box.min.y`) sits on the floor.
   - Materials: black or untextured surfaces mean missing textures (pack into `.glb`). Overly shiny ones mean a wrong metalness or roughness. Pale colours mean the colour map isn't sRGB (pbr-textures.md). Invisible faces mean one-sided materials seen from behind (`material.side = THREE.DoubleSide`).
   - Shadows: `model.traverse((o) => (o.castShadow = o.receiveShadow = true))`.
4. Put the source link, author and licence in the mod's `CREDITS.md`.
