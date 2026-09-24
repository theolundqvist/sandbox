import type { Body, Entity, Physics, RayHit, SolidBox } from "./api";

type Ground = (x: number, z: number, fromY: number) => number | null;
type Box = SolidBox & { cos: number; sin: number; cells: number[]; mark: number };

const CELL = 8;
// Boxes spanning more cells than this are checked on every query instead of being hashed.
const MAX_CELLS = 256;
const EDGE = 0.05;
const cellKey = (cx: number, cz: number) => cx * 1_000_003 + cz;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function sizeOf(e: Entity) {
  const s = typeof e.solid === "number" ? e.solid : (e.solid?.size ?? e.mesh?.size ?? 1);
  const [x = 1, y = x, z = x] = Array.isArray(s) ? s : [s];
  return finite(x) && finite(y) && finite(z) ? [x, y, z] : null;
}

/** The `solid` entities as boxes in a spatial hash, kept current by update() as entities change. */
export class PhysicsIndex implements Omit<Physics, "ground"> {
  grounds: Ground[] = [];
  private byId = new Map<number, Box>();
  private cells = new Map<number, Box[]>();
  private large: Box[] = [];
  private mark = 0;

  update(id: number, e: Entity | undefined) {
    const old = this.byId.get(id);
    const size = e?.solid && Array.isArray(e.pos) ? sizeOf(e) : null;
    const [x, y, z] = size ? e!.pos : [];
    const yaw = e?.rot?.[1] ?? 0;
    if (!size || !finite(x) || !finite(y) || !finite(z) || !finite(yaw)) {
      if (old) this.unlink(old);
      return;
    }
    const [hx, hy, hz] = size.map((s) => Math.abs(s) / 2) as [number, number, number];
    if (old && old.x === x && old.y === y && old.z === z && old.hx === hx && old.hy === hy && old.hz === hz && old.yaw === yaw) return;
    if (old) this.unlink(old);
    const box: Box = { id, x, y, z, hx, hy, hz, yaw, cos: Math.cos(yaw), sin: Math.sin(yaw), cells: [], mark: 0 };
    const ex = Math.abs(box.cos) * hx + Math.abs(box.sin) * hz;
    const ez = Math.abs(box.sin) * hx + Math.abs(box.cos) * hz;
    const [x0, x1, z0, z1] = [Math.floor((x - ex) / CELL), Math.floor((x + ex) / CELL), Math.floor((z - ez) / CELL), Math.floor((z + ez) / CELL)];
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > MAX_CELLS) this.large.push(box);
    else
      for (let cx = x0; cx <= x1; cx++)
        for (let cz = z0; cz <= z1; cz++) {
          const k = cellKey(cx, cz);
          const list = this.cells.get(k);
          if (list) list.push(box);
          else this.cells.set(k, [box]);
          box.cells.push(k);
        }
    this.byId.set(id, box);
  }

  private unlink(box: Box) {
    this.byId.delete(box.id);
    if (!box.cells.length) this.large.splice(this.large.indexOf(box), 1);
    for (const k of box.cells) {
      const list = this.cells.get(k)!;
      list.splice(list.indexOf(box), 1);
      if (!list.length) this.cells.delete(k);
    }
  }

  /** Boxes whose footprint comes within r of (x, z), in id order. */
  private near(x: number, z: number, r: number) {
    const mark = ++this.mark;
    const out: Box[] = [];
    const test = (b: Box) => {
      if (b.mark === mark) return;
      b.mark = mark;
      const dx = x - b.x, dz = z - b.z;
      if (Math.abs(dx * b.cos - dz * b.sin) <= b.hx + r && Math.abs(dx * b.sin + dz * b.cos) <= b.hz + r) out.push(b);
    };
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++)
      for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) this.cells.get(cellKey(cx, cz))?.forEach(test);
    this.large.forEach(test);
    return out.length > 1 ? out.sort((a, b) => a.id - b.id) : out;
  }

  boxes(x: number, z: number, radius: number): SolidBox[] {
    return this.near(x, z, radius);
  }

  /** The highest ground-provider surface at or below limit, and whether any provider rises above it. */
  private provided(x: number, z: number, fromY: number, limit: number) {
    let floor: number | null = null;
    let wall = false;
    for (const g of this.grounds) {
      const h = g(x, z, fromY);
      if (!finite(h)) continue;
      if (h > limit) wall = true;
      else if (floor === null || h > floor) floor = h;
    }
    return { floor, wall };
  }

  groundAt(x: number, z: number, fromY = Infinity) {
    let best = this.grounds.length ? this.provided(x, z, fromY, fromY + EDGE).floor : null;
    for (const b of this.near(x, z, 0)) {
      const top = b.y + b.hy;
      if (top <= fromY + EDGE && (best === null || top > best)) best = top;
    }
    return best;
  }

  move(pos: number[], vel: number[], dt: number, body: Body = {}) {
    const { radius = 0.35, height = 1.8, step = 0.45 } = body;
    const p = [pos[0]! + vel[0]! * dt, pos[1]! + vel[1]! * dt, pos[2]! + vel[2]! * dt] as [number, number, number];
    const v = [vel[0]!, vel[1]!, vel[2]!] as [number, number, number];
    // A body already inside provided ground is lifted out instead of walled in.
    const embedded = this.grounds.length > 0 && this.provided(pos[0]!, pos[2]!, pos[1]!, pos[1]! + step).wall;
    // A fall can drop more than step in one tick: a top it started above is floor, not wall.
    const reach = Math.max(p[1] + step, pos[1]!);
    if (this.grounds.length && !embedded && this.provided(p[0], p[2], p[1], reach).wall) {
      if (!this.provided(p[0], pos[2]!, p[1], reach).wall) [p[2], v[2]] = [pos[2]!, 0];
      else if (!this.provided(pos[0]!, p[2], p[1], reach).wall) [p[0], v[0]] = [pos[0]!, 0];
      else [p[0], p[2], v[0], v[2]] = [pos[0]!, pos[2]!, 0, 0];
    }
    let floor = -Infinity;
    for (const b of this.near(p[0], p[2], radius + 2)) {
      const dx = p[0] - b.x, dz = p[2] - b.z;
      const lx = dx * b.cos - dz * b.sin, lz = dx * b.sin + dz * b.cos;
      const top = b.y + b.hy;
      if (Math.abs(lx) >= b.hx + radius || Math.abs(lz) >= b.hz + radius) continue;
      if (reach >= top && Math.abs(lx) < b.hx + radius * 0.5 && Math.abs(lz) < b.hz + radius * 0.5) {
        floor = Math.max(floor, top);
        continue;
      }
      if (p[1] + height <= b.y - b.hy || p[1] >= top) continue;
      const cx = Math.max(-b.hx, Math.min(b.hx, lx)), cz = Math.max(-b.hz, Math.min(b.hz, lz));
      let nx = lx - cx, nz = lz - cz, push: number;
      const d = Math.hypot(nx, nz);
      if (d > 1e-4) {
        push = radius - d;
        if (push <= 0) continue;
        nx /= d;
        nz /= d;
      } else {
        const ox = b.hx - Math.abs(lx), oz = b.hz - Math.abs(lz);
        if (ox < oz) [nx, nz, push] = [Math.sign(lx) || 1, 0, ox + radius];
        else [nx, nz, push] = [0, Math.sign(lz) || 1, oz + radius];
      }
      const [ux, uz] = [lx + nx * push, lz + nz * push];
      p[0] = b.x + ux * b.cos + uz * b.sin;
      p[2] = b.z - ux * b.sin + uz * b.cos;
      const gx = nx * b.cos + nz * b.sin, gz = -nx * b.sin + nz * b.cos;
      const into = v[0] * gx + v[2] * gz;
      if (into < 0) [v[0], v[2]] = [v[0] - into * gx, v[2] - into * gz];
    }
    if (this.grounds.length) floor = Math.max(floor, this.provided(p[0], p[2], p[1], embedded ? Infinity : reach).floor ?? -Infinity);
    let grounded = p[1] <= floor + EDGE && v[1] <= 0;
    if (p[1] <= floor) {
      p[1] = floor;
      v[1] = 0;
      grounded = true;
    }
    return { pos: p, vel: v, grounded };
  }

  ray(origin: number[], dir: number[], maxDistance: number): RayHit | null {
    if (!finite(maxDistance)) throw new Error("physics.ray needs a finite maxDistance");
    const [ox, oy, oz] = origin as [number, number, number];
    const len = Math.hypot(dir[0]!, dir[1]!, dir[2]!);
    if (!len) return null;
    const [dx, dy, dz] = [dir[0]! / len, dir[1]! / len, dir[2]! / len];
    let best = maxDistance;
    let id: number | null | undefined;
    const mark = ++this.mark;
    const test = (b: Box) => {
      if (b.mark === mark) return;
      b.mark = mark;
      const rx = ox - b.x, rz = oz - b.z;
      const o = [rx * b.cos - rz * b.sin, oy - b.y, rx * b.sin + rz * b.cos];
      const d = [dx * b.cos - dz * b.sin, dy, dx * b.sin + dz * b.cos];
      const h = [b.hx, b.hy, b.hz];
      let near = -Infinity, far = best;
      for (let i = 0; i < 3; i++) {
        if (Math.abs(d[i]!) < 1e-12) {
          if (Math.abs(o[i]!) > h[i]!) return;
          continue;
        }
        let t0 = (-h[i]! - o[i]!) / d[i]!, t1 = (h[i]! - o[i]!) / d[i]!;
        if (t0 > t1) [t0, t1] = [t1, t0];
        near = Math.max(near, t0);
        far = Math.min(far, t1);
        if (near > far) return;
      }
      if (near >= 0) [best, id] = [near, b.id];
    };
    this.large.forEach(test);
    // Walk the cells the ray crosses until the nearest hit is closer than the next cell.
    let cx = Math.floor(ox / CELL), cz = Math.floor(oz / CELL);
    let tx = dx ? ((cx + (dx > 0 ? 1 : 0)) * CELL - ox) / dx : Infinity;
    let tz = dz ? ((cz + (dz > 0 ? 1 : 0)) * CELL - oz) / dz : Infinity;
    for (;;) {
      this.cells.get(cellKey(cx, cz))?.forEach(test);
      if (Math.min(tx, tz) >= best) break;
      if (tx < tz) [cx, tx] = [cx + Math.sign(dx), tx + CELL / Math.abs(dx)];
      else [cz, tz] = [cz + Math.sign(dz), tz + CELL / Math.abs(dz)];
    }
    if (this.grounds.length) {
      const under = (t: number) => {
        const y = oy + dy * t;
        const h = this.provided(ox + dx * t, oz + dz * t, y, Infinity).floor;
        return h !== null && y <= h;
      };
      for (let t = 0, prev = 0; ; prev = t, t = Math.min(best, t + 0.5)) {
        if (under(t)) {
          let [lo, hi] = [prev, t];
          for (let i = 0; i < 8; i++) {
            const mid = (lo + hi) / 2;
            if (under(mid)) hi = mid;
            else lo = mid;
          }
          [best, id] = [hi, null];
          break;
        }
        if (t >= best) break;
      }
    }
    return id === undefined ? null : { distance: best, point: [ox + dx * best, oy + dy * best, oz + dz * best], id };
  }
}
