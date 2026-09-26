// Builds and packs timelapses off the server's main thread, so players' live ticks keep flowing meanwhile.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Entity } from "./api";
import type { Activity, Tick } from "./world";

declare var self: Worker;

type Row = { at: number; full: number; data: Uint8Array<ArrayBuffer>; activity: string | null };

const RELOADED = /^\S+ reloaded ([a-z][a-z0-9-]*) v(\d+)$/;
const GONE = /^(?:\S+ removed ([a-z][a-z0-9-]*)|([a-z][a-z0-9-]*) was unloaded: [^]*)$/;
const REVERTED = /^([a-z][a-z0-9-]*) reverted to its previous version: /;

/** Follows each mod's client build through the reloads, removals and reverts in the feed; a reload's build is the mod's newest build folder by then, else the live one. `start` is what was live before the first moment. */
function clientBuilds(buildDir: string, live: Record<string, string | null>) {
  const stamps = new Map<string, string[]>();
  const builds = (mod: string) => {
    if (!stamps.has(mod)) stamps.set(mod, existsSync(join(buildDir, mod)) ? readdirSync(join(buildDir, mod)).sort((a, b) => parseInt(a, 36) - parseInt(b, 36)) : []);
    return stamps.get(mod)!;
  };
  const client = (mod: string, stamp: string | undefined) =>
    !stamp ? (live[mod] ?? null) : existsSync(join(buildDir, mod, stamp, "client/client.js")) ? `/build/${mod}/${stamp}/client/client.js` : null;
  const start: Record<string, string | null> = { ...live };
  const drawn = new Map<string, (string | null)[]>();
  return {
    start,
    /** Marks on a moment the client builds that went live (a url) or away (null) during it. */
    note(t: Tick, activity: Activity[]) {
      for (const a of activity) {
        if (a.t !== "feed") continue;
        const reloaded = a.text.match(RELOADED);
        const gone = a.text.match(GONE);
        const reverted = a.text.match(REVERTED);
        const mod = reloaded?.[1] ?? gone?.[1] ?? gone?.[2] ?? reverted?.[1];
        if (!mod) continue;
        const list = builds(mod);
        const i = list.findLastIndex((s) => parseInt(s, 36) <= a.at);
        let seen = drawn.get(mod);
        if (!seen) {
          // What it drew before its first change in the window: nothing before a first version, else the build before a reload's own.
          const before = reloaded?.[2] === "1" ? null : client(mod, list[reloaded ? i - 1 : i]);
          drawn.set(mod, (seen = [before]));
          start[mod] = before;
        }
        // A revert steps back through the builds it had, like the server's own list of previous builds.
        if (reverted) seen.pop();
        const url = reloaded ? client(mod, list[i]) : gone ? null : (seen.at(-1) ?? client(mod, list[i - 1]));
        if (!reverted || !seen.length) seen.push(url);
        (t.mods ??= {})[mod] = url;
      }
    },
  };
}

/** Up to `limit` evenly spaced moments: the first in full, then the components that changed since the previous one and what happened meanwhile. */
function build(path: string, limit: number, older: Activity[], mods: ReturnType<typeof clientBuilds>) {
  const db = new Database(path, { readonly: true });
  db.run("pragma busy_timeout = 5000");
  const rows = db.query("select at, full, data, activity from timelapse order by at").all() as Row[];
  db.close();
  const usable = rows.slice(Math.max(0, rows.findIndex((r) => r.full)));
  if (!usable[0]?.full) return [];
  const every = Math.ceil(usable.length / limit);
  const state = new Map<string, Entity>();
  let before = new Map<string, Entity | undefined>();
  const change = (id: string, e: Entity | undefined) => {
    if (!before.has(id)) before.set(id, state.get(id));
    if (e) state.set(id, e);
    else state.delete(id);
  };
  const ticks: Tick[] = [];
  let activity: Activity[] = [];
  let prevAt = usable[0].at;
  usable.forEach((row, i) => {
    activity.push(...(row.activity === null ? older.filter((a) => a.at > prevAt && a.at <= row.at) : (JSON.parse(row.activity) as Activity[])));
    prevAt = row.at;
    // A routine keyframe after the first repeats what the changes around it already say.
    const data = i && row.full === 2 ? { set: {}, unset: {}, removed: [] } : JSON.parse(new TextDecoder().decode(Bun.gunzipSync(row.data)));
    if (row.full && !(i && row.full === 2)) {
      for (const id of [...state.keys()]) if (!(id in data)) change(id, undefined);
      for (const [id, e] of Object.entries<Entity>(data)) if (JSON.stringify(e) !== JSON.stringify(state.get(id))) change(id, e);
    } else {
      // Moments recorded before component diffs carry whole entities in set; merging them gives the same result.
      for (const [id, part] of Object.entries<Entity>(data.set)) change(id, { ...state.get(id), ...part });
      for (const [id, keys] of Object.entries<string[]>(data.unset)) {
        const e = state.get(id);
        if (!e || !keys.some((k) => k in e)) continue;
        const copy = { ...e };
        for (const k of keys) delete copy[k];
        change(id, copy);
      }
      for (const id of data.removed as number[]) if (state.has(String(id))) change(String(id), undefined);
    }
    if (i % every && i !== usable.length - 1) return;
    if (!ticks.length) ticks.push({ at: row.at, reset: true, set: Object.fromEntries(state), unset: {}, removed: [] });
    else {
      const tick: Tick = { at: row.at, set: {}, unset: {}, removed: [] };
      for (const [id, was] of before) {
        const now = state.get(id);
        if (!now) {
          if (was) tick.removed.push(Number(id));
          continue;
        }
        if (!was) {
          tick.set[id] = now;
          continue;
        }
        let part: Entity | undefined;
        for (const k in now) if (now[k] !== was[k] && (typeof now[k] !== "object" || JSON.stringify(now[k]) !== JSON.stringify(was[k]))) (part ??= {})[k] = now[k];
        const lost = Object.keys(was).filter((k) => !(k in now));
        if (part) tick.set[id] = part;
        if (lost.length) tick.unset[id] = lost;
      }
      ticks.push(tick);
    }
    mods.note(ticks.at(-1)!, activity);
    if (activity.length) ticks.at(-1)!.activity = activity.slice(-40);
    activity = [];
    before = new Map();
  });
  if (ticks[0]) ticks[0].mods = { ...mods.start, ...ticks[0].mods };
  return ticks;
}

self.onmessage = ({ data: msg }) => {
  try {
    if (msg.t === "build") return postMessage({ id: msg.id, ticks: build(msg.path, msg.limit, msg.older, clientBuilds(msg.builds, msg.live)) });
    const gz = Bun.gzipSync(JSON.stringify(msg.ticks));
    postMessage({ id: msg.id, gz }, [gz.buffer]);
  } catch (e: any) {
    postMessage({ id: msg.id, error: String(e?.stack ?? e) });
  }
};
