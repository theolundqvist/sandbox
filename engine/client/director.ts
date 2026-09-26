import type { Entity } from "../api";

export type Activity = { at: number } & (
  | { t: "feed"; text: string; kind: string }
  | { t: "chat"; from: string; text: string; spoken?: boolean }
  | { t: "announce"; mod: string; by: string; title: string; text: string; color: string }
);
export type Tick = { at: number; reset?: true; set: Record<string, Entity>; unset: Record<string, string[]>; removed: number[]; activity?: Activity[]; mods?: Record<string, string | null> };
type Vec = [number, number, number];
/** A stretch of the replay from tick `from` up to `to`: what it shows (`target` only when the changes have positions) and `marks`, building spots as flat xyz. */
export type Shot = { from: number; to: number; kind: "place" | "overview" | "follow"; target?: Vec; radius: number; ids: number[]; mod?: string; player?: string; caption: string; marks: number[] };
/** A reload or banner on the timeline. */
export type Marker = { tick: number; who: string; label: string; color: string };
export type Plan = { shots: Shot[]; chapters: number[]; density: number[]; markers: Marker[]; stateAt(tick: number): Record<string, Entity> };

type Change = { id: string; tick: number; pos?: Vec; weight: number; entity: Entity; mod?: string };

const MOTION = new Set(["pos", "rot", "anim", "vel", "input"]);
const CELL = 40;
const CHECKPOINT = 60;
export const isAvatar = (e: Entity) => !!e.avatar && typeof e.player === "string";
export const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const far = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Applies one tick; entities are replaced, never mutated, so checkpoints stay intact. */
export function step(state: Map<string, Entity>, t: Tick) {
  if (t.reset) state.clear();
  for (const id of t.removed) state.delete(String(id));
  for (const [id, part] of Object.entries(t.set)) state.set(id, { ...state.get(id), ...part });
  for (const [id, keys] of Object.entries(t.unset)) {
    const was = state.get(id);
    if (!was) continue;
    const e = { ...was };
    for (const k of keys) delete e[k];
    state.set(id, e);
  }
}

/** Shots of `span` ticks or more, each on where most was built; whatever moves or keeps changing on its own doesn't count as building. */
export function plan(ticks: Tick[], span: number): Plan {
  const state = new Map<string, Entity>();
  const checkpoints: Map<string, Entity>[] = [];
  const moved = new Set<string>();
  const edits = new Map<string, number>();
  const died = new Map<string, number>();
  const found: Change[] = [];
  const avatars: Map<string, Vec>[] = [];
  const builders: { tick: number; who: string; mod: string }[] = [];
  const markers: Marker[] = [];
  const titles = new Map<string, string>();
  // A reload respawns a mod's things under new ids; whatever comes back identical wasn't built.
  let gone = new Map<string, Change>();
  ticks.forEach((t, i) => {
    const goneBefore = gone;
    gone = new Map();
    if (!t.reset)
      for (const id of t.removed) {
        const was = state.get(String(id));
        died.set(String(id), i);
        if (!was) continue;
        const c = { id: String(id), tick: i, pos: position(was), weight: 1, entity: was };
        gone.set(JSON.stringify(was), c);
        found.push(c);
      }
    const before = new Map(Object.keys(t.set).map((id) => [id, state.get(id)]));
    step(state, t);
    if (!t.reset)
      for (const [id, part] of Object.entries(t.set)) {
        const e = state.get(id)!;
        const was = before.get(id);
        if (!was) {
          const json = JSON.stringify(e);
          const match = gone.get(json) ?? goneBefore.get(json);
          if (match) match.weight = 0;
          found.push({ id, tick: i, pos: position(e), weight: match ? 0 : 3, entity: e });
        } else if ("pos" in part && !same(part.pos, was.pos)) moved.add(id);
        else if (Object.keys(part).some((k) => !MOTION.has(k) && !same(part[k], was[k])) || t.unset[id]?.length) {
          edits.set(id, (edits.get(id) ?? 0) + 1);
          found.push({ id, tick: i, pos: position(e), weight: 1, entity: e });
        }
      }
    if (i % CHECKPOINT === 0) checkpoints.push(new Map(state));
    if (i % span === 0) avatars.push(new Map([...state.values()].filter(isAvatar).map((e) => [e.player, e.pos])));
    for (const a of t.activity ?? []) {
      if (a.t === "announce") {
        if (!titles.has(a.mod)) titles.set(a.mod, a.title);
        builders.push({ tick: i, who: a.by, mod: a.mod });
        markers.push({ tick: i, who: a.by, label: `${a.by}: ${a.title}`, color: a.color });
      }
      if (a.t !== "feed") continue;
      const reload = a.text.match(/^(\S+) reloaded (\S+) v\d+$/);
      const [, who, mod] = reload ?? a.text.match(/^(\S+)'s Claude is editing ([^/\s]+)\//) ?? [];
      if (!who || !mod) continue;
      builders.push({ tick: i, who, mod });
      if (reload) markers.push({ tick: i, who, label: a.text, color: "" });
    }
  });
  const mods = [...new Set(builders.map((b) => b.mod))].sort((a, b) => b.length - a.length);
  // Things of a mod nobody touched around then changed through play (harvests, respawns); a fresh reload counts double.
  const changes = found.flatMap((c) => {
    if (!c.weight || moved.has(c.id) || isAvatar(c.entity) || (edits.get(c.id) ?? 0) > 5) return [];
    if (c.weight === 3 && (died.get(c.id) ?? Infinity) - c.tick < 3) return [];
    const mod = modOf(c.entity, mods);
    if (!mod) return [c];
    return builders.some((b) => b.mod === mod && Math.abs(b.tick - c.tick) <= span) ? [{ ...c, weight: c.weight * 2, mod }] : [];
  });
  // A game is spatial when most of what was built has a position; otherwise shots are about mods, not places.
  const spatial = changes.reduce((w, c) => w + (c.pos ? c.weight : -c.weight), 0) >= 0;
  const density = ticks.map(() => 0);
  for (const c of changes) density[c.tick]! += c.weight;
  const placed = [...state.values()].flatMap((e) => (isAvatar(e) || !position(e) ? [] : [position(e)!]));
  const world = placed.length ? extent(placed) : { radius: 30 };

  const shots: Shot[] = [];
  let places = 0;
  let wandering = 0;
  let marks: number[] = [];
  const everything: number[] = [];
  const overview = (from: number, to: number, caption: string): Shot => {
    places = 0;
    const shot: Shot = { from, to, kind: "overview", ...world, ids: [], caption, marks };
    marks = [];
    return shot;
  };
  for (let from = 0; from < ticks.length; from += span) {
    const to = Math.min(ticks.length, from + span);
    const here = changes.filter((c) => c.tick >= from && c.tick < to);
    for (const c of here.slice(0, 300)) if (c.pos) marks.push(...c.pos);
    for (const c of here.slice(0, 60)) if (c.pos) everything.push(...c.pos);
    const time = clock(ticks[from]!.at);
    const last = shots.at(-1);
    if (!last || places >= 6) {
      const who = [...new Set(builders.filter((b) => b.tick < to && b.tick >= (last?.from ?? 0)).map((b) => b.who))];
      shots.push(overview(from, to, who.length ? `${time} · ${list(who)} building` : `${time} · the whole world`));
      continue;
    }
    // Where most was built, or for games whose things have no position, the mod most was built with.
    const spot = spatial ? hottest(here.filter((c) => c.pos)) : busiest(here.filter((c) => !c.pos));
    // Things whose components don't name their mod belong to the one mod people worked on around then, if there was only one.
    const around = new Set(builders.filter((b) => Math.abs(b.tick - from) <= 3 * span).map((b) => b.mod));
    const mod = spot ? (modAt(spot.changes) ?? (around.size === 1 ? [...around][0] : undefined)) : undefined;
    const staying = spot && last.kind === "place" && (spot.target && last.target ? far(last.target, spot.target) < Math.max(60, last.radius) : !spot.target && !last.target && last.mod === mod);
    if (to - from < span / 2 || (spot ? staying : to - last.from <= 2 * span)) {
      last.to = to;
      continue;
    }
    if (!spot) {
      // Nothing was built here: follow someone who is out exploring, or look at the whole world.
      const later = avatars[from / span + 1] ?? new Map();
      const people = [...(avatars[from / span] ?? [])].filter(([who, at]) => later.has(who) && far(at, later.get(who)!) > 8);
      const [who, at] = people[wandering++ % Math.max(1, people.length)] ?? [];
      const busy = builders.findLast((b) => b.tick >= from && b.tick < to && (!who || b.who === who));
      const doing = busy ? `${busy.who} works on ${titles.get(busy.mod) ?? busy.mod}` : who && `${who} exploring`;
      if (!who && !doing && last.kind === "overview") {
        last.to = to;
        continue;
      }
      shots.push(who && at ? { from, to, kind: "follow", target: at, radius: 10, ids: [], mod: busy?.mod, player: who, caption: `${time} · ${doing}`, marks: [] } : overview(from, to, `${time} · ${doing || "the whole world"}`));
      places++;
      continue;
    }
    const who = builders.filter((b) => b.mod === mod).sort((a, b) => Math.abs(a.tick - from) - Math.abs(b.tick - from))[0]?.who;
    const what = mod && (titles.get(mod) ?? mod);
    const caption = `${time} · ${what ? `${who ? `${who} builds ` : ""}${what}` : who ? `${who} building` : "something new"}`;
    const avatar = who ? avatars[from / span]?.get(who) : undefined;
    const follow = places % 3 === 2 && !!avatar && !!spot.target && far(avatar, spot.target) < 150;
    const ids = [...new Set(spot.changes.map((c) => Number(c.id)))].slice(0, 200);
    shots.push({ from, to, kind: follow ? "follow" : "place", target: spot.target, radius: spot.radius, ids, mod, player: who, caption, marks: [] });
    places++;
  }
  marks = everything;
  shots.push(overview(ticks.length, ticks.length, `${clock(ticks.at(-1)!.at)} · the world now`));

  // Consecutive shots with the same caption make one chapter.
  const about = (s: Shot) => s.caption.split(" · ").slice(1).join(" · ");
  return {
    shots,
    chapters: shots.flatMap((s, i) => (i && about(s) === about(shots[i - 1]!) ? [] : [i])),
    density,
    markers,
    stateAt(tick) {
      const at = Math.floor(tick / CHECKPOINT);
      const s = new Map(checkpoints[at]);
      for (let i = at * CHECKPOINT + 1; i <= tick; i++) step(s, ticks[i]!);
      return Object.fromEntries([...s].map(([id, e]) => [id, { ...e }]));
    },
  };
}

const list = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]!);

/** The 3×3 block of 40 m cells with the most weight, framed by where its changes lie. */
function hottest(changes: Change[]) {
  const cells = new Map<string, number>();
  const cell = (p: Vec) => [Math.floor(p[0] / CELL), Math.floor(p[2] / CELL)] as const;
  for (const c of changes) {
    const [x, z] = cell(c.pos!);
    cells.set(`${x},${z}`, (cells.get(`${x},${z}`) ?? 0) + c.weight);
  }
  let best: [number, number] | null = null;
  let bestWeight = 8;
  for (const key of cells.keys()) {
    const [x, z] = key.split(",").map(Number) as [number, number];
    let w = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) w += cells.get(`${x + dx},${z + dz}`) ?? 0;
    if (w > bestWeight) [best, bestWeight] = [[x, z], w];
  }
  if (!best) return null;
  const inside = changes.filter((c) => {
    const [x, z] = cell(c.pos!);
    return Math.abs(x - best[0]) <= 1 && Math.abs(z - best[1]) <= 1;
  });
  return { ...extent(inside.map((c) => c.pos!)), changes: inside };
}

/** The mod (or for things of no mod, the kind of thing) with the most weight among changes that have no position. */
function busiest(changes: Change[]) {
  const groups = new Map<string, Change[]>();
  for (const c of changes) {
    const key = c.mod ?? Object.keys(c.entity).find((k) => !MOTION.has(k)) ?? "";
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const [best] = [...groups.values()].map((g) => [g, g.reduce((w, c) => w + c.weight, 0)] as const).sort((a, b) => b[1] - a[1]);
  return best && best[1] > 8 ? { target: undefined, radius: 30, changes: best[0] } : null;
}

const position = (e: Entity) => (Array.isArray(e.pos) && e.pos.length >= 2 ? ([e.pos[0], e.pos[1], e.pos[2] ?? 0] as Vec) : undefined);

/** Centre of the middle 90% of these points and the radius that frames them. */
function extent(points: Vec[]) {
  if (!points.length) return { target: [0, 0, 0] as Vec, radius: 30 };
  const mid = (axis: number) => {
    const sorted = points.map((p) => p[axis]!).sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.05)]!;
    const hi = sorted[Math.floor(sorted.length * 0.95)]!;
    return [(lo + hi) / 2, (hi - lo) / 2] as const;
  };
  const [x, rx] = mid(0);
  const [y] = mid(1);
  const [z, rz] = mid(2);
  return { target: [x, y, z] as Vec, radius: Math.max(12, Math.hypot(rx, rz)) };
}

/** The mod an entity belongs to by its components: realmsCollider is realms', moExpansionSolid mo-expansions'. */
function modOf(e: Entity, mods: string[]) {
  const keys = Object.keys(e);
  return mods.find((m) => {
    const prefix = m.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()).replace(/s$/, "");
    return keys.some((k) => k.startsWith(prefix));
  });
}

function modAt(changes: Change[]) {
  const weight = new Map<string, number>();
  for (const c of changes) if (c.mod) weight.set(c.mod, (weight.get(c.mod) ?? 0) + c.weight);
  return [...weight].sort((a, b) => b[1] - a[1])[0]?.[0];
}
