import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { GIT, GIT_ENV, hasGit } from "./mods";

const base = join(import.meta.dir, "../.scratch/test-tmp");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, "archive-import-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]) {
  const run = Bun.spawnSync([...GIT, ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
}
/** Every file under dir, by its path there after prefix, as a zip takes them. */
function zipped(dir: string, prefix: string, into: Zippable) {
  for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" })) if (statSync(join(dir, name)).isFile()) into[`${prefix}${name}`] = readFileSync(join(dir, name));
  return into;
}

async function pack(dir: string, publicWorld: boolean, secrets: string[] = [], publicContent: (string | Uint8Array)[] = []) {
  const worker = new Worker(new URL("./archive.ts", import.meta.url));
  const { promise, resolve, reject } = Promise.withResolvers<{ zip?: Uint8Array; error?: string }>();
  worker.onmessage = ({ data }) => resolve(data);
  worker.onerror = (error) => reject(error);
  worker.postMessage({ t: "pack", dir, community: publicWorld, secrets, publicContent });
  try { return await promise; } finally { worker.terminate(); }
}

test.skipIf(!hasGit)("Community refuses a key in a mod's files or its old Git history; private Export keeps the full world", async () => {
  const dir = join(root, "public-secrets");
  const source = join(dir, "world");
  mkdirSync(join(source, "mods/garden"), { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name: "Garden", hostKey: "synthetic-host-canary", invite: "synthetic-invite-canary" }));
  writeFileSync(join(dir, "keys.json"), JSON.stringify({ "synthetic-player-canary": "ana" }));
  const file = join(source, "mods/garden/server.ts");
  const clean = "export default {};\n";
  const secret = "sk_voice_0123456789abcdefghij";
  writeFileSync(file, `export default { secret: "${secret}" };\n`);
  git(source, "init", "-q");
  git(source, "add", "-A");
  git(source, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "old code");
  const blocked = await pack(dir, true);
  expect(blocked.zip).toBeUndefined();
  expect(blocked.error).toContain("world file");
  expect(blocked.error).not.toContain(secret);
  writeFileSync(file, clean);
  git(source, "add", "-A");
  git(source, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "current code");
  const history = await pack(dir, true);
  expect(history.zip).toBeUndefined();
  expect(history.error).toContain("history");
  git(source, "repack", "-a", "-d");
  git(source, "prune-packed");
  const packed = await pack(dir, true);
  expect(packed.zip).toBeUndefined();
  expect(packed.error).toContain("history");
  const exported = await pack(dir, false);
  expect(exported.error).toBeUndefined();
  expect(exported.zip).toBeDefined();
}, 30_000);

test("Community refuses known host, player, launcher and environment keys in source; a safe world still shares", async () => {
  const dir = join(root, "known-secrets");
  const source = join(dir, "world/mods/garden");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name: "Garden", hostKey: "synthetic-host-canary", invite: "synthetic-invite-canary" }));
  writeFileSync(join(dir, "keys.json"), JSON.stringify({ "synthetic-player-canary": "ana" }));
  const file = join(source, "server.ts");
  const launcher = "synthetic-launcher-voice-canary";
  for (const secret of ["synthetic-host-canary", "synthetic-player-canary", launcher]) {
    writeFileSync(file, `export default { test: "${secret}" };\n`);
    const blocked = await pack(dir, true, [launcher]);
    expect(blocked.zip).toBeUndefined();
    expect(blocked.error).toContain("world file");
    expect(blocked.error).not.toContain(secret);
  }
  process.env.SANDBOX_TEST_TOKEN = "synthetic-env-canary";
  try {
    writeFileSync(file, `export default { test: "${process.env.SANDBOX_TEST_TOKEN}" };\n`);
    const blocked = await pack(dir, true, [process.env.SANDBOX_TEST_TOKEN!]);
    expect(blocked.zip).toBeUndefined();
    expect(blocked.error).toContain("world file");
  } finally {
    delete process.env.SANDBOX_TEST_TOKEN;
  }
  writeFileSync(file, "export default {};\n");
  const safe = await pack(dir, true, [launcher]);
  expect(safe.error).toBeUndefined();
  expect(safe.zip).toBeDefined();
  for (const content of [JSON.stringify({ description: launcher }), Buffer.from(`caption ${launcher}`)]) {
    const metadata = await pack(dir, true, [launcher], [content]);
    expect(metadata.zip).toBeUndefined();
    expect(metadata.error).toContain("publication details");
    expect(metadata.error).not.toContain(launcher);
  }
});

test.skipIf(!hasGit)("Community checks unreachable Git objects across stream boundaries", async () => {
  const dir = join(root, "orphan-history");
  const source = join(dir, "world");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name: "Garden" }));
  git(source, "init", "-q");
  const orphan = join(root, "orphan-content");
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  writeFileSync(orphan, "x".repeat(256 * 1024 - 12) + secret);
  git(source, "hash-object", "-w", orphan);
  const blocked = await pack(dir, true);
  expect(blocked.zip).toBeUndefined();
  expect(blocked.error).toContain("history");
  expect(blocked.error).not.toContain(secret);
  git(source, "prune", "--expire=now");
  const clean = await pack(dir, true);
  expect(clean.error).toBeUndefined();
  expect(clean.zip).toBeDefined();
}, 30_000);

test.skipIf(!hasGit)("an imported world keeps its history but none of the git config, hooks or package settings that would run its code", async () => {
  // A world as a stranger might shape it: its own history, then a repository config, hooks and attributes that run commands.
  const source = join(root, "source/world");
  mkdirSync(join(source, "mods/garden"), { recursive: true });
  writeFileSync(join(source, "mods/garden/server.ts"), "export default {};\n");
  git(source, "init", "-q");
  git(source, "add", "-A");
  git(source, "-c", "user.name=stranger", "-c", "user.email=stranger@example.com", "commit", "-qm", "planted the garden");
  const ran = (what: string) => join(root, `${what}-ran`);
  const run = (what: string) => `touch '${ran(what)}'`;
  writeFileSync(
    join(source, ".git/config"),
    `${readFileSync(join(source, ".git/config"), "utf8")}[core]\n\tfsmonitor = ${run("fsmonitor")}\n\thooksPath = .git/hooks\n[filter "evil"]\n\tclean = ${run("filter")}; cat\n\tsmudge = ${run("filter")}; cat\n\trequired = true\n[include]\n\tpath = /etc/gitconfig\n`,
  );
  mkdirSync(join(source, ".git/hooks"), { recursive: true });
  for (const hook of ["pre-commit", "post-commit", "post-checkout"]) writeFileSync(join(source, ".git/hooks", hook), `#!/bin/sh\n${run("hook")}\n`, { mode: 0o755 });
  mkdirSync(join(source, ".git/info"), { recursive: true });
  writeFileSync(join(source, ".git/info/attributes"), "* filter=evil\n");
  writeFileSync(join(source, ".git/objects/info/alternates"), join(root, "elsewhere/objects"));
  writeFileSync(join(source, ".git/config.worktree"), `[core]\n\tfsmonitor = ${run("worktree")}\n`);
  mkdirSync(join(source, ".git/worktrees/other"), { recursive: true });
  writeFileSync(join(source, ".git/worktrees/other/gitdir"), join(root, "elsewhere/.git"));
  writeFileSync(join(source, "mods/garden/.gitattributes"), "* filter=evil\n");
  writeFileSync(join(source, "bunfig.toml"), `preload = ["./mods/garden/server.ts"]\n`);
  writeFileSync(join(source, ".npmrc"), "registry=https://registry.example.com/\n");
  writeFileSync(join(source, ".env"), "STRANGER=1\n");
  writeFileSync(join(source, "package.json"), JSON.stringify({ scripts: { postinstall: run("script") }, trustedDependencies: ["thing"], dependencies: { thing: "^1.0.0", fork: "github:stranger/thing" } }));
  const integrity = `sha512-${new Bun.CryptoHasher("sha512").update("thing").digest("base64")}`;
  writeFileSync(join(source, "bun.lock"), JSON.stringify({ lockfileVersion: 1, packages: { thing: ["thing@1.2.0", "", {}, integrity], fork: ["fork@github:stranger/thing#abc", {}, "abc"] } }));

  const zip = zipSync(zipped(source, "world/", { "config.json": new TextEncoder().encode(JSON.stringify({ name: "Stranger's garden" })) }));
  const into = join(root, "imported");
  const worker = new Worker(new URL("./archive.ts", import.meta.url));
  const { promise, resolve } = Promise.withResolvers<{ world?: { name: string }; error?: string }>();
  worker.onmessage = ({ data }) => resolve(data);
  worker.postMessage({ t: "unpack", zip, into });
  const answer = await promise;
  worker.terminate();
  expect(answer.error ?? answer.world?.name).toBe("Stranger's garden");

  const world = join(into, "world");
  const config = readFileSync(join(world, ".git/config"), "utf8");
  expect(["fsmonitor", "hooksPath", "filter", "include", "/etc/gitconfig"].some((word) => config.includes(word))).toBe(false);
  for (const gone of [".git/hooks", ".git/info", ".git/objects/info/alternates", ".git/config.worktree", ".git/worktrees", "bunfig.toml", ".npmrc", ".env"]) expect(existsSync(join(world, gone))).toBe(false);
  expect(JSON.parse(readFileSync(join(world, "package.json"), "utf8"))).toEqual({ private: true, dependencies: { thing: "^1.0.0" } });
  const lock = readFileSync(join(world, "bun.lock"), "utf8");
  expect(lock.includes("thing@1.2.0") && !lock.includes("github:")).toBe(true);

  // Plain git, without the engine's own guards, finds the history and runs nothing the stranger set up.
  const plain = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: world, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  expect(plain("log", "--format=%an %s").stdout.toString().trim()).toBe("stranger planted the garden");
  writeFileSync(join(world, "mods/garden/server.ts"), "export default { grown: true };\n");
  expect(plain("status", "--porcelain").exitCode).toBe(0);
  expect(plain("add", "-A").exitCode).toBe(0);
  expect(plain("commit", "-qm", "grew").exitCode).toBe(0);
  expect(plain("checkout", "-q", "HEAD~1", "--", "mods/garden/server.ts").exitCode).toBe(0);
  expect(["fsmonitor", "filter", "hook", "worktree", "script"].some((what) => existsSync(ran(what)))).toBe(false);
}, 30_000);

test.skipIf(!hasGit)("restoring imported Git history cannot turn a mod file into a link outside the world", async () => {
  const source = join(root, "linked-history/world");
  mkdirSync(join(source, "mods/garden"), { recursive: true });
  const outside = join(root, "outside-canary");
  const canary = `SYNTHETIC-RESTORE-${crypto.randomUUID()}`;
  writeFileSync(outside, canary);
  const path = "mods/garden/link.txt";
  writeFileSync(join(source, path), outside);
  git(source, "init", "-q");
  const blob = git(source, "hash-object", "-w", path);
  git(source, "update-index", "--add", "--cacheinfo", "120000", blob, path);
  git(source, "-c", "user.name=stranger", "-c", "user.email=stranger@example.com", "commit", "-qm", "linked file");
  const commit = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, path), "current mod data");
  const current = git(source, "hash-object", "-w", path);
  git(source, "update-index", "--cacheinfo", "100644", current, path);
  git(source, "-c", "user.name=stranger", "-c", "user.email=stranger@example.com", "commit", "-qm", "regular file");
  const zip = zipSync(zipped(source, "world/", { "config.json": new TextEncoder().encode(JSON.stringify({ name: "Linked garden" })) }));
  const into = join(root, "linked-import");
  const worker = new Worker(new URL("./archive.ts", import.meta.url));
  const result = Promise.withResolvers<{ error?: string }>();
  worker.onmessage = ({ data }) => result.resolve(data);
  worker.onerror = (error) => result.reject(error);
  try {
    worker.postMessage({ t: "unpack", zip, into });
    expect((await result.promise).error).toBeUndefined();
  } finally {
    worker.terminate();
  }
  const world = join(into, "world");
  git(world, "rm", "-rq", "--ignore-unmatch", "--", "mods/garden");
  git(world, "checkout", commit, "--", "mods/garden");
  git(world, "reset", "-q");
  expect(readFileSync(join(world, path), "utf8")).toBe(outside);
  expect(readFileSync(outside, "utf8")).toBe(canary);
}, 30_000);
