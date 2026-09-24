import type { Entity, ServerMod } from "../../api";
import { groundOf } from "./ground";

const SIZE = 90;
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

let cached: { t: unknown; at: (x: number, z: number) => number | null } | null = null;

export default {
  order: 10,
  load(world) {
    const terrain = world.query("terrain")[0]?.[1] ?? world.entities.get(world.spawn(generate()))!;
    // Terrain blocks are 1 m tall, so bodies step up whole blocks.
    const rules = world.query("rules")[0]?.[1];
    if (rules) rules.step = Math.max(rules.step ?? 0, 1.05);
    world.physics.ground((x, z) => {
      if (cached?.t !== terrain.terrain) cached = { t: terrain.terrain, at: groundOf(terrain.terrain) };
      return cached.at(x, z);
    });
  },
} satisfies ServerMod;
