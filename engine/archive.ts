// Packs a world into a zip another host can import, and unpacks one, off the launcher's main thread so the game it proxies keeps flowing.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { sanitizeLock, sanitizeManifest } from "./box/packages";
import { readModDatabase, removeRecordedChat } from "./box/db-export";
import { GIT, GIT_ENV, hasGit } from "./mods";

declare var self: Worker;

/** Everything that defines a world. keys.json, the players' signing keys, never leaves, and config.json leaves without its invite and host key. */
const FILES = new Set(["config.json", "owners.json", "seeded.json", "about.json", "mods.json", "games.json", "seats.json", "world.sqlite", "record.sqlite", "cover.jpg"]);
const DIRS = new Set(["world", "db", "build"]);
const PRIVATE: Record<string, true> = { "record.sqlite": true, "seats.json": true };
type ArchiveFiles = Record<string, Uint8Array | [Uint8Array, { level: 0 }]>;
/** Packages come back with bun install, SQLite's side files are folded into each database's copy, and a lock in .git is a commit caught halfway. */
const SKIP = /(^|\/)node_modules(\/|$)|\.sqlite-(wal|shm|journal)$|\/\.git\/.*\.lock$/;
const DATABASE = /^(db\/)?[^/]+\.sqlite$/;
/** Of a game's folder only its save travels; whatever else its process keeps there is its own business. */
const GAME_ID = /^[a-z][a-z0-9-]{0,31}$/;
const GAME_SAVE = /^games\/[a-z][a-z0-9-]{0,31}\/world\.sqlite$/;
const UNZIPPED_LIMIT = 2 ** 31;
const NOT_A_WORLD = "That file isn't a Sandbox world.";
/** Same known token shapes the former public Share export refused. A private move never uses this guard. */
const KEY_SHAPES = /sk-ant-[\w-]{20,}|sk-[A-Za-z0-9_-]{32,}|sk_[a-z]+_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,}|xox[abprs]-[\w-]{10,}|AIza[\w-]{35}/;

function publicGuard(config: Record<string, unknown>, playerKeys: string[], extra: unknown) {
  const envSecrets = Object.entries(process.env).flatMap(([name, value]) => value && value.length >= 8 && /KEY|TOKEN|SECRET|PASS|AUTH|CREDENTIAL/i.test(name) ? [value] : []);
  const secrets = [config.hostKey, config.invite, ...playerKeys, ...envSecrets, ...(Array.isArray(extra) ? extra : [])]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const unicodeSecrets = secrets.filter((secret) => /[^\x00-\x7f]/.test(secret));
  // Latin-1 covers byte-for-byte ASCII tokens in arbitrary binary files; UTF-8 also checks non-ASCII known values.
  const check = (bytes: Uint8Array | string, where: string) => {
    const data = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const latin = data.toString("latin1");
    if (KEY_SHAPES.test(latin) || secrets.some((secret) => latin.includes(secret)) ||
        (unicodeSecrets.length > 0 && unicodeSecrets.some((secret) => data.toString("utf8").includes(secret))))
      throw new Error(`This world can't be shared: ${where} contains what looks like a key or password.`);
  };
  return { check, overlap: Math.max(128, ...secrets.map((secret) => Buffer.byteLength(secret))) };
}

/** Scan the exact archived Git bytes, not live history that may be pruned or repacked during export. */
async function checkHistory(scratch: string, files: ArchiveFiles, check: (bytes: Uint8Array, where: string) => void, overlap: number) {
  const gitDir = join(scratch, "history.git");
  let found = false;
  for (const [name, content] of Object.entries(files)) {
    if (!name.startsWith("world/.git/")) continue;
    found = true;
    const path = join(gitDir, name.slice("world/.git/".length));
    mkdirSync(name.endsWith("/") ? path : dirname(path), { recursive: true });
    if (!name.endsWith("/")) writeFileSync(path, Array.isArray(content) ? content[0] : content);
  }
  if (!found) return;
  if (!hasGit) throw new Error("This world can't be shared: Git history could not be checked.");
  const proc = Bun.spawn([...GIT, "--git-dir", gitDir, "cat-file", "--batch-all-objects", "--batch"], {
    cwd: scratch, env: GIT_ENV, stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });
  let suffix: Buffer = Buffer.alloc(0);
  try {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const combined = suffix.length ? Buffer.concat([suffix, bytes]) : bytes;
      check(combined, "world history");
      suffix = combined.subarray(Math.max(0, combined.length - overlap));
    }
    if (await proc.exited) throw new Error("This world can't be shared: Git history could not be checked.");
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
}

type Build = { server: string | null };
type Mod = { build: Build; previous: Build[] };

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2));
const readJson = (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});

/** A consistent copy of a trusted world or game database another process may be writing, with the world's secrets out of every table. Mod databases instead stay inside the box, including all their SQLite reads and scrubbing writes. */
function snapshot(path: string, into: string, secrets: string[], community: boolean, verify?: (value: string) => void) {
  const source = new Database(path, { readonly: true });
  source.run("pragma busy_timeout = 5000");
  source.run("vacuum into ?", [into]);
  source.close();
  const copy = new Database(into);
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const scrub = (text: string) => secrets.reduce((t, s) => t.replaceAll(s, "[secret]"), text);
  let scrubbed = community ? removeRecordedChat(copy) : 0;
  for (const { name } of copy.query("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as { name: string }[]) {
    for (const { name: column } of copy.query("select name from pragma_table_info(?)").all(name) as { name: string }[]) {
      const [table, col] = [quote(name), quote(column)];
      for (const secret of secrets) scrubbed += copy.run(`update ${table} set ${col} = replace(${col}, ?1, '[secret]') where typeof(${col}) = 'text' and instr(${col}, ?1)`, [secret]).changes;
      // Timelapse moments are gzipped JSON.
      for (const { v } of copy.query(`select ${col} v from ${table} where typeof(${col}) = 'blob' and substr(${col}, 1, 2) = x'1f8b'`).all() as { v: Uint8Array<ArrayBuffer> }[]) {
        const text = new TextDecoder().decode(Bun.gunzipSync(v));
        const clean = scrub(text);
        verify?.(clean);
        if (clean !== text) scrubbed += copy.run(`update ${table} set ${col} = ? where ${col} = ?`, [Bun.gzipSync(clean), v]).changes;
      }
    }
  }
  if (scrubbed) copy.run("vacuum");
  copy.close();
  return readFileSync(into);
}

/**
 * The world's files as an export holds them, by path; `leaveOut` names top-level files to skip. A Community export also
 * refuses anything that looks like a key in `publicContent`, the files, the databases and the Git history.
 */
async function collect(dir: string, community: boolean, scratch: string, leaveOut: Record<string, true>, publicSecrets?: unknown, publicContent: (string | Uint8Array)[] = []) {
  const config = readJson(join(dir, "config.json"));
  const playerKeys = Object.keys(readJson(join(dir, "keys.json")));
  const secrets = [config.hostKey, config.invite, ...playerKeys].filter(Boolean);
  const guard = community ? publicGuard(config, playerKeys, publicSecrets) : null;
  if (guard) for (const content of publicContent) guard.check(content, "publication details");
  const files: ArchiveFiles = {};
  const add = async (rel: string) => {
    if (leaveOut[rel]) return;
    const path = join(dir, rel);
    if (rel === "config.json") files[rel] = json({ name: config.name, rules: config.rules, start: config.start, ...(config.forkOf && { forkOf: config.forkOf }) });
    else if (rel === "mods.json") {
      // Server builds are named by absolute path; relative to build/ they point at the builds wherever the world lands.
      const portable = (b: Build) => ({ ...b, server: b.server && relative(join(dir, "build"), resolve(dir, "build", b.server)).split(sep).join("/") });
      const mods: Record<string, Mod> = readJson(path);
      files[rel] = json(Object.fromEntries(Object.entries(mods).map(([name, m]) => [name, { ...m, build: portable(m.build), previous: m.previous.map(portable) }])));
    } else if (rel.startsWith("db/") && DATABASE.test(rel)) {
      const mod = rel.slice(3, -".sqlite".length);
      if (!GAME_ID.test(mod)) return;
      files[rel] = await readModDatabase(join(dir, "db"), mod, secrets, community, guard ? (value) => guard.check(value, "a mod database") : undefined);
    } else if (DATABASE.test(rel) || GAME_SAVE.test(rel)) files[rel] = snapshot(path, join(scratch, rel.replaceAll("/", "-")), secrets, community, guard ? (value) => guard.check(value, "a world database") : undefined);
    // Git objects are compressed already.
    else files[rel] = rel.includes("/.git/objects/") ? [readFileSync(path), { level: 0 }] : readFileSync(path);
    if (guard) {
      const content = files[rel]!;
      guard.check(Array.isArray(content) ? content[0] : content, "a world file");
    }
  };
  const objects: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = readdirSync(join(dir, rel), { withFileTypes: true });
    // Git needs its empty folders, like refs/tags.
    if (!entries.length) files[`${rel}/`] = new Uint8Array(0);
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (rel === "db") {
        // Nothing but <mod>.sqlite is part of a mod's state. In particular, never stat or open
        // stray files here: a mod can race a regular file into a symlink to host secrets.
        if (entry.name.endsWith(".sqlite") && GAME_ID.test(entry.name.slice(0, -".sqlite".length))) await add(child);
        continue;
      }
      if (SKIP.test(child)) continue;
      if (child.endsWith("/.git/objects")) objects.push(child);
      else if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) await add(child);
    }
  };
  // Whatever points is read before what it points to, so a reload landing mid-export can't leave it dangling: mods.json before the builds, git's refs before its objects.
  for (const part of [...FILES, ...DIRS]) if (existsSync(join(dir, part))) statSync(join(dir, part)).isDirectory() ? await walk(part) : await add(part);
  if (existsSync(join(dir, "games"))) for (const id of readdirSync(join(dir, "games"))) if (GAME_ID.test(id) && existsSync(join(dir, "games", id, "world.sqlite"))) await add(`games/${id}/world.sqlite`);
  for (const rel of objects) await walk(rel);
  if (guard) await checkHistory(scratch, files, guard.check, guard.overlap);
  return files;
}

async function pack(dir: string, community: boolean, publicSecrets?: unknown, publicContent: (string | Uint8Array)[] = []) {
  const scratch = mkdtempSync(join(tmpdir(), "sandbox-export-"));
  try {
    return zipSync(await collect(dir, community, scratch, community ? PRIVATE : {}, publicSecrets, publicContent));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A running world's copy in another folder, as an export would carry it, without its record or picture: a playtest's own world. */
export async function copyWorld(dir: string, into: string) {
  const scratch = mkdtempSync(join(tmpdir(), "sandbox-copy-"));
  try {
    for (const [name, entry] of Object.entries(await collect(dir, false, scratch, { "record.sqlite": true, "cover.jpg": true }))) {
      const path = join(into, name);
      mkdirSync(name.endsWith("/") ? path : dirname(path), { recursive: true });
      if (!name.endsWith("/")) writeFileSync(path, Array.isArray(entry) ? entry[0] : entry);
    }
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

/**
 * What of a safe entry an import keeps. Of world/ only the mods and the files the engine writes there; of its .git only the history: its config, hooks, attributes and any pointer to another repository or object store stay behind, and the engine writes a config of its own.
 * Bun reads config files like bunfig.toml and .npmrc from a world's folder, and git runs what a repository's config and hooks name, so a stranger's world brings none of them.
 */
function kept(name: string) {
  if (!name.startsWith("world/")) return true;
  const rest = name.slice("world/".length);
  if (rest.startsWith(".git/")) {
    const git = rest.slice(".git/".length);
    if (/^objects\/info\/(http-)?alternates$/.test(git)) return false;
    return git === "" || /^(HEAD|ORIG_HEAD|packed-refs|index|shallow)$/.test(git) || /^(refs|logs|objects)(\/|$)/.test(git);
  }
  if (rest.startsWith("mods/")) return !rest.split("/").includes(".git");
  return rest === "" || rest === "mods" || /^(api\.ts|GUIDE\.md|tsconfig\.json|\.gitignore|package\.json|bun\.lock)$/.test(rest);
}

/** The repository config an imported world's history gets: the engine's own, keeping only the hash its objects are named by. */
function gitConfig(imported: Uint8Array | undefined) {
  const sha256 = !!imported && /^\s*objectformat\s*=\s*sha256\s*$/im.test(new TextDecoder().decode(imported));
  return `[core]\n\trepositoryformatversion = ${sha256 ? 1 : 0}\n\tfilemode = ${process.platform !== "win32"}\n\tbare = false\n\tlogallrefupdates = true\n[user]\n\tname = sandbox\n\temail = sandbox@sandbox\n${sha256 ? "[extensions]\n\tobjectformat = sha256\n" : ""}`;
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
  // A stranger's package.json keeps only npm registry packages by plain version, and its bun.lock only plain registry entries, which pin those versions.
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let pkg: unknown = null;
  try {
    pkg = JSON.parse(decoder.decode(files["world/package.json"] ?? new Uint8Array()));
  } catch {}
  const { manifest } = sanitizeManifest(pkg);
  if (files["world/package.json"]) files["world/package.json"] = encoder.encode(JSON.stringify(manifest, null, 2));
  const lock = files["world/bun.lock"] && sanitizeLock(decoder.decode(files["world/bun.lock"]), manifest);
  if (lock) files["world/bun.lock"] = encoder.encode(lock);
  else delete files["world/bun.lock"];
  for (const [name, data] of Object.entries(files)) {
    if (!kept(name)) continue;
    const path = join(into, name);
    mkdirSync(name.endsWith("/") ? path : dirname(path), { recursive: true });
    if (!name.endsWith("/")) writeFileSync(path, data);
  }
  if (existsSync(join(into, "world/.git/HEAD"))) writeFileSync(join(into, "world/.git/config"), gitConfig(files["world/.git/config"]));
  return { name: config.name, rules: config.rules, start: config.start, ...(typeof config.forkOf === "string" && { forkOf: config.forkOf }) };
}

if (!Bun.isMainThread) self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.t === "pack") {
      const zip = await pack(msg.dir, msg.community === true, msg.secrets, msg.publicContent);
      return postMessage({ zip }, [zip.buffer]);
    }
    postMessage({ world: unpack(msg.zip, msg.into) });
  } catch (e: any) {
    postMessage({ error: e.message });
  }
};
