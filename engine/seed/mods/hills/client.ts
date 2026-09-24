import type { ClientMod } from "../../api";

import type * as THREE from "three";

let meshes: THREE.InstancedMesh[] = [];
let drawn: unknown = null;

export default {
  frame(ctx) {
    const t = [...ctx.entities.values()].find((e) => e.terrain)?.terrain;
    if (t === drawn) return;
    drawn = t;
    ctx.scene.remove(...meshes);
    meshes.forEach((m) => m.dispose());
    meshes = [];
    if (!t) return;
    const { THREE } = ctx;
    const box = new THREE.BoxGeometry(1, 1, 1);
    const m = new THREE.Matrix4(), c = new THREE.Color();
    const palette = ["#c9a877", "#8fa35c", "#6f8a4a", "#7d7468", "#ece6da"];
    const blocks = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ roughness: 0.95 }), t.heights.length);
    t.heights.forEach((h: number, i: number) => {
      blocks.setMatrixAt(i, m.makeScale(1, h, 1).setPosition(Math.floor(i / t.size) - t.size / 2, h / 2, (i % t.size) - t.size / 2));
      blocks.setColorAt(i, c.set(palette[Math.min(4, Math.floor(h / 2.6))]!));
    });
    const trees = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ roughness: 0.9 }), t.trees.length * 2);
    t.trees.forEach(([x, z, h]: number[], n: number) => {
      const ground = t.heights[(x! + t.size / 2) * t.size + z! + t.size / 2];
      trees.setMatrixAt(2 * n, m.makeScale(0.4, h!, 0.4).setPosition(x!, ground + h! / 2, z!));
      trees.setColorAt(2 * n, c.set("#5a3f2a"));
      trees.setMatrixAt(2 * n + 1, m.makeScale(2, 2, 2).setPosition(x!, ground + h! + 0.6, z!));
      trees.setColorAt(2 * n + 1, c.set((x! + z!) % 2 ? "#3f6b35" : "#547d3a"));
    });
    meshes = [blocks, trees];
    for (const mesh of meshes) mesh.castShadow = mesh.receiveShadow = true;
    ctx.scene.add(...meshes);
  },
  dispose(ctx) {
    ctx.scene.remove(...meshes);
    meshes.forEach((m) => m.dispose());
    meshes = [];
    drawn = null;
  },
} satisfies ClientMod;
