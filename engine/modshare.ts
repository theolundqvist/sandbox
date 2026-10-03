// Community mods on the engine's side: a mod's folder packed for Community with its README and API, and the world tools that search, read and add mods others published.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { install as installPackage } from "./box/packages";

export const COMMUNITY = process.env.SANDBOX_COMMUNITY ?? "https://sandbox.api.lundqvistliss.com";
const MOD_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ID = /^[a-z0-9]{12}$/;
/** Where a mod came from in Community, inside its folder; publishing reads it to update the mod or fork it. */
export const ORIGIN = "community.json";
const SKIP = /(^|\/)(node_modules|\.git)(\/|$)/;
const MAX_BYTES = 20 << 20;
/** Packages the engine provides to every mod; a mod importing them needs nothing installed. */
const BUILT_IN = new Set(["three"]);

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** A mod folder's files by path inside it: code and assets, never node_modules, git or where it came from. */
function filesOf(dir: string) {
  const files: Record<string, Uint8Array> = {};
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (SKIP.test(child) || child === ORIGIN) continue;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files[child] = readFileSync(join(dir, child));
    }
  };
  walk("");
  return files;
}

const withoutDoc = (text: string) => (text.trimEnd().endsWith("*/") ? text.slice(0, text.lastIndexOf("/*")) : text);

/** Each exported function of a mod file, as its head without the body, with the doc comment above it: top-level exports and the members of its default export's `exports`. */
export function apiOf(code: string) {
  const out: string[] = [];
  let doc = "";
  let depth = 0;
  let exportsDepth = -1;
  let head: { at: number; doc: string } | null = null;
  let parens = 0;
  const flush = (end: number) => {
    if (!head) return;
    const text = code.slice(head.at, end).replace(/\s+/g, " ").replace(/\s*(=>|=)?\s*(function\b)?\s*$/, "").trim();
    if (text) out.push(`${head.doc ? `${head.doc}\n` : ""}${text}`);
    head = null;
  };
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (c === "/" && code[i + 1] === "/") {
      i = code.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      if (code[i + 2] === "*") doc = code.slice(i, end + 2).replace(/\n\s*/g, "\n ");
      i = end < 0 ? code.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < code.length && code[i] !== c; i++) if (code[i] === "\\") i++;
      continue;
    }
    if (c === "(") parens++;
    else if (c === ")") parens--;
    else if (c === "{") {
      if (head && !parens && !/^export\s+(type|interface)\b/.test(code.slice(head.at, head.at + 20))) flush(i);
      if (exportsDepth < 0 && /\bexports\s*:\s*$/.test(code.slice(Math.max(0, i - 40), i))) exportsDepth = depth + 1;
      depth++;
      doc = "";
      continue;
    } else if (c === "}") {
      depth--;
      if (depth < exportsDepth) exportsDepth = -1;
      continue;
    }
    if (head && !parens && (c === ";" || c === "\n") && depth === 0) flush(i);
    if (head && depth === exportsDepth && !parens && c === ",") flush(i);
    if (head || parens || !/[A-Za-z_$]/.test(c) || /[\w$.]/.test(code[i - 1] ?? "")) continue;
    if (depth === 0 && code.startsWith("export ", i) && !code.startsWith("export default", i) && !/^export\s+(const|let)\s+owns\b/.test(code.slice(i, i + 30))) head = { at: i, doc };
    else if (depth === exportsDepth && /^(async\s+)?[\w$]+\s*(\(|:\s*(async\s*)?(\(|function))/.test(code.slice(i, i + 80)) && /[{,]\s*$/.test(withoutDoc(code.slice(0, i)))) head = { at: i, doc };
    doc = "";
  }
  return out;
}

/** What a mod imports: npm packages (by name) and the other mods it reaches through use() or ../<mod>/ paths. */
function importsOf(name: string, files: Record<string, Uint8Array>) {
  const packages = new Set<string>();
  const needs = new Set<string>();
  for (const [path, bytes] of Object.entries(files)) {
    if (!/\.tsx?$/.test(path)) continue;
    const code = new TextDecoder().decode(bytes);
    for (const { path: spec } of transpiler.scan(code).imports) {
      const other = spec.match(/^\.\.\/([a-z][a-z0-9-]{0,31})\//)?.[1];
      if (other) needs.add(other);
      else if (!/^[./]|^(bun|node):/.test(spec)) packages.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
    }
    for (const m of code.matchAll(/\buse(?:<[^>]*>)?\(\s*["'`]([a-z][a-z0-9-]{0,31})["'`]/g)) needs.add(m[1]!);
  }
  needs.delete(name);
  for (const p of BUILT_IN) packages.delete(p);
  return { packages: [...packages].sort(), needs: [...needs].sort() };
}

/** A mod's folder as Community gets it: its code and assets with the world's secrets taken out, its README (README.md, else the first doc comment), the API it exports, and what it imports. Nothing outside the folder goes: no record, chat, databases or players. */
export function packMod(root: string, name: string, secrets: string[]) {
  if (!MOD_NAME.test(name)) throw new Error("That isn't a mod.");
  const dir = join(root, "mods", name);
  if (!existsSync(dir)) throw new Error(`There is no mod ${name} in this world.`);
  const files = filesOf(dir);
  const live = secrets.filter((s) => s && s.length >= 6);
  for (const [path, bytes] of Object.entries(files)) {
    const text = Buffer.from(bytes).toString("latin1");
    if (live.some((s) => text.includes(s))) files[path] = Buffer.from(live.reduce((t, s) => t.replaceAll(s, "[secret]"), text), "latin1");
  }
  const size = Object.values(files).reduce((n, f) => n + f.length, 0);
  if (size > MAX_BYTES) throw new Error(`${name} is ${Math.round(size / (1 << 20))} MB; a Community mod is 20 MB at most.`);
  const read = (path: string) => (files[path] ? new TextDecoder().decode(files[path]) : "");
  const code = Object.keys(files).filter((p) => /\.tsx?$/.test(p)).sort((a, b) => ["server.ts", "client.ts"].indexOf(b) - ["server.ts", "client.ts"].indexOf(a) || a.localeCompare(b));
  const firstDoc = code.map((p) => read(p).match(/^\s*(?:import[^\n]*\n\s*)*\/\*\*([\s\S]*?)\*\//)?.[1]).find(Boolean);
  const readme = read("README.md") || (firstDoc ?? "").replace(/^\s*\* ?/gm, "").trim();
  const reached = (p: string) => (p === "server.ts" ? `world.use("${name}")` : p === "client.ts" ? `ctx.use("${name}")` : "");
  const api = code
    .map((p) => [p, apiOf(read(p))] as const)
    .filter(([, list]) => list.length)
    .map(([p, list]) => `// ${p}${reached(p) ? `, reached with ${reached(p)}` : ""}\n${list.join("\n")}`)
    .join("\n\n");
  const { packages, needs } = importsOf(name, files);
  const deps: Record<string, string> = JSON.parse(existsSync(join(root, "package.json")) ? readFileSync(join(root, "package.json"), "utf8") : "{}").dependencies ?? {};
  return { zip: zipSync(files), readme, api, packages: Object.fromEntries(packages.filter((p) => deps[p]).map((p) => [p, deps[p]!])), needs };
}

/** A Community mod's zip into mods/<name>/, which must not exist yet; only files inside that folder, and no zip bomb. */
export function unpackMod(zip: Uint8Array, root: string, name: string) {
  const into = join(root, "mods", name);
  let total = 0;
  const unzip = (filter: (f: { originalSize: number }) => boolean) => {
    try {
      return unzipSync(zip, { filter });
    } catch {
      throw new Error("That mod's download is damaged.");
    }
  };
  unzip((f) => ((total += f.originalSize), false));
  if (total > 4 * MAX_BYTES) throw new Error("That mod is too big.");
  const files = unzip(() => true);
  for (const path of Object.keys(files)) {
    const parts = path.replace(/\/$/, "").split("/");
    if (!parts.every((p) => p && p !== "." && p !== ".." && !/[\\:\0]/.test(p)) || !resolve(into, path).startsWith(into + sep) || SKIP.test(path)) throw new Error("That mod's download has files outside its folder.");
  }
  for (const [path, data] of Object.entries(files)) {
    if (path.endsWith("/")) continue;
    mkdirSync(dirname(join(into, path)), { recursive: true });
    writeFileSync(join(into, path), data);
  }
  mkdirSync(into, { recursive: true });
  return Object.keys(files).filter((p) => !p.endsWith("/")).sort();
}

/** Community's API from a world: public reads, and counting a use with this computer's install token when it has one. */
export function communityClient(secretsPath: string | undefined, worldKey: () => string | undefined) {
  const install = (): string | null => {
    const secrets = secretsPath && existsSync(secretsPath) ? JSON.parse(readFileSync(secretsPath, "utf8")) : {};
    return secrets.install?.host === COMMUNITY ? secrets.install.token : null;
  };
  async function get(path: string) {
    const res = await fetch(`${COMMUNITY}${path}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res) throw new Error("Can't reach Community right now. Try again in a minute.");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(res.status === 404 ? "There is no such mod in Community." : res.status === 410 ? "That mod was taken down." : (data.error ?? `Community answered ${res.status}.`));
    return data;
  }
  const modId = (id: unknown) => {
    const found = String(id ?? "").match(/(?:^|\/m\/)([a-z0-9]{12})\/?$/)?.[1];
    if (!found) throw new Error("id is a mod's 12-character id from search_mods, or its link.");
    return found;
  };
  return {
    async search(q: string, sort: string) {
      const list: any[] = await get(`/mods?q=${encodeURIComponent(q.slice(0, 100))}&sort=${sort === "new" ? "new" : "top"}`);
      if (!list.length) return q ? `No Community mod matches "${q}". Build it yourself, and once it works your player can share it from the game: Tab, Mods, Share.` : "No Community mods yet.";
      const rows = list.slice(0, 20).map((m) => `${m.id}  ${m.name}${m.title && m.title !== m.name ? ` · ${m.title}` : ""}, by ${m.author}, ${m.uses} ${m.uses === 1 ? "world uses" : "worlds use"} it, ${m.votes} upvotes\n    ${m.description || "(no description)"}\n    preview: ${m.cover}`);
      return `${rows.join("\n")}\n\nread_mod id=<id> shows a mod's README and API; add_mod id=<id> installs it here.`;
    },
    async read(id: unknown) {
      const m = await get(`/mods/${modId(id)}`);
      const parent = m.parent?.id ? `Forked from ${m.parent.title} (${m.parent.id}) by ${m.parent.author}.\n` : "";
      const packages = Object.entries(m.packages ?? {}).map(([k, v]) => `${k}@${v}`);
      return [
        `${m.title} (mods/${m.name}/) by ${m.builders.join(", ")}: ${m.uses} ${m.uses === 1 ? "world uses" : "worlds use"} it, ${m.votes} upvotes, ${m.forks} forks. ${m.link}\n${parent}${m.description}`,
        `Needs: ${m.needs.length ? `the mods ${m.needs.join(", ")} (add_mod adds only this one; search for the others or check status)` : "no other mods"}. Packages: ${packages.length ? `${packages.join(", ")} (add_mod installs them)` : "none"}.`,
        `README:\n${m.readme || "(none)"}`,
        `API:\n${m.api || "(no exports)"}`,
      ].join("\n\n");
    },
    /** Downloads a mod into this world's tree and counts the use; reloading it is the caller's. */
    async add(id: unknown, as: unknown, root: string) {
      const m = await get(`/mods/${modId(id)}`);
      const name = as === undefined || as === "" ? m.name : String(as);
      if (!MOD_NAME.test(name)) throw new Error("as is a mod folder name: lowercase letters, digits and dashes.");
      if (existsSync(join(root, "mods", name))) throw new Error(`mods/${name}/ already exists here. Pass as=<another name> to add it beside, or read_mod and extend the one you have.`);
      const res = await fetch(m.zip, { signal: AbortSignal.timeout(120_000) }).catch(() => null);
      if (!res?.ok) throw new Error("Couldn't download that mod. Try again.");
      const packages = Object.entries(m.packages ?? {}).map(([k, v]) => `${k}@${v}`);
      for (const spec of packages) await installPackage(root, spec);
      const files = unpackMod(await res.bytes(), root, name);
      writeFileSync(join(root, "mods", name, ORIGIN), `${JSON.stringify({ id: m.id, name: m.name, title: m.title, author: m.author, link: m.link, added: new Date().toISOString() }, null, 2)}\n`);
      const token = install();
      const key = worldKey();
      if (token && key)
        await fetch(`${COMMUNITY}/mods/${m.id}/uses`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ world: key }), signal: AbortSignal.timeout(10_000) }).catch(() => null);
      return { mod: m, name, files, packages };
    },
  };
}

