// Packs a world into a zip another host can import, and unpacks one, off the launcher's main thread so the game it proxies keeps flowing.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { unzipSync, zipSync, type Zippable } from "fflate";

declare var self: Worker;

/** Everything that defines a world. keys.json, the players' signing keys, never leaves, and config.json leaves without its invite and host key. */
const FILES = new Set(["config.json", "owners.json", "seeded.json", "about.json", "mods.json", "games.json", "seats.json", "world.sqlite", "record.sqlite", "cover.jpg"]);
const DIRS = new Set(["world", "db", "build"]);
/** A world shared to Community leaves out what its players did and said: the record (chat, tool calls, sessions), where each player sits, and the chat inside its Timelapse moments. */
const PRIVATE = new Set(["record.sqlite", "seats.json"]);
/** Packages come back with bun install, SQLite's side files are folded into each database's copy, and a lock in .git is a commit caught halfway. */
const SKIP = /(^|\/)node_modules(\/|$)|\.sqlite-(wal|shm|journal)$|\/\.git\/.*\.lock$/;
const DATABASE = /^(db\/)?[^/]+\.sqlite$/;
/** Of a game's folder only its save travels; whatever else its process keeps there is its own business. */
const GAME_ID = /^[a-z][a-z0-9-]{0,31}$/;
const GAME_SAVE = /^games\/[a-z][a-z0-9-]{0,31}\/world\.sqlite$/;
const UNZIPPED_LIMIT = 2 ** 31;
const NOT_A_WORLD = "That file isn't a Sandbox world.";

type Build = { server: string | null };
type Mod = { build: Build; previous: Build[] };

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2));
const readJson = (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});

/** A consistent copy of a database another process may be writing, with the world's secrets out of every table, since players paste invites into chat; the last vacuum drops freed pages that still hold them. */
function snapshot(path: string, into: string, secrets: string[], community: boolean) {
  const source = new Database(path, { readonly: true });
  source.run("pragma busy_timeout = 5000");
  source.run("vacuum into ?", [into]);
  source.close();
  const copy = new Database(into);
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const scrub = (text: string) => secrets.reduce((t, s) => t.replaceAll(s, "[secret]"), text);
  let scrubbed = 0;
  if (community && copy.query("select 1 from pragma_table_info('timelapse') where name = 'activity'").get())
    scrubbed += copy.run(`update timelapse set activity = (select json_group_array(json(value)) from json_each(timelapse.activity) where json_extract(value, '$.t') is not 'chat') where json_valid(activity) and exists (select 1 from json_each(timelapse.activity) where json_extract(value, '$.t') = 'chat')`).changes;
  for (const { name } of copy.query("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as { name: string }[]) {
    for (const { name: column } of copy.query("select name from pragma_table_info(?)").all(name) as { name: string }[]) {
      const [table, col] = [quote(name), quote(column)];
      for (const secret of secrets) scrubbed += copy.run(`update ${table} set ${col} = replace(${col}, ?1, '[secret]') where typeof(${col}) = 'text' and instr(${col}, ?1)`, [secret]).changes;
      // Timelapse moments are gzipped JSON.
      for (const { v } of copy.query(`select ${col} v from ${table} where typeof(${col}) = 'blob' and substr(${col}, 1, 2) = x'1f8b'`).all() as { v: Uint8Array<ArrayBuffer> }[]) {
        const text = new TextDecoder().decode(Bun.gunzipSync(v));
        const clean = scrub(text);
        if (clean !== text) scrubbed += copy.run(`update ${table} set ${col} = ? where ${col} = ?`, [Bun.gzipSync(clean), v]).changes;
      }
    }
  }
  if (scrubbed) copy.run("vacuum");
  copy.close();
  return readFileSync(into);
}

function pack(dir: string, community: boolean) {
  const config = readJson(join(dir, "config.json"));
  const secrets = [config.hostKey, config.invite, ...Object.keys(readJson(join(dir, "keys.json")))].filter(Boolean);
  const scratch = mkdtempSync(join(tmpdir(), "sandbox-export-"));
  const files: Zippable = {};
  const add = (rel: string) => {
    const path = join(dir, rel);
    if (community && PRIVATE.has(rel)) return;
    if (rel === "config.json") files[rel] = json({ name: config.name, rules: config.rules, start: config.start, ...(config.forkOf && { forkOf: config.forkOf }) });
    else if (rel === "mods.json") {
      // Server builds are named by absolute path; relative to build/ they point at the builds wherever the world lands.
      const portable = (b: Build) => ({ ...b, server: b.server && relative(join(dir, "build"), resolve(dir, "build", b.server)).split(sep).join("/") });
      const mods: Record<string, Mod> = readJson(path);
      files[rel] = json(Object.fromEntries(Object.entries(mods).map(([name, m]) => [name, { ...m, build: portable(m.build), previous: m.previous.map(portable) }])));
    } else if (DATABASE.test(rel) || GAME_SAVE.test(rel)) files[rel] = snapshot(path, join(scratch, rel.replaceAll("/", "-")), secrets, community);
    // Git objects are compressed already.
    else files[rel] = rel.includes("/.git/objects/") ? [readFileSync(path), { level: 0 }] : readFileSync(path);
  };
  const objects: string[] = [];
  const walk = (rel: string) => {
    const entries = readdirSync(join(dir, rel), { withFileTypes: true });
    // Git needs its empty folders, like refs/tags.
    if (!entries.length) files[`${rel}/`] = new Uint8Array(0);
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (SKIP.test(child)) continue;
      if (child.endsWith("/.git/objects")) objects.push(child);
      else if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) add(child);
    }
  };
  try {
    // Whatever points is read before what it points to, so a reload landing mid-export can't leave it dangling: mods.json before the builds, git's refs before its objects.
    for (const part of [...FILES, ...DIRS]) if (existsSync(join(dir, part))) statSync(join(dir, part)).isDirectory() ? walk(part) : add(part);
    if (existsSync(join(dir, "games"))) for (const id of readdirSync(join(dir, "games"))) if (GAME_ID.test(id) && existsSync(join(dir, "games", id, "world.sqlite"))) add(`games/${id}/world.sqlite`);
    for (const rel of objects) walk(rel);
    return zipSync(files);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Only the parts of a world, each where it belongs, and nothing that climbs out of the folder it unpacks into. */
function safe(name: string, into: string) {
  const folder = name.endsWith("/");
  const parts = (folder ? name.slice(0, -1) : name).split("/");
  if (!parts.every((p) => p && p !== "." && p !== ".." && !/[\\:\0]/.test(p))) return false;
  // Game saves by exact path; their folders too, for zip tools that list folders.
  const game = GAME_SAVE.test(name) || (folder && parts[0] === "games" && (parts.length === 1 || (parts.length === 2 && GAME_ID.test(parts[1]!))));
  if (!game && !(parts.length === 1 && !folder ? FILES.has(parts[0]!) : DIRS.has(parts[0]!))) return false;
  return resolve(into, name).startsWith(into + sep);
}

function unpack(zip: Uint8Array, into: string) {
  const unzip = (filter: (file: { originalSize: number }) => boolean) => {
    try {
      return unzipSync(zip, { filter });
    } catch {
      throw new Error(NOT_A_WORLD);
    }
  };
  // Sizes come from the zip's directory, so a zip bomb is turned away before anything is inflated.
  let total = 0;
  unzip((file) => ((total += file.originalSize), false));
  if (total > UNZIPPED_LIMIT) throw new Error("That world is too big to import.");
  const files = unzip(() => true);
  if (!files["config.json"] || !Object.keys(files).every((name) => safe(name, into))) throw new Error(NOT_A_WORLD);
  const config = (() => {
    try {
      return JSON.parse(new TextDecoder().decode(files["config.json"]));
    } catch {}
  })();
  if (typeof config?.name !== "string") throw new Error(NOT_A_WORLD);
  for (const [name, data] of Object.entries(files)) {
    const path = join(into, name);
    mkdirSync(name.endsWith("/") ? path : dirname(path), { recursive: true });
    if (!name.endsWith("/")) writeFileSync(path, data);
  }
  return { name: config.name, rules: config.rules, start: config.start, ...(typeof config.forkOf === "string" && { forkOf: config.forkOf }) };
}

self.onmessage = ({ data: msg }) => {
  try {
    if (msg.t === "pack") {
      const zip = pack(msg.dir, msg.community === true);
      return postMessage({ zip }, [zip.buffer]);
    }
    postMessage({ world: unpack(msg.zip, msg.into) });
  } catch (e: any) {
    postMessage({ error: e.message });
  }
};
