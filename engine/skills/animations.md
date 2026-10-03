# Animations

When to use: before adding animated characters or creatures (idle, walk, run, attack, dance) or playing Mixamo animations, so clips load, blend and follow gameplay state.

A rigged model carries a skeleton. Animation clips move its bones, and three's `AnimationMixer` plays and blends them. Many models ship with clips inside the `.glb`. Mixamo adds clips to any humanoid.

## Where animated characters come from

- Ready-made with clips, directly linkable for `add_asset`: three.js's sample models `Soldier.glb` (Idle, Walk, Run), `Xbot.glb` and `RobotExpressive.glb` (raw links from `github.com/mrdoob/three.js/tree/dev/examples/models/gltf`), and the Khronos glTF samples (`Fox.glb`, `CesiumMan.glb`).
- CC0 packs with dozens of clips: Quaternius (characters, animals, monsters and the Universal Animation Library) and KayKit. They download as zips: unzip on your machine and upload the `.glb` with `./world add_asset mod=<mod> name=<file> base64=@<file>`.
- Mixamo (mixamo.com) rigs a humanoid and gives it any of thousands of motion-captured clips. It needs the player's free Adobe login, which you don't have. Ask your player to download: the character as "FBX Binary, With Skin", and each clip as "FBX Binary, Without Skin" with "In Place" ticked for walks and runs (otherwise the clip moves the model away from its entity). Have them put the files in this folder, then upload them with `add_asset base64=@file`.

Check a model's clip names after loading (`gltf.animations.map((c) => c.name)`) before wiring them to states.

## Play and blend clips

Tested with Soldier.glb, compressed with meshopt (see libraries.md, "Smaller models"):

```ts
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import type { ClientMod } from "../../api";

let mixer: THREE.AnimationMixer | undefined, root: THREE.Object3D | undefined, current = "Idle", t = 0;
const actions: Record<string, THREE.AnimationAction> = {};
function play(name: string) {
  if (name === current || !actions[name]) return;
  actions[name].reset().play().crossFadeFrom(actions[current]!, 0.4, true); // blend over 0.4 s
  current = name;
}
export default {
  async init(ctx) {
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(ctx.asset("soldier.glb"));
    root = gltf.scene;
    root.traverse((o) => (o.castShadow = true));
    mixer = new THREE.AnimationMixer(root);
    for (const clip of gltf.animations) actions[clip.name] = mixer.clipAction(clip);
    actions.Idle!.play();
    ctx.scene.add(root);
  },
  frame(ctx, dt) {
    if (!mixer || !root) return;
    t += dt; // demo: cycle the clips; in a game pick the clip from the entity's speed or state
    play(t % 6 < 2 ? "Idle" : t % 6 < 4 ? "Walk" : "Run");
    mixer.update(dt);
  },
  dispose(ctx) { if (root) ctx.scene.remove(root); mixer?.stopAllAction(); },
} satisfies ClientMod;
```

For a model per entity (every player, every monster), return a clone from the client `object` hook instead of adding one model to the scene. Use `SkeletonUtils.clone(gltf.scene)` from `three/addons/utils/SkeletonUtils.js`, because a plain `clone()` shares one skeleton between copies. Give each clone its own mixer.

## Mixamo FBX clips

Tested with three.js's Mixamo export `examples/models/fbx/Samba Dancing.fbx`, which holds the skin and its clip in one file.

```ts
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";

const loader = new FBXLoader();
const character = await loader.loadAsync(ctx.asset("character.fbx")); // With Skin
character.scale.setScalar(0.01); // Mixamo FBX is in centimetres
mixer = new THREE.AnimationMixer(character);
const [dance] = (await loader.loadAsync(ctx.asset("dance.fbx"))).animations; // Without Skin: only the clip
mixer.clipAction(dance!).play();
```

Clips bind to bones by name, so a Mixamo clip plays on any Mixamo-rigged model, FBX or glTF. If a clip loads but nothing moves, compare `clip.tracks[0].name` with the model's bone names and rename the tracks to match. FBX files are large: import them into Blender and export `.glb` before upload when they near the 20 MB `add_asset` limit.

## Check it

Take a screenshot of the model standing, and another while it moves, and look at both:
- A model lying down or facing backwards needs a rotation on its root (`root.rotation.y = Math.PI`).
- A giant or tiny model needs `scale` (Mixamo FBX: 0.01).
- Feet sliding or sinking means the walk speed doesn't match the clip. Set `action.timeScale = speed / clipSpeed`.
- A model that snaps back to the start every few steps is playing a clip with root motion. Download it "In Place".
- A T-pose means no clip is playing, or the tracks don't match the bone names.
