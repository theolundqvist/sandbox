import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Entity } from "./api";
import { hasGit } from "./mods";
import type { Config } from "./server";
import { seedStore } from "./world";

/** world.json, the one file that makes a GitHub repo a Sandbox world. */
export type Manifest = { name: string; description: string; author: string; engine: string; start: Config["start"]; rules: Config["rules"] };
type Files = Record<string, string | Uint8Array>;

const MOD_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
/** Shapes of the keys paid services hand out, in case a mod wrote one into its code or database. */
const KEY_SHAPES = /sk-ant-[\w-]{20,}|sk-[A-Za-z0-9_-]{32,}|sk_[a-z]+_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,}|xox[abprs]-[\w-]{10,}|AIza[\w-]{35}/;
const ENGINE_VERSION =
  process.env.SANDBOX_VERSION ?? ((hasGit && Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: import.meta.dir, stdout: "pipe", stderr: "ignore" }).stdout.toString().trim()) || "dev");

const readJson = (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});

function walk(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    if (name.startsWith(".") || name === "node_modules") return [];
    const stat = statSync(abs);
    return stat.isDirectory() ? walk(abs, root) : stat.isFile() ? [relative(root, abs)] : [];
  });
}

/** Whether a value names a player anywhere: as a whole word in any text, or as a key. */
function mentioner(names: string[]) {
  if (!names.length) return () => false;
  const word = new RegExp(`(?<![\\w-])(${names.map((n) => n.replace(/[-]/g, "\\-")).join("|")})(?![\\w-])`, "i");
  const mentions = (v: unknown): boolean =>
    typeof v === "string" ? word.test(v) : !!v && typeof v === "object" && Object.entries(v).some(([k, x]) => word.test(k) || mentions(x));
  return mentions;
}

const sqlValue = (v: unknown) =>
  v === null ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : v instanceof Uint8Array ? `X'${Buffer.from(v).toString("hex")}'` : `'${String(v).replaceAll("'", "''")}'`;

/** A mod's database as SQL, without the rows that mention a player. */
function dumpDb(path: string, mentions: (v: unknown) => boolean) {
  const db = new Database(path, { readonly: true });
  try {
    return db.transaction(() => {
      const schema = db.query("select type, name, sql from sqlite_master where sql is not null and name not like 'sqlite_%' order by type = 'table' desc").all() as { type: string; name: string; sql: string }[];
      const out: string[] = [];
      for (const { type, name, sql } of schema) {
        out.push(`${sql};`);
        if (type !== "table") continue;
        for (const row of db.query(`select * from "${name.replaceAll('"', '""')}"`).values())
          if (!mentions(row)) out.push(`insert into "${name.replaceAll('"', '""')}" values (${row.map(sqlValue).join(", ")});`);
      }
      return out.join("\n") + "\n";
    })();
  } finally {
    db.close();
  }
}

/** A game's card as it travels: only its own fields, credited to whoever publishes or installs it, since createdBy names a player. Its title and tagline go as written, like mod code: dropping a card would strand the mods that name its game. */
const CARD = ["id", "title", "tagline", "color", "accent", "status", "order", "spawn", "art", "createdAt"];
function cards(games: Record<string, Record<string, unknown>>, by: string) {
  const valid = Object.entries(games).filter(([id, g]) => MOD_NAME.test(id) && g?.id === id);
  return Object.fromEntries(valid.map(([id, g]) => [id, { ...Object.fromEntries(CARD.filter((k) => g[k] !== undefined).map((k) => [k, g[k]])), createdBy: by }]));
}

/** A game's entities as its process last saved them, read-only since that process may hold the save open. */
function readSave(path: string): { nextId: number; entities: Record<string, Entity> } | null {
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    db.run("pragma busy_timeout = 5000");
    return db.transaction(() => {
      const meta = db.query("select next_id, entities from world").get() as { next_id: number; entities: string | null } | null;
      if (!meta) return null;
      const rows = meta.entities ? null : (db.query("select id, data from entity").all() as { id: number; data: string }[]);
      return { nextId: meta.next_id, entities: rows ? Object.fromEntries(rows.map((r) => [r.id, JSON.parse(r.data)])) : JSON.parse(meta.entities!) };
    })();
  } finally {
    db.close();
  }
}

/** What a new host needs to play this world, from an allowlist; anything that mentions a player is theirs and stays home. */
export function exportWorld(world: { data: string; entities: Iterable<[number, Entity]>; nextId: number }, handle: string, description: string): Files {
  if (!HANDLE.test(handle)) throw new Error("handle must be a GitHub user name: letters, digits and dashes.");
  const { data } = world;
  const config: Config & { host?: string } = readJson(join(data, "config.json"));
  const keys: Record<string, string> = readJson(join(data, "keys.json"));
  const owners: Record<string, string> = readJson(join(data, "owners.json"));
  const live: Record<string, { author: string }> = readJson(join(data, "mods.json"));
  const games: Record<string, Record<string, unknown>> = readJson(join(data, "games.json"));
  // seats.json never leaves: it is a list of players. Its names still keep them out of everything that does.
  const seated = Object.keys(readJson(join(data, "seats.json")));
  const names = [...new Set([config.host ?? "", ...Object.values(keys), ...Object.values(owners), ...Object.values(live).map((m) => m.author), ...seated, ...Object.values(games).map((g) => String(g?.createdBy ?? ""))])].filter((n) => n && n !== "world");
  const mentions = mentioner(names);
  const mods = Object.keys(live).filter((m) => MOD_NAME.test(m) && existsSync(join(data, "world/mods", m)));

  const manifest: Manifest = { name: config.name, description: String(description).trim().slice(0, 160), author: handle, engine: ENGINE_VERSION, start: config.start, rules: config.rules };
  const files: Files = {
    "world.json": JSON.stringify(manifest, null, 2) + "\n",
    "README.md": `# ${manifest.name}\n\n${manifest.description}\n\nA world for [Sandbox](https://github.com/theolundqvist/sandbox). To play it, open Sandbox, go to Worlds, then Browse, and paste this page's link.\n`,
  };
  for (const mod of mods) for (const file of walk(join(data, "world/mods", mod))) files[`mods/${mod}/${file}`] = readFileSync(join(data, "world/mods", mod, file));
  const pkg = readJson(join(data, "world/package.json"));
  if (Object.keys(pkg.dependencies ?? {}).length) {
    files["package.json"] = JSON.stringify({ private: true, dependencies: pkg.dependencies }, null, 2) + "\n";
    if (existsSync(join(data, "world/bun.lock"))) files["bun.lock"] = readFileSync(join(data, "world/bun.lock"));
  }
  const entities = Object.fromEntries([...world.entities].filter(([, e]) => !mentions(e)));
  files["state/entities.json"] = JSON.stringify({ nextId: world.nextId, entities });
  const published = cards(games, handle);
  if (Object.keys(published).length) files["games.json"] = JSON.stringify(published, null, 2) + "\n";
  for (const id of Object.keys(published)) {
    const save = readSave(join(data, "games", id, "world.sqlite"));
    if (save) files[`state/games/${id}/entities.json`] = JSON.stringify({ nextId: save.nextId, entities: Object.fromEntries(Object.entries(save.entities).filter(([, e]) => !mentions(e))) });
  }
  const about = readJson(join(data, "about.json"));
  files["state/about.json"] = JSON.stringify(Object.fromEntries(Object.entries(about).filter(([mod, a]) => mods.includes(mod) && !mentions(a))), null, 2) + "\n";
  for (const mod of mods) if (existsSync(join(data, "db", `${mod}.sqlite`))) files[`state/db/${mod}.sql`] = dumpDb(join(data, "db", `${mod}.sqlite`), mentions);
  if (existsSync(join(data, "cover.jpg"))) files["cover.jpg"] = readFileSync(join(data, "cover.jpg"));

  const secrets = [config.hostKey, config.invite, ...Object.keys(keys), ...Object.entries(process.env).flatMap(([k, v]) => (v && v.length >= 8 && /KEY|TOKEN|SECRET|PASS|AUTH|CREDENTIAL/i.test(k) ? [v] : []))];
  const extra = process.env.SANDBOX_SECRETS && readJson(process.env.SANDBOX_SECRETS);
  if (extra) secrets.push(...(JSON.stringify(extra).match(/"[^"]{12,}"/g) ?? []).map((s) => s.slice(1, -1)));
  for (const [path, content] of Object.entries(files)) {
    const text = typeof content === "string" ? content : Buffer.from(content).toString("latin1");
    if (KEY_SHAPES.test(text) || secrets.some((s) => s && text.includes(s)))
      throw new Error(`Nothing was published: ${path} contains what looks like a key or password. Take it out of that file, then publish again.`);
  }
  return files;
}

const SAFE_PATH = /^(mods\/[a-z][a-z0-9-]{0,31}\/([\w.@ -]+\/)*[\w.@ -]+|state\/(entities|about)\.json|state\/games\/[a-z][a-z0-9-]{0,31}\/entities\.json|games\.json|state\/db\/[a-z][a-z0-9-]{0,31}\.sql|world\.json|cover\.jpg|package\.json|bun\.lock)$/;
const MAX_BYTES = 200 << 20;

/** A world's files from a GitHub tarball, without the folder GitHub wraps them in. */
export async function readTarball(bytes: Uint8Array) {
  const files = new Map<string, File>();
  let total = 0;
  for (const [path, file] of await new Bun.Archive(bytes).files()) {
    const inner = path.split("/").slice(1).join("/");
    if (!SAFE_PATH.test(inner) || inner.split("/").some((part) => part.startsWith("."))) continue;
    if ((total += file.size) > MAX_BYTES) throw new Error("That world is over 200 MB.");
    files.set(inner, file);
  }
  return files;
}

/** Makes a world folder from published files; the server builds its mods the first time it starts. */
export async function importWorld(files: Map<string, Blob>, dir: string, fresh: () => string) {
  const manifest: Partial<Manifest> = await files.get("world.json")?.json().catch(() => null);
  if (!manifest?.name) throw new Error("That isn't a Sandbox world: it has no world.json.");
  const author = HANDLE.test(manifest.author ?? "") ? manifest.author! : "world";
  const config: Config = {
    name: String(manifest.name).slice(0, 40),
    rules: manifest.rules === "additive" ? "additive" : "open",
    start: ["hills", "blank"].includes(manifest.start!) ? manifest.start! : "basics",
    invite: fresh(),
    hostKey: fresh(),
  };
  mkdirSync(join(dir, "world/mods"), { recursive: true });
  mkdirSync(join(dir, "db"), { recursive: true });
  const owners: Record<string, string> = {};
  for (const [path, file] of files) {
    if (path.startsWith("mods/")) owners[path.split("/")[1]!] = author;
    if (path.startsWith("mods/") || path === "package.json" || path === "bun.lock") {
      mkdirSync(join(dir, "world", path, ".."), { recursive: true });
      writeFileSync(join(dir, "world", path), await file.bytes());
    }
  }
  for (const [path, file] of files) {
    const mod = path.match(/^state\/db\/(.+)\.sql$/)?.[1];
    if (!mod) continue;
    const db = new Database(join(dir, "db", `${mod}.sqlite`), { create: true });
    const sql = await file.text();
    db.transaction(() => db.exec(sql))();
    db.close();
  }
  const state = await files.get("state/entities.json")?.json();
  if (state) seedStore(join(dir, "world.sqlite"), Number(state.nextId) || 1, state.entities ?? {});
  const games = cards((await files.get("games.json")?.json().catch(() => null)) ?? {}, author);
  if (Object.keys(games).length) writeFileSync(join(dir, "games.json"), JSON.stringify(games, null, 2));
  for (const id of Object.keys(games)) {
    const save = await files.get(`state/games/${id}/entities.json`)?.json();
    if (!save) continue;
    mkdirSync(join(dir, "games", id), { recursive: true });
    seedStore(join(dir, "games", id, "world.sqlite"), Number(save.nextId) || 1, save.entities ?? {});
  }
  const cover = files.get("cover.jpg");
  if (cover) writeFileSync(join(dir, "cover.jpg"), await cover.bytes());
  writeFileSync(join(dir, "about.json"), (await files.get("state/about.json")?.text()) ?? "{}");
  writeFileSync(join(dir, "owners.json"), JSON.stringify(owners, null, 2));
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  if (files.has("package.json")) {
    const proc = Bun.spawn([process.execPath, "install"], { cwd: join(dir, "world"), stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_BE_BUN: "1" } });
    if (await proc.exited) throw new Error(`Couldn't install the packages this world uses:\n${(await new Response(proc.stderr).text()).trim().slice(-500)}`);
  }
  return config;
}
