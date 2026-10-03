// The npm packages a world's mods import. A world may be a stranger's, so installing never runs a package's code on the host, and nothing in the world steers it:
// - package.json is cut down to npm registry dependencies by plain semver range or dist-tag, and a bun.lock to plain registry entries, which only pin versions;
// - the host only fetches: it picks versions from the registry's metadata the way bun does, and downloads each tarball from the registry by name and version, checking its sha512;
// - unpacking and `bun install --ignore-scripts` run in the mod sandbox, without network, from those tarballs, and only plain files and folders come out of them.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { record } from "./broker";
import { runBoxed } from "./build";
import { boxRefusal } from "./index";

export const REGISTRY = "https://registry.npmjs.org/";
const EXTRACT = join(import.meta.dir, "extract.ts");
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/** A semver range or a dist-tag; nothing that names a git repo, a URL, a path, another package's name or a workspace. Bun reads a spec starting with "." as a folder, and one ending in .tgz or .tar.gz as a tarball. */
const RANGE = /^(?!\.)(?!.*\.t(?:gz|ar\.gz)$)[\w.^~<>=*|+ -]{1,64}$/i;
/** Registry semver, prereleases and builds included; numbers as bun prints them, so a cache folder's name matches. */
const VERSION = /^(?:0|[1-9]\d{0,15})\.(?:0|[1-9]\d{0,15})\.(?:0|[1-9]\d{0,15})(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
const METADATA_BYTES = 64 << 20;
const TARBALL_BYTES = 256 << 20;
const TOTAL_BYTES = 1 << 30;
const MAX_PACKAGES = 5000;
/** Packages that need each other in alternating versions nest without end, and bun itself never finishes them. */
const MAX_DEPTH = 32;
const STEP_MS = 300_000;

type Deps = Record<string, string>;
export type Manifest = { private: true; dependencies?: Deps };
/** What bun.lock records of a package beside its version: what it depends on, which of its peers are optional, and the platforms it runs on, which bun checks before installing it. */
type Info = { dependencies?: Deps; optionalDependencies?: Deps; peerDependencies?: Deps; optionalPeers?: string[]; os?: string[]; cpu?: string[] };
export type Entry = { name: string; version: string; info: Info; integrity: string };
type Version = { dependencies?: unknown; optionalDependencies?: unknown; peerDependencies?: unknown; peerDependenciesMeta?: unknown; bundleDependencies?: unknown; bundledDependencies?: unknown; os?: unknown; cpu?: unknown; dist?: { integrity?: unknown } };
export type Packument = { "dist-tags"?: Record<string, unknown>; versions?: Record<string, Version> };
/** Everything an install needs from the network, fetched and checked by the host. */
export type Prepared = { manifest: Manifest; lock: string; tarballs: { entry: Entry; path: string }[]; summary: string };

const validName = (name: string) => name.length <= 214 && NAME.test(name);
const fits = (version: string, range: string) => Bun.semver.satisfies(version, range);

/** A version's prerelease and build tags as bun 1.4 parses them; a "-" in a build starts a prerelease there, so "1.0.0+b-1" is prerelease "1". */
function tagOf(version: string) {
  const tag = version.slice(Math.max(0, version.search(/[-+]/)));
  let [state, start, pre, build] = ["", 0, "", ""];
  if (!/^[-+]/.test(tag)) return { pre, build };
  for (let i = 0; i < tag.length; i++) {
    if (tag[i] === "+") {
      if (state === "pre") pre = tag.slice(start, i);
      if (state !== "build") [state, start] = ["build", i + 1];
    } else if (tag[i] === "-" && state !== "pre") [state, start] = ["pre", i + 1];
  }
  if (state === "pre") pre = tag.slice(start);
  else build = tag.slice(start);
  return { pre, build };
}

const WYHASH_PRIMES = [0xa0761d6478bd642fn, 0xe7037ed1a0b428dbn, 0x8ebc6af09c88c6e3n, 0x589965cc75374cc3n, 0x1d8e4e27c47d124fn] as const;
/** The 64-bit "Wyhash11" bun hashes version tags with (zig std wyhash v0.11.0-dev.2609, seed 0). */
function wyhash11(text: string) {
  const bytes = new TextEncoder().encode(text);
  const P = WYHASH_PRIMES;
  const mum = (a: bigint, b: bigint) => {
    const r = a * b;
    return ((r >> 64n) ^ r) & 0xffffffffffffffffn;
  };
  const mix0 = (a: bigint, b: bigint, seed: bigint) => mum(a ^ seed ^ P[0], b ^ seed ^ P[1]);
  const mix1 = (a: bigint, b: bigint, seed: bigint) => mum(a ^ seed ^ P[2], b ^ seed ^ P[3]);
  const read = (at: number, length: number) => {
    let value = 0n;
    for (let i = length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[at + i]!);
    return value;
  };
  // The last bytes go in as little-endian pieces of 4, 2 and 1 bytes, earlier pieces higher.
  const tail = (at: number, length: number) => {
    let value = 0n;
    while (length) {
      const size = length >= 4 ? 4 : length >= 2 ? 2 : 1;
      value = (value << BigInt(size * 8)) | read(at, size);
      at += size;
      length -= size;
    }
    return value;
  };
  let seed = 0n;
  const end = bytes.length - (bytes.length % 32);
  for (let at = 0; at < end; at += 32) seed = mix0(read(at, 8), read(at + 8, 8), seed) ^ mix1(read(at + 16, 8), read(at + 24, 8), seed);
  const rest = bytes.length - end;
  if (rest > 24) seed = mix0(tail(end, 8), tail(end + 8, 8), seed) ^ mix1(tail(end + 16, 8), tail(end + 24, rest - 24), seed);
  else if (rest > 16) seed = mix0(tail(end, 8), tail(end + 8, 8), seed) ^ mix1(tail(end + 16, rest - 16), P[4], seed);
  else if (rest > 8) seed = mix0(tail(end, 8), tail(end + 8, rest - 8), seed);
  else if (rest) seed = mix0(tail(end, rest), P[4], seed);
  return mum(seed ^ BigInt(bytes.length), P[4]);
}

/** The folder bun 1.4 looks for a package from registry.npmjs.org in, inside its cache: "name@1.2.3@@@1", a prerelease as "-" and a build as "+" followed by its tag's hash in hex. Another registry would add "@@" and its host before "@@@1". */
function cacheFolder(name: string, version: string) {
  const { pre, build } = tagOf(version);
  const hex = (tag: string) => wyhash11(tag).toString(16).padStart(16, "0");
  return `${name}@${version.match(/^\d+\.\d+\.\d+/)![0]}${pre ? `-${hex(pre)}` : ""}${build ? `+${hex(build).toUpperCase()}` : ""}@@@1`;
}

/** A package.json cut down to its npm registry dependencies, and the names it left out. */
export function sanitizeManifest(value: unknown): { manifest: Manifest; dropped: string[] } {
  const dependencies: Deps = {};
  const dropped: string[] = [];
  const deps = record(record(value)?.dependencies);
  if (deps)
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range === "string" && validName(name) && RANGE.test(range)) dependencies[name] = range;
      else dropped.push(name);
    }
  return { manifest: Object.keys(dependencies).length ? { private: true, dependencies } : { private: true }, dropped };
}

/** The names along a bun.lock key, "a/@scope/b" being b inside a; null for anything else. */
function keyNames(key: string) {
  const names: string[] = [];
  const parts = key.split("/");
  for (let i = 0; i < parts.length; i++) names.push(parts[i]!.startsWith("@") ? `${parts[i]}/${parts[++i] ?? ""}` : parts[i]!);
  return names.every(validName) ? names : null;
}

/** Dependencies as a registry has them; the ones that aren't plain registry versions throw, or for optional ones are left out. */
function registryDeps(value: unknown, id: string, optional: boolean): Deps {
  const deps: Deps = {};
  if (value === undefined) return deps;
  const listed = record(value);
  if (!listed) throw new Error(`${id} lists its dependencies in a form this engine can't read.`);
  for (const [name, range] of Object.entries(listed)) {
    if (typeof range === "string" && validName(name) && RANGE.test(range)) deps[name] = range;
    else if (!optional) throw new Error(`${id} depends on ${name} from ${JSON.stringify(range)}, which isn't a plain npm registry version, so it can't be installed here.`);
  }
  return deps;
}

/** An os or cpu field's values the way bun reads them: one string or a list of them; anything else limits nothing. */
function platformList(value: unknown) {
  return (typeof value === "string" ? [value] : Array.isArray(value) ? value : []).filter((x): x is string => typeof x === "string" && x !== "");
}

/**
 * What bun.lock keeps of a registry version: its registry dependencies, optional ones, peers and platforms. Throws for what this engine can't install.
 * As in bun, a name optionalDependencies lists is optional even when dependencies lists it too, and a peer the package also depends on is no peer.
 */
function infoOf(v: Version, id: string): Info {
  const bundled = v.bundleDependencies ?? v.bundledDependencies;
  if (bundled === true || (Array.isArray(bundled) && bundled.length)) throw new Error(`${id} carries its own copies of other packages, which this engine doesn't install.`);
  const optionalDependencies = registryDeps(v.optionalDependencies, id, true);
  const optionalNames = record(v.optionalDependencies) ?? {};
  const listed = record(v.dependencies);
  const dependencies = registryDeps(listed ? Object.fromEntries(Object.entries(listed).filter(([name]) => !Object.hasOwn(optionalNames, name))) : v.dependencies, id, false);
  const meta = record(v.peerDependenciesMeta) ?? {};
  const optionalPeers = Object.keys(meta).filter((name) => record(meta[name])?.optional === true);
  const peers = Object.entries(record(v.peerDependencies) ?? {}).filter(([name]) => !Object.hasOwn(listed ?? {}, name) && !Object.hasOwn(optionalNames, name));
  const peerDependencies = {
    ...registryDeps(Object.fromEntries(peers.filter(([name]) => optionalPeers.includes(name))), id, true),
    ...registryDeps(Object.fromEntries(peers.filter(([name]) => !optionalPeers.includes(name))), `${id} (as a peer)`, false),
  };
  const info: Info = {};
  if (Object.keys(dependencies).length) info.dependencies = dependencies;
  if (Object.keys(optionalDependencies).length) info.optionalDependencies = optionalDependencies;
  if (Object.keys(peerDependencies).length) info.peerDependencies = peerDependencies;
  const usedOptionalPeers = optionalPeers.filter((name) => Object.hasOwn(peerDependencies, name));
  if (usedOptionalPeers.length) info.optionalPeers = usedOptionalPeers;
  const [os, cpu] = [platformList(v.os), platformList(v.cpu)];
  if (os.length) info.os = os;
  if (cpu.length) info.cpu = cpu;
  return info;
}

/**
 * The plain registry entries of a bun.lock by their key, its place in node_modules ("a", "a/b"). Anything else in it is ignored: entries only pin versions.
 * Bun 1.4 writes lockfileVersion 2 (1's entries, parsed more strictly) or 3 (2 plus scoped overrides, which are dropped here like all overrides); a pin is kept only while it fits its range, and its tarball must match its sha512.
 */
export function readPins(text: string) {
  const pins = new Map<string, Entry>();
  let lock: unknown;
  try {
    lock = Bun.JSONC.parse(text);
  } catch {
    return pins;
  }
  const doc = record(lock);
  const packages = ([1, 2, 3].includes(doc?.lockfileVersion as number) && record(doc?.packages)) || {};
  for (const [key, value] of Object.entries(packages)) {
    if (!Array.isArray(value) || value.length !== 4 || value[1] !== "" || typeof value[0] !== "string" || typeof value[3] !== "string") continue;
    const info = record(value[2]);
    if (!info) continue;
    const at = value[0].lastIndexOf("@");
    const [name, version] = [value[0].slice(0, at), value[0].slice(at + 1)];
    if (at <= 0 || keyNames(key)?.at(-1) !== name || !VERSION.test(version) || !SHA512.test(value[3])) continue;
    if (info.bundled !== undefined) continue;
    try {
      const clean = infoOf(
        {
          dependencies: info.dependencies,
          optionalDependencies: info.optionalDependencies,
          peerDependencies: info.peerDependencies,
          peerDependenciesMeta: Object.fromEntries((Array.isArray(info.optionalPeers) ? info.optionalPeers : []).filter((n) => typeof n === "string").map((n) => [n, { optional: true }])),
          os: info.os,
          cpu: info.cpu,
        },
        value[0],
      );
      pins.set(key, { name, version, info: clean, integrity: value[3] });
    } catch {
      // A pin that names something this engine can't install pins nothing.
    }
  }
  return pins;
}

/** A bun.lock that bun installs exactly, from offline packages alone. */
export function lockText(deps: Deps, placed: Map<string, Entry>) {
  const packages = Object.fromEntries([...placed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, e]) => [key, [`${e.name}@${e.version}`, "", e.info, e.integrity]]));
  return `${JSON.stringify({ lockfileVersion: 1, configVersion: 1, workspaces: { "": { dependencies: deps } }, packages }, null, 2)}\n`;
}

/** An imported bun.lock with only its plain registry entries, for this manifest; null when nothing in it pins anything. */
export function sanitizeLock(text: string, manifest: Manifest) {
  const pins = readPins(text);
  return pins.size ? lockText(manifest.dependencies ?? {}, pins) : null;
}

async function download(url: string, limit: number, accept?: string) {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "error", headers: accept ? { accept } : undefined, signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    throw new Error(`Couldn't reach the npm registry (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (!response.ok || !response.body) throw new Error(`The npm registry answered ${response.status} for ${url}.`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    if ((size += chunk.length) > limit) throw new Error(`${url} is over ${limit >> 20} MB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** A package's metadata from the registry, in the short form installers read. */
export async function fetchPackument(name: string): Promise<Packument> {
  const bytes = await download(`${REGISTRY}${name.replace("/", "%2f")}`, METADATA_BYTES, "application/vnd.npm.install-v1+json");
  const doc: unknown = JSON.parse(bytes.toString("utf8"));
  if (!record(record(doc)?.versions)) throw new Error(`The npm registry has no versions of ${name}.`);
  return doc as Packument;
}

/**
 * The version bun 1.4 picks for a range: a dist-tag's; an exact version as it is; else latest when it fits, though a range naming a prerelease takes latest only when it is the range's own first version;
 * else the highest release that fits, else the highest prerelease that does.
 */
function pick(doc: Packument, range: string) {
  const versions = Object.keys(doc.versions ?? {}).filter((v) => VERSION.test(v));
  const tagged = doc["dist-tags"]?.[range];
  if (typeof tagged === "string") return versions.includes(tagged) ? tagged : undefined;
  // The range's first comparator: an operator and a version, whose missing or wildcard parts count as 0. A whole plain version that doesn't start "a - b" is exact.
  const first = /^\s*(~>|[<>]=?|[~^]|=?v?)\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?([-+][0-9A-Za-z.+-]*)?(\s+-\s)?/.exec(range);
  const parts = first ? [first[2], first[3], first[4]] : [];
  const whole = parts.every((n) => n !== undefined && /^\d+$/.test(n));
  const left = first && `${parts.map((n) => (n && /^\d+$/.test(n) ? n : "0")).join(".")}${whole ? (first[5] ?? "") : ""}`;
  if (first && whole && /^=?v?$/.test(first[1]!) && !first[6]) return versions.find((v) => Bun.semver.order(v, left!) === 0);
  const prerelease = [...range.matchAll(/\d+(?:\.(?:\d+|[xX*])){1,2}([-+][0-9A-Za-z.+-]*)/g)].some((m) => tagOf(m[1]!).pre);
  const latest = doc["dist-tags"]?.latest;
  if (typeof latest === "string" && versions.includes(latest) && fits(latest, range) && (!prerelease || (left !== null && Bun.semver.order(left, latest) === 0))) return latest;
  const fitting = versions.filter((v) => fits(v, range)).sort(Bun.semver.order);
  return fitting.filter((v) => !tagOf(v).pre).at(-1) ?? fitting.at(-1);
}

const OS_NAMES = ["aix", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32", "android"];
const CPU_NAMES = ["arm", "arm64", "ia32", "mips", "mipsel", "ppc", "ppc64", "s390", "s390x", "x32", "x64"];

/** Whether an os or cpu list lets a package install here, as bun decides: "!x" excludes x, "any" allows all, exclusions alone allow the rest, and unknown names alone allow none. */
function allows(list: string[] = [], here: string, known: string[]) {
  const added = list.includes("any") ? known : list.filter((x) => known.includes(x));
  const removed = list.flatMap((x) => (x.startsWith("!") && known.includes(x.slice(1)) ? [x.slice(1)] : []));
  if (removed.includes(here)) return false;
  if (added.length) return added.includes(here);
  return removed.length > 0 || !list.some((x) => !x.startsWith("!"));
}

type Want = { parent: string[]; name: string; range: string; optional: boolean; peer: boolean; by: string };

/**
 * The packages to install and where each goes in node_modules, as bun.lock keys. Breadth first, like node_modules is laid out: a package goes to the top unless another version is already visible to whoever needs it, then inside that one.
 * A version already visible is reused only when it satisfies the range. Pins keep their versions while those still fit; optional packages that can't install here (other platforms, no fitting version, unsupported sources) are left out, as bun leaves them out.
 * A required package for another platform stays, with its platforms, and bun skips installing it. A peer whose package sees another version gets that one, with a note, as bun never nests a peer.
 */
export async function resolve(deps: Deps, pins: Map<string, Entry>, notes: string[], packument: (name: string) => Promise<Packument> = fetchPackument) {
  const placed = new Map<string, Entry>();
  const docs = new Map<string, Promise<Packument>>();
  const doc = (name: string) => {
    let found = docs.get(name);
    if (!found) docs.set(name, (found = packument(name)));
    return found;
  };
  const pinned = new Set([...pins.values()].map((p) => p.name));
  const key = (path: string[]) => path.join("/");

  async function place({ parent, name, range, optional, peer, by }: Want) {
    let conflict = false;
    let entry: Entry;
    for (let depth = parent.length; depth >= 0; depth--) {
      const seen = placed.get(key([...parent.slice(0, depth), name]));
      if (!seen) continue;
      if (fits(seen.version, range)) return null;
      if (depth === parent.length) throw new Error(`${by} needs ${name} both as ${seen.version} and as ${range}.`);
      // bun never puts a peer inside the package that wants it: the package gets the version it sees.
      if (peer) {
        notes.push(`${by} wants ${name} ${range} as a peer, but gets the ${name}@${seen.version} already installed.`);
        return null;
      }
      conflict = true;
      break;
    }
    // The version the lock gave whoever needs it, while it still fits.
    let pin: Entry | undefined;
    for (let depth = parent.length; depth >= 0 && !pin; depth--) pin = pins.get(key([...parent.slice(0, depth), name]));
    const keep = pin && fits(pin.version, range) ? pin : undefined;
    // An optional package may be for another platform, which only the registry's metadata says.
    if (keep && !optional) entry = { ...keep };
    else {
      try {
        const metadata = await doc(name);
        const version = keep?.version ?? pick(metadata, range);
        if (!version) throw new Error(`No version of ${name} fits ${JSON.stringify(range)}, which ${by} needs.`);
        const id = `${name}@${version}`;
        const v = metadata.versions?.[version];
        if (!v) throw new Error(`${id}, which ${by} needs, is no longer on the npm registry.`);
        const integrity = v.dist?.integrity;
        if (typeof integrity !== "string" || !SHA512.test(integrity)) throw new Error(`${id} has no sha512 checksum on the npm registry, so it can't be checked.`);
        if (keep && keep.integrity !== integrity) throw new Error(`The lockfile's checksum for ${id} isn't the npm registry's.`);
        entry = { name, version, info: infoOf(v, id), integrity };
        if (optional && !(allows(entry.info.os, process.platform, OS_NAMES) && allows(entry.info.cpu, process.arch, CPU_NAMES))) return null;
        if (pin && !keep && !parent.length) notes.push(`${name} was ${pin.version} in the lockfile, which doesn't fit ${range}, so ${version} is installed.`);
      } catch (e) {
        if (optional) return null;
        throw e;
      }
    }
    const at = conflict ? [...parent, name] : [name];
    if (at.length > MAX_DEPTH) throw new Error(`${by} needs ${name} ${MAX_DEPTH} folders deep in node_modules, as packages that need each other in alternating versions do, so these can't be installed.`);
    placed.set(key(at), entry);
    if (placed.size > MAX_PACKAGES) throw new Error(`These packages need over ${MAX_PACKAGES} others.`);
    return { at, entry };
  }

  let level: Want[] = Object.entries(deps).map(([name, range]) => ({ parent: [], name, range, optional: false, peer: false, by: "package.json" }));
  while (level.length) {
    // Metadata comes in parallel; placing stays in order, since each place depends on the ones before.
    for (const want of level) if (want.optional || !pinned.has(want.name)) doc(want.name).catch(() => {});
    const next: Want[] = [];
    for (const want of level) {
      const done = await place(want);
      if (!done) continue;
      const { at, entry } = done;
      const id = `${entry.name}@${entry.version}`;
      for (const [name, range] of Object.entries(entry.info.dependencies ?? {})) next.push({ parent: at, name, range, optional: false, peer: false, by: id });
      for (const [name, range] of Object.entries(entry.info.optionalDependencies ?? {})) next.push({ parent: at, name, range, optional: true, peer: false, by: id });
      // bun installs a package's peers along with it.
      for (const [name, range] of Object.entries(entry.info.peerDependencies ?? {})) if (!entry.info.optionalPeers?.includes(name)) next.push({ parent: at, name, range, optional: false, peer: true, by: id });
    }
    level = next;
  }
  return placed;
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/** "name" or "name@range", as bun add takes it, for registry packages only. */
function parseSpec(spec: string) {
  const at = spec.indexOf("@", 1);
  const name = at < 0 ? spec : spec.slice(0, at);
  const range = at < 0 ? null : spec.slice(at + 1);
  if (!validName(name) || (range !== null && !RANGE.test(range)))
    throw new Error("Give an npm package name, optionally with @ and a version, range or tag, like three or three@^0.160. Packages from git, URLs or files can't be installed.");
  return { name, range };
}

/** Resolves and downloads, on the host, what root's package.json names plus `add`; each tarball comes from the registry by name and version and must match its sha512. */
export async function prepare(root: string, add?: string): Promise<Prepared> {
  const deps: Deps = { ...sanitizeManifest(readJson(join(root, "package.json"))).manifest.dependencies };
  const pins = existsSync(join(root, "bun.lock")) ? readPins(readFileSync(join(root, "bun.lock"), "utf8")) : new Map<string, Entry>();
  const added = add === undefined ? null : parseSpec(add);
  if (added) {
    deps[added.name] = added.range ?? "latest";
    // bun add picks the package afresh.
    pins.delete(added.name);
  }
  const notes: string[] = [];
  const placed = await resolve(deps, pins, notes);
  if (added && !added.range) deps[added.name] = `^${placed.get(added.name)!.version}`;
  const sorted = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => (a < b ? -1 : 1)));
  const manifest: Manifest = Object.keys(sorted).length ? { private: true, dependencies: sorted } : { private: true };

  const store = join(dirname(root), "package-cache");
  mkdirSync(store, { recursive: true });
  const unique = [...new Map([...placed.values()].map((e) => [`${e.name}@${e.version}`, e])).values()];
  let total = 0;
  const tarballs: Prepared["tarballs"] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, unique.length) }, async () => {
      while (next < unique.length) {
        const entry = unique[next++]!;
        const digest = entry.integrity.slice("sha512-".length);
        const path = join(store, `${Buffer.from(digest, "base64").toString("hex")}.tgz`);
        const matches = (bytes: Uint8Array) => new Bun.CryptoHasher("sha512").update(bytes).digest("base64") === digest;
        if (!existsSync(path) || !matches(readFileSync(path))) {
          const bytes = await download(`${REGISTRY}${entry.name}/-/${entry.name.split("/").at(-1)}-${entry.version}.tgz`, TARBALL_BYTES);
          if ((total += bytes.length) > TOTAL_BYTES) throw new Error(`These packages are over ${TOTAL_BYTES >> 30} GB.`);
          if (!matches(bytes)) throw new Error(`${entry.name}@${entry.version} from the npm registry doesn't match its sha512 checksum.`);
          writeFileSync(`${path}.part`, bytes);
          renameSync(`${path}.part`, path);
        }
        tarballs.push({ entry, path });
      }
    }),
  );
  const direct = Object.keys(sorted).flatMap((name) => (placed.has(name) ? [`+ ${name}@${placed.get(name)!.version}`] : []));
  const summary = [...direct, `${placed.size} package${placed.size === 1 ? "" : "s"} installed`, ...notes].join("\n");
  return { manifest, lock: lockText(manifest.dependencies ?? {}, placed), tarballs, summary };
}

/** Every path under dir is a plain folder or a file with no other names, inside dir. */
function plainTree(dir: string) {
  const real = realpathSync(dir) + sep;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (!realpathSync(path).startsWith(real) || !(stat.isDirectory() || (stat.isFile() && stat.nlink === 1))) throw new Error(`The install made ${path}, which isn't a plain file.`);
    if (stat.isDirectory()) plainTree(path);
  }
}

/** Unpacks the prepared tarballs into a Bun cache and runs `bun install --ignore-scripts` from it, both in the sandbox without network, then moves the result into root and writes package.json and bun.lock. Resolves to what was installed. */
export async function installPrepared(root: string, prepared: Prepared) {
  const scratch = mkdtempSync(join(dirname(root), ".install-"));
  try {
    const cache = join(scratch, "cache");
    const project = join(scratch, "project");
    mkdirSync(cache);
    mkdirSync(project);
    const job = join(scratch, "extract.json");
    const packages = prepared.tarballs.map(({ entry, path }) => ({ id: `${entry.name}@${entry.version}`, tgz: path, dir: cacheFolder(entry.name, entry.version) }));
    // bun files "1.0.0-1" and "1.0.0+b-1" in one folder.
    const clash = packages.find((p, i) => packages.findIndex((q) => q.dir === p.dir) !== i);
    if (clash) throw new Error(`${clash.id} shares bun's cache folder with another version of it, so they can't be installed together.`);
    writeFileSync(job, JSON.stringify({ cache, packages }));
    const reads = [EXTRACT, ...new Set(prepared.tarballs.map(({ path }) => dirname(path)))];
    const extracted = await runBoxed({ cmd: [process.execPath, EXTRACT, job], cwd: scratch, scratch, read: reads }, STEP_MS);
    if (extracted.timedOut || extracted.code) throw new Error(extracted.err.trim().split("\n").at(-1) || "Unpacking the packages failed.");

    writeFileSync(join(project, "package.json"), JSON.stringify(prepared.manifest, null, 2));
    writeFileSync(join(project, "bun.lock"), prepared.lock);
    const installed = await runBoxed(
      { cmd: [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile", `--cache-dir=${cache}`, `--registry=${REGISTRY}`, "--no-progress"], cwd: project, scratch },
      STEP_MS,
    );
    if (installed.timedOut || installed.code) throw new Error(`bun install failed:\n${(installed.err || installed.out).trim().slice(-2000)}`);

    const fresh = join(project, "node_modules");
    if (existsSync(fresh)) {
      // Mods never run a package's executables.
      rmSync(join(fresh, ".bin"), { recursive: true, force: true });
      plainTree(fresh);
    }
    const modules = join(root, "node_modules");
    if (existsSync(modules)) renameSync(modules, join(scratch, "replaced"));
    if (existsSync(fresh)) renameSync(fresh, modules);
    writeFileSync(join(root, "package.json"), `${JSON.stringify(prepared.manifest, null, 2)}\n`);
    writeFileSync(join(root, "bun.lock"), prepared.lock);
    return prepared.summary;
  } finally {
    // The packages it replaced may be large; the world keeps running while they go.
    await rm(scratch, { recursive: true, force: true });
  }
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Installs the packages root/package.json names, plus `add` ("name" or "name@range") the way bun add would, and rewrites package.json and bun.lock to what was installed.
 * One install per world at a time. Resolves to what was installed, a line per package package.json names; rejects with a sentence for the player, the same one reloads get when this computer has no sandbox.
 */
export function install(root: string, add?: string): Promise<string> {
  const run = (queues.get(root) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const refusal = boxRefusal();
      if (refusal) throw new Error(refusal);
      return installPrepared(root, await prepare(root, add));
    });
  queues.set(root, run);
  return run;
}
