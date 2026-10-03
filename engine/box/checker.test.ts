import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GIT, GIT_ENV, hasGit, Mods } from "../mods";
import { Checker } from "./checker";
import { boxReason } from "./index";

const ENGINE = join(import.meta.dir, "..");
const base = join(import.meta.dir, "../../.scratch/test-tmp");
mkdirSync(base, { recursive: true });
const scratch = mkdtempSync(join(base, "checker-"));
const open: { close(): Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(open.map((o) => o.close()));
  rmSync(scratch, { recursive: true, force: true });
});

/** The tsconfig.json the world server writes at start. */
const TSCONFIG = {
  compilerOptions: {
    lib: ["ESNext", "DOM"], target: "ESNext", module: "Preserve", moduleResolution: "bundler", moduleDetection: "force", allowImportingTsExtensions: true, noEmit: true, strict: true, skipLibCheck: true,
    typeRoots: [join(ENGINE, "../node_modules/@types")], types: ["bun"],
    paths: { three: [join(ENGINE, "../node_modules/@types/three")], "three/addons/*": [join(ENGINE, "../node_modules/@types/three/examples/jsm/*")], "three/*": [join(ENGINE, "../node_modules/@types/three/*")] },
  },
  include: ["**/*.ts"],
};
const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
let worlds = 0;
/** A world folder as the engine leaves one at start, with these files under mods/. */
function world(files: Record<string, string> = {}) {
  const root = join(scratch, `world-${worlds++}`, "world");
  mkdirSync(join(root, "mods"), { recursive: true });
  cpSync(join(ENGINE, "api.ts"), join(root, "api.ts"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify(TSCONFIG));
  for (const [path, text] of Object.entries(files)) put(root, `mods/${path}`, text);
  return root;
}
function checker(root: string) {
  const c = new Checker(root);
  open.push(c);
  return c;
}
/** Mods for a world with a history, whose test runs and swaps always succeed; what it tells the world goes to feeds. */
function modsOf(root: string, feeds: string[] = []) {
  for (const args of [["init", "-q"], ["config", "user.name", "sandbox"], ["config", "user.email", "sandbox@sandbox"]]) Bun.spawnSync([...GIT, ...args], { cwd: root, env: GIT_ENV });
  const mods = new Mods(root, join(root, "../build"), join(root, "../mods.json"), { client: () => false, feed: (text) => feeds.push(text), record: () => {} });
  open.push(mods);
  mods.sims = { trial: async () => null, apply: async () => null, hasGame: () => false } as unknown as Mods["sims"];
  return mods;
}
/** The checker process a host process started for this world, found by its parent and its arguments. Polled, since another process's start and end raise no event here. */
async function checkerPid(host: number, root: string) {
  for (let i = 0; i < 100; i++) {
    const rows = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,args="]).stdout.toString().split("\n");
    const row = rows.map((r) => r.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).find((m) => m && Number(m[2]) === host && m[3]!.includes("checker.child.ts") && m[3]!.includes(root));
    if (row) return Number(row[1]);
    await Bun.sleep(50);
  }
  throw new Error("No checker process started.");
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("once warm, each check answers for the files as they are now: errors carry over where nothing changed, reach the importers of changed exports, and clear with the fix", async () => {
  expect(boxReason()).toBeNull();
  const root = world({
    "bank/server.ts": `export function pay(n: number) { return n; }\n`,
    "shop/server.ts": `import { pay } from "../bank/server.ts";\nexport const left: number = pay(1);\n`,
    "other/server.ts": `export const late: string = 1;\n`,
  });
  const c = checker(root);
  await c.warm();
  const asked = ["bank", "shop", "other"];
  const other = "mods/other/server.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.";
  const shop = "mods/shop/server.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'.";
  expect(await c.check(asked)).toEqual([other]);
  put(root, "mods/bank/server.ts", `export function pay(n: number) { return String(n); }\n`);
  expect((await c.check(asked)).sort()).toEqual([other, shop]);
  put(root, "mods/bank/server.ts", `export function pay(n: number) { return String(n + 1); }\n`);
  expect((await c.check(asked)).sort()).toEqual([other, shop]);
  expect(await c.check(["shop"])).toEqual([shop]);
  put(root, "mods/bank/server.ts", `export function pay(n: number) { return n + 1; }\n`);
  expect(await c.check(asked)).toEqual([other]);
  expect(await c.check(asked)).toEqual([other]);
  await c.close();
}, 60_000);

test("a running check sees each edit, new file and deleted file, even an edit that keeps a file's size", async () => {
  expect(boxReason()).toBeNull();
  const root = world({ "a/server.ts": `import { n } from "./helper.ts";\nexport const total: number = n;\n`, "a/helper.ts": `export const n: number = 1;\n` });
  const c = checker(root);
  expect(await c.check(["a"])).toEqual([]);
  put(root, "mods/a/helper.ts", `export const n: string = 1;\n`);
  expect((await c.check(["a"])).sort()).toEqual([
    "mods/a/helper.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.",
    "mods/a/server.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'.",
  ]);
  put(root, "mods/a/helper.ts", `export const n: number = 1;\n`);
  put(root, "mods/a/extra.ts", `export const late: boolean = "no";\n`);
  expect(await c.check(["a"])).toEqual(["mods/a/extra.ts(1,14): error TS2322: Type 'string' is not assignable to type 'boolean'."]);
  rmSync(join(root, "mods/a/extra.ts"));
  rmSync(join(root, "mods/a/helper.ts"));
  const missing = await c.check(["a"]);
  expect(missing).toHaveLength(1);
  expect(missing[0]).toStartWith("mods/a/server.ts(1,19): error TS2307:");
  put(root, "mods/a/helper.ts", `export const n: number = 1;\n`);
  expect(await c.check(["a"])).toEqual([]);
  await c.close();
}, 60_000);

test("an import in a file nobody edited follows a package.json that now points elsewhere, and a file put ahead of the one it found", async () => {
  expect(boxReason()).toBeNull();
  const root = world({
    "a/package.json": JSON.stringify({ imports: { "#price": "./one.ts" } }),
    "a/one.ts": `export const price: number = 1;\n`,
    "a/two.ts": `export const price: string = "2";\n`,
    "a/server.ts": `import { price } from "#price";\nexport const total: number = price;\n`,
    "b/lib/index.ts": `export const n: number = 1;\n`,
    "b/server.ts": `import { n } from "./lib";\nexport const total: number = n;\n`,
  });
  const c = checker(root);
  expect(await c.check(["a", "b"])).toEqual([]);
  put(root, "mods/a/package.json", JSON.stringify({ imports: { "#price": "./two.ts" } }));
  expect(await c.check(["a"])).toEqual(["mods/a/server.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'."]);
  put(root, "mods/b/lib.tsx", `export const n: string = "x";\n`);
  const ahead = await c.check(["b"]);
  expect(ahead).toHaveLength(1);
  expect(ahead[0]).toStartWith("mods/b/server.ts(1,19): error TS6142: Module './lib' was resolved to ");
  await c.close();
}, 60_000);

test("a package put in place while the checker runs is found, and one that replaces it is read afresh, whether a check or a warm-up meets it first", async () => {
  expect(boxReason()).toBeNull();
  const root = world({ "shop/server.ts": `import { price } from "fixture-prices";\nexport const total: number = price;\n` });
  // As an install does: a fresh node_modules folder takes the old one's place.
  const install = (types: string) => {
    const fresh = mkdtempSync(join(scratch, "install-"));
    put(fresh, "node_modules/fixture-prices/package.json", JSON.stringify({ name: "fixture-prices", version: "1.0.0", types: "index.d.ts" }));
    put(fresh, "node_modules/fixture-prices/index.d.ts", types);
    if (existsSync(join(root, "node_modules"))) renameSync(join(root, "node_modules"), join(fresh, "replaced"));
    renameSync(join(fresh, "node_modules"), join(root, "node_modules"));
  };
  const c = checker(root);
  const before = await c.check(["shop"]);
  expect(before).toHaveLength(1);
  expect(before[0]).toStartWith("mods/shop/server.ts(1,23): error TS2307:");
  install("export declare const price: number;\n");
  expect(await c.check(["shop"])).toEqual([]);
  install("export declare const price: string;\n");
  await c.warm();
  expect(await c.check(["shop"])).toEqual(["mods/shop/server.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'."]);
  await c.close();
}, 60_000);

test("a mod as last accepted stands in for its folder in that one check, and no history means no mod", async () => {
  expect(boxReason()).toBeNull();
  const root = world({
    "bank/server.ts": `export function pay(n: number) { return String(n); }\n`,
    "bank/draft.ts": `export const unfinished: number = "soon";\n`,
    "user/server.ts": `import { pay } from "../bank/server.ts";\nexport const left: number = pay(1);\n`,
  });
  const c = checker(root);
  const broken = ["mods/user/server.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'."];
  expect(await c.check(["user"])).toEqual(broken);
  expect(await c.check(["user"], { mod: "bank", files: { "mods/bank/server.ts": `export function pay(n: number) { return n; }\n` } })).toEqual([]);
  expect(await c.check(["user"])).toEqual(broken);
  const gone = await c.check(["user"], { mod: "bank", files: {} });
  expect(gone).toHaveLength(1);
  expect(gone[0]).toStartWith("mods/user/server.ts(1,21): error TS2307:");
  expect(await c.check(["user"])).toEqual(broken);
  await c.close();
}, 60_000);

test("a config the compiler refuses fails the check instead of passing it, and the next good config checks again", async () => {
  expect(boxReason()).toBeNull();
  const root = world({ "a/server.ts": `export const n: number = "x";\n` });
  const c = checker(root);
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ ...TSCONFIG, compilerOptions: { ...TSCONFIG.compilerOptions, strict: "yes" } }));
  await expect(c.check(["a"])).rejects.toThrow("TS5024");
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ ...TSCONFIG, compilerOptions: { ...TSCONFIG.compilerOptions, types: ["missing-fixture-types"] } }));
  await expect(c.check(["a"])).rejects.toThrow("TS2688");
  writeFileSync(join(root, "tsconfig.json"), "{ not json");
  await expect(c.check(["a"])).rejects.toThrow("error TS");
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify(TSCONFIG));
  expect(await c.check(["a"])).toEqual(["mods/a/server.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'."]);
  await c.close();
}, 60_000);

test("checks asked for together are answered one at a time, each with its own mods' errors", async () => {
  expect(boxReason()).toBeNull();
  const root = world({ "a/server.ts": `export const a: number = "a";\n`, "b/server.ts": `export const b: string = 2;\n`, "c/server.ts": `export const c = 3;\n` });
  const c = checker(root);
  const [a, b, clean] = await Promise.all([c.check(["a"]), c.check(["b"]), c.check(["c"])]);
  expect(a).toEqual(["mods/a/server.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'."]);
  expect(b).toEqual(["mods/b/server.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'."]);
  expect(clean).toEqual([]);
  await c.close();
}, 60_000);

test("a checker that dies mid-check fails that check, and the next check starts a fresh one", async () => {
  expect(boxReason()).toBeNull();
  const root = world({ "a/server.ts": `export const n: number = "x";\n` });
  const c = checker(root);
  const first = c.check(["a"]);
  const pid = await checkerPid(process.pid, root);
  process.kill(pid, "SIGKILL");
  await expect(first).rejects.toThrow("The typecheck stopped");
  expect(await c.check(["a"])).toHaveLength(1);
  expect(await checkerPid(process.pid, root)).not.toBe(pid);
  await c.close();
}, 60_000);

test("a checker leaves no process behind, whether its world closes it or dies", async () => {
  expect(boxReason()).toBeNull();
  const root = world({ "a/server.ts": `export const n = 1;\n` });
  const c = checker(root);
  expect(await c.check(["a"])).toEqual([]);
  const pid = await checkerPid(process.pid, root);
  await c.close();
  expect(alive(pid)).toBe(false);
  await expect(c.check(["a"])).rejects.toThrow("The world is stopping.");

  const host = Bun.spawn(
    [process.execPath, "--no-env-file", "-e", `import { Checker } from ${JSON.stringify(join(import.meta.dir, "checker.ts"))};\nawait new Checker(${JSON.stringify(root)}).check(["a"]);\nconsole.log("checked");\nsetInterval(() => {}, 1000);\n`],
    { cwd: scratch, env: { PATH: process.env.PATH ?? "", HOME: scratch, TMPDIR: process.env.TMPDIR ?? scratch }, stdout: "pipe", stderr: "inherit" },
  );
  const reader = host.stdout.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toContain("checked");
  const orphan = await checkerPid(host.pid, root);
  process.kill(host.pid, "SIGKILL");
  await host.exited;
  for (let i = 0; i < 100 && alive(orphan); i++) await Bun.sleep(50);
  expect(alive(orphan)).toBe(false);
}, 60_000);

test("a world loads without starting its typecheck; the warm-up the hub's first tick starts is the one the first reload waits for in that same process and says so, and the next reload doesn't", async () => {
  expect(boxReason()).toBeNull();
  const root = world();
  const mods = modsOf(root);
  await mods.loadAll({});
  mods.startWarmUp();
  mods.startWarmUp();
  const pid = await checkerPid(process.pid, root);
  const warming = "Warming up the type checker, first reload takes a few seconds";
  put(root, "mods/solo/server.ts", `export const n: number = 1;\nexport default {};\n`);
  // Loading TypeScript alone takes the typecheck about a second, so this reload waited for the warm-up.
  const first = (await mods.reload("solo", "ada", "ada")).report;
  expect(first).toStartWith("solo v1 is live");
  expect(first.split("\n").at(-1)).toBe(warming);
  expect(await checkerPid(process.pid, root)).toBe(pid);
  put(root, "mods/solo/server.ts", `export const n: number = 2;\nexport default {};\n`);
  const next = (await mods.reload("solo", "ada", "ada")).report;
  expect(next).toStartWith("solo v2 is live");
  expect(next).not.toContain(warming);
}, 60_000);

test("a reload before the warm-up started starts the typecheck itself, waits for it, and says so", async () => {
  expect(boxReason()).toBeNull();
  const root = world();
  const mods = modsOf(root);
  await mods.loadAll({});
  put(root, "mods/solo/server.ts", `export const n: number = 1;\nexport default {};\n`);
  const first = (await mods.reload("solo", "ada", "ada")).report;
  expect(first).toStartWith("solo v1 is live");
  expect(first.split("\n").at(-1)).toBe("Warming up the type checker, first reload takes a few seconds");
}, 60_000);

test("a world stopped while its typecheck warms up stops it quietly and leaves no process behind", async () => {
  expect(boxReason()).toBeNull();
  const feeds: string[] = [];
  const root = world();
  const mods = modsOf(root, feeds);
  await mods.loadAll({});
  mods.startWarmUp();
  const pid = await checkerPid(process.pid, root);
  await mods.close();
  expect(alive(pid)).toBe(false);
  // A tick after the stop starts no warm-up of its own.
  mods.startWarmUp();
  // The cut-short warm-up settles in promise callbacks, which all run before the next macrotask.
  const turn = Promise.withResolvers<void>();
  setImmediate(turn.resolve);
  await turn.promise;
  expect(feeds).toEqual([]);
}, 60_000);

test("a world whose typecheck can't warm up still loads and says why, and its reloads are refused until the typecheck runs", async () => {
  expect(boxReason()).toBeNull();
  const root = world();
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ ...TSCONFIG, compilerOptions: { ...TSCONFIG.compilerOptions, strict: "yes" } }));
  const feeds: string[] = [];
  const mods = modsOf(root, feeds);
  await expect(mods.warm()).rejects.toThrow("TS5024");
  await mods.loadAll({});
  mods.startWarmUp();
  put(root, "mods/solo/server.ts", `export const n: number = 1;\nexport default {};\n`);
  // This reload's check waits for the warm-up the hub's first tick started, which fails first and is reported once.
  expect((await mods.reload("solo", "ada", "ada")).report).toStartWith("The typecheck couldn't run, nothing changed:");
  const couldnt = feeds.filter((text) => text.startsWith("The typecheck couldn't start;"));
  expect(couldnt).toHaveLength(1);
  expect(couldnt[0]).toContain("TS5024");
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify(TSCONFIG));
  expect((await mods.reload("solo", "ada", "ada")).report).toStartWith("solo v1 is live");
}, 60_000);

test("a reload is rejected for its own type errors and for errors it newly causes in live mods that use it, never for errors those mods had before it", async () => {
  expect(boxReason()).toBeNull();
  expect(hasGit).toBe(true);
  const root = world();
  const mods = modsOf(root);
  await mods.loadAll({});
  const bank = (body: string) => `export function pay(n: number) { ${body} }\nexport default {};\n`;
  put(root, "mods/bank/server.ts", bank("return n;"));
  expect((await mods.reload("bank", "ada", "ada")).ok).toBe(true);
  put(root, "mods/shop/server.ts", `import { pay } from "../bank/server.ts";\nexport const left: number = pay(1);\nexport default {};\n`);
  expect((await mods.reload("shop", "bo", "bo")).ok).toBe(true);
  // shop's owner has an unfinished edit that already fails against bank as it was accepted.
  put(root, "mods/shop/draft.ts", `import { pay } from "../bank/server.ts";\nexport const draft: string = pay(1);\n`);

  put(root, "mods/bank/server.ts", `${bank("return n * 2;")}export const fee = 1;\n`);
  expect((await mods.reload("bank", "ada", "ada")).report).toStartWith("bank v2 is live");

  put(root, "mods/bank/server.ts", bank("return String(n);"));
  const breaking = await mods.reload("bank", "ada", "ada");
  expect(breaking.ok).toBe(false);
  expect(breaking.report).toStartWith("This change breaks live mods that use bank, nothing changed.");
  expect(breaking.report).toContain("mods/shop/server.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'.");
  expect(breaking.report).not.toContain("draft.ts");

  put(root, "mods/bank/server.ts", `${bank("return n;")}export const rate: number = "high";\n`);
  const own = await mods.reload("bank", "ada", "ada");
  expect(own.ok).toBe(false);
  expect(own.report).toBe("Type errors, nothing changed:\nmods/bank/server.ts(3,14): error TS2322: Type 'string' is not assignable to type 'number'.");
  expect(mods.running.get("bank")?.version).toBe(2);
}, 120_000);
