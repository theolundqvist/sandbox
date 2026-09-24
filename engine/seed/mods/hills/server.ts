import type { Entity, ServerMod, World } from "../../api";

const SIZE = 90;
const HEIGHT = 1.6;
const hash = (x: number, z: number) => (((Math.sin(x * 127.1 + z * 311.7) * 43758.5) % 1) + 1) % 1;

function generate(): Entity {
  const heights: number[] = [];
  const trees: [number, number, number][] = [];
  for (let x = 0; x < SIZE; x++)
    for (let z = 0; z < SIZE; z++) {
      const px = x - SIZE / 2, pz = z - SIZE / 2;
      const peak = Math.hypot(px - 12, pz + 6);
      const h = Math.max(1, Math.round(3 + 3 * Math.sin(px * 0.13) * Math.cos(pz * 0.11) + 2.5 * Math.sin((px + pz) * 0.07) + (peak < 5 ? 9 - peak : 0)));
      heights.push(h);
      if (h >= 3 && h <= 7 && hash(px, pz) < 0.06 && Math.hypot(px, pz) > 6) trees.push([px, pz, 2 + Math.floor(hash(pz, px) * 3)]);
    }
  return { terrain: { size: SIZE, heights, trees } };
}

/** Top of the solid ground (blocks and tree trunks) under x, z. */
function floor(t: Entity["terrain"], blocked: Map<number, number>, x: number, z: number) {
  const i = Math.round(x) + t.size / 2, k = Math.round(z) + t.size / 2;
  if (i < 0 || k < 0 || i >= t.size || k >= t.size) return 0;
  return blocked.get(i * t.size + k) ?? t.heights[i * t.size + k];
}

function terrain(world: World) {
  const t = world.query("terrain")[0]?.[1].terrain;
  if (!t) return null;
  const blocked = new Map<number, number>();
  for (const [x, z, h] of t.trees) {
    const i = (x + t.size / 2) * t.size + z + t.size / 2;
    blocked.set(i, t.heights[i] + h);
  }
  return (x: number, z: number) => floor(t, blocked, x, z);
}

export default {
  order: 10,
  load(world) {
    if (!world.query("terrain").length) world.spawn(generate());
  },
  wrap: {
    basics: {
      // basics walks on y = 0, so it runs in height-above-ground and hills lifts the result back up.
      tick(next, world, dt) {
        const ground = terrain(world);
        if (!ground) return next(dt);
        const before = new Map<number, [number, number, number]>();
        for (const [id, e] of world.query("player", "pos")) {
          const f = ground(e.pos[0], e.pos[2]);
          before.set(id, [e.pos[0], e.pos[2], f]);
          e.pos[1] -= f;
        }
        next(dt);
        for (const [id, e] of world.query("player", "pos")) {
          const [x, z, f] = before.get(id) ?? [e.pos[0], e.pos[2], 0];
          e.pos[1] += f;
          if (ground(e.pos[0], e.pos[2]) > e.pos[1] - HEIGHT / 2 + 1.01) [e.pos[0], e.pos[2]] = [x, z];
        }
      },
    },
  },
} satisfies ServerMod;
