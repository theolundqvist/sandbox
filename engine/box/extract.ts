// Unpacks npm package tarballs into Bun's install cache. The host runs it in the mod sandbox, after checking each tarball's sha512 against the registry's. Only plain files and their folders come out: a link, a device, an absolute path or one that climbs out turns the whole package away.
import { lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

const decoder = new TextDecoder();
const field = (block: Uint8Array, from: number, length: number) => {
  const bytes = block.subarray(from, from + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
};
const octal = (block: Uint8Array, from: number, length: number) => {
  // Base-256 sizes are for files over 8 GB, which no package has.
  if (block[from]! & 0x80) throw new Error("a file too big for a package");
  const text = field(block, from, length).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error("a damaged tar header");
  return parseInt(text || "0", 8);
};
const KINDS: Record<string, string> = { "1": "a hard link", "2": "a symbolic link", "3": "a device", "4": "a device", "6": "a pipe", K: "a link" };

/** pax extended header records, "<length> <key>=<value>\n" each. */
function pax(body: Uint8Array) {
  const records: Record<string, string> = {};
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    const length = Number(decoder.decode(body.subarray(at, space)));
    if (space < 0 || !Number.isInteger(length) || length <= 0) throw new Error("a damaged pax header");
    const record = decoder.decode(body.subarray(space + 1, at + length - 1));
    const eq = record.indexOf("=");
    records[record.slice(0, eq)] = record.slice(eq + 1);
    at += length;
  }
  return records;
}

/** The files of a gzipped tar, by their path inside the package's top folder. Throws on anything but plain files and folders. */
export function tarFiles(gz: Uint8Array<ArrayBuffer>) {
  const tar = Bun.gunzipSync(gz);
  const files = new Map<string, Uint8Array>();
  let at = 0;
  let longName: string | null = null;
  let headers: Record<string, string> = {};
  while (at + 512 <= tar.length) {
    const block = tar.subarray(at, at + 512);
    if (block.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
    if (sum !== octal(block, 148, 8)) throw new Error("a damaged tar header");
    const size = octal(block, 124, 12);
    const type = String.fromCharCode(block[156]!);
    if (at + 512 + size > tar.length) throw new Error("a cut-off tar");
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "g") continue;
    if (type === "x") {
      headers = pax(body);
      if ("size" in headers || "linkpath" in headers) throw new Error("a pax size or link");
      continue;
    }
    if (type === "L") {
      longName = field(body, 0, body.length);
      continue;
    }
    const ustar = field(block, 257, 5) === "ustar" ? field(block, 345, 155) : "";
    const name = headers.path ?? longName ?? (ustar ? `${ustar}/${field(block, 0, 100)}` : field(block, 0, 100));
    longName = null;
    headers = {};
    if (KINDS[type] || !["0", "\0", "7", "5"].includes(type)) throw new Error(`${KINDS[type] ?? "an unknown kind of file"} (${name})`);
    const parts = name.replace(/^(\.\/)+/, "").split("/");
    if (name.startsWith("/") || parts.slice(1).some((p, i, all) => p === "." || p === ".." || /[\\\0]/.test(p) || (!p && i < all.length - 1)))
      throw new Error(`a path that leaves the package (${name})`);
    const inner = parts.slice(1).filter(Boolean).join("/");
    if (type === "5" || !inner) continue;
    files.set(inner, body.slice());
  }
  return files;
}

/** Writes a package's files under dir, which must not exist yet, then checks every path there is a plain file or folder inside it. */
export function extractPackage(gz: Uint8Array<ArrayBuffer>, dir: string) {
  const files = tarFiles(gz);
  if (!files.has("package.json")) throw new Error("no package.json");
  mkdirSync(dir, { recursive: false });
  for (const [path, bytes] of files) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: "wx" });
  }
  const real = realpathSync(dir) + sep;
  const check = (path: string) => {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      const stat = lstatSync(child);
      if (!realpathSync(child).startsWith(real) || !(stat.isDirectory() || (stat.isFile() && stat.nlink === 1))) throw new Error(`${child} is not a plain file`);
      if (stat.isDirectory()) check(child);
    }
  };
  check(dir);
}

if (import.meta.main) {
  const { cache, packages } = (await Bun.file(process.argv[2]!).json()) as { cache: string; packages: { id: string; tgz: string; dir: string }[] };
  for (const { id, tgz, dir } of packages) {
    try {
      // A scoped package's folder sits in its scope's.
      mkdirSync(dirname(join(cache, dir)), { recursive: true });
      extractPackage(await Bun.file(tgz).bytes(), join(cache, dir));
    } catch (e) {
      console.error(`${id} can't be installed: its tarball holds ${e instanceof Error ? e.message : String(e)}.`);
      process.exit(1);
    }
  }
}
