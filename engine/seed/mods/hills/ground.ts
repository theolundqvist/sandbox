import type { Entity } from "../../api";

/** Top of the solid ground (blocks and tree trunks) at x, z, or null off the map. */
export function groundOf(t: Entity["terrain"]) {
  const blocked = new Map<number, number>();
  for (const [x, z, h] of t.trees) {
    const i = (x + t.size / 2) * t.size + z + t.size / 2;
    blocked.set(i, t.heights[i] + h);
  }
  return (x: number, z: number): number | null => {
    const i = Math.round(x) + t.size / 2, k = Math.round(z) + t.size / 2;
    if (i < 0 || k < 0 || i >= t.size || k >= t.size) return null;
    return blocked.get(i * t.size + k) ?? t.heights[i * t.size + k];
  };
}
