import { afterAll, expect, test } from "bun:test";
import { chmodSync, constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { box, boxReason } from "./index";

const base = join(import.meta.dir, "../../.scratch/test-tmp");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, "box-canary-"));
const home = join(root, "fake-home");
const own = join(root, "own-build");
const db = join(root, "db");
const scratch = join(root, "scratch");
const bootstrap = join(root, "bootstrap");
const bootstrapCanary = join(bootstrap, "private-canary");
for (const dir of [home, own, db, scratch, bootstrap, join(home, ".ssh")]) mkdirSync(dir, { recursive: true });
for (const file of ["index.ts", "child.ts", "linux.c", "lock.ts", "bunfig.toml"]) copyFileSync(join(import.meta.dir, file), join(bootstrap, file));
// Load the copied bootstrap so its neighboring canary never touches installed engine files.
const copiedBox = (await import(pathToFileURL(join(bootstrap, "index.ts")).href)).box;
const canary = `SYNTHETIC-CANARY-${crypto.randomUUID()}`;
const ssh = join(home, ".ssh/id_canary");
const envFile = join(root, ".env");
const launcher = join(root, "launcher.json");
const world = join(root, "world.sqlite");
const outside = join(root, "outside.txt");
const outsideLink = join(own, "outside-link");
const shellCopy = join(scratch, "shell-copy");
if (process.platform === "linux") copyFileSync("/bin/sh", shellCopy);
const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("test") });
for (const path of [ssh, envFile, launcher, world, outside, bootstrapCanary]) writeFileSync(path, canary);
writeFileSync(join(own, "legit.ts"), "export const allowed = 'allowed import';\n");
writeFileSync(join(own, ".env"), "AUTO_CANARY=must-not-load\n");
writeFileSync(join(own, "bunfig.toml"), 'preload = ["./ambient.ts"]\n');
writeFileSync(join(own, "ambient.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(scratch, "preload-ran"))}, "yes");\n`);
const mod = join(own, "hostile.ts");
const target = { ssh, envFile, launcher, world, bootstrapCanary, outside, outsideLink, db, shellCopy, port: listener.port };
writeFileSync(mod, `
import { Database } from "bun:sqlite";
import { allowed } from "./legit.ts";
import { chmodSync, constants, readFileSync, writeFileSync, truncateSync, openSync, closeSync, symlinkSync } from "node:fs";
import { dlopen, ptr } from "bun:ffi";
const target = ${JSON.stringify(target)};
const results: Record<string, boolean | string> = {
  imported: allowed, env: typeof process.env.BOX_CANARY === "string",
  envFileLoaded: process.env.AUTO_CANARY === "must-not-load",
  ambientPreload: await Bun.file(target.db + "/../scratch/preload-ran").exists(),
};
for (const key of [\"ssh\", \"envFile\", \"launcher\", \"world\", \"bootstrapCanary\"] as const) {
  try { results[key] = readFileSync(target[key], \"utf8\").length > 0; }
  catch { results[key] = false; }
}
try { writeFileSync(target.outside, "damaged"); results.write = true; }
catch { results.write = false; }
try { truncateSync(target.outside, 0); results.truncate = true; }
catch { results.truncate = false; }
try { closeSync(openSync(target.outside, constants.O_RDONLY | constants.O_TRUNC)); results.openTruncate = true; }
catch { results.openTruncate = false; }
try { closeSync(openSync(target.outside, "r+")); results.writeOpen = true; }
catch { results.writeOpen = false; }
try { symlinkSync(target.outside, target.outsideLink); writeFileSync(target.outsideLink, "damaged"); results.symlink = true; }
catch { results.symlink = false; }
try { chmodSync(target.outside, 0o600); results.chmod = true; }
catch { results.chmod = false; }
if (process.platform === "linux") {
  const { symbols } = dlopen("libc.so.6", {
    setxattr: { args: ["ptr", "ptr", "ptr", "i64", "i32"], returns: "i32" },
    capget: { args: ["ptr", "ptr"], returns: "i32" },
  });
  const label = Buffer.from("user.synthetic\\0");
  const pathname = Buffer.from(target.outside + "\\0");
  const value = Buffer.from("x");
  results.xattr = symbols.setxattr(ptr(pathname), ptr(label), ptr(value), value.length, 0) === 0;
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x20080522);
  const data = Buffer.alloc(24);
  results.capabilities = symbols.capget(ptr(header), ptr(data)) === 0 &&
    (data.readUInt32LE(0) !== 0 || data.readUInt32LE(12) !== 0);
}
try {
  const child = Bun.spawnSync(["/bin/sh", "-c", "echo damaged > " + target.outside], { stdout: "pipe", stderr: "pipe" });
  results.shell = child.exitCode === 0;
} catch { results.shell = false; }
try {
  const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", "require('node:fs').writeFileSync(" + JSON.stringify(target.outside) + ",'damaged')"], { stdout: "pipe", stderr: "pipe" });
  results.childBun = child.exitCode === 0;
} catch { results.childBun = false; }
if (process.platform === "linux") {
  try {
    const child = Bun.spawnSync(["/lib64/ld-linux-x86-64.so.2", target.shellCopy, "-c", "echo damaged > " + target.outside], { stdout: "pipe", stderr: "pipe" });
    results.loaderShell = child.exitCode === 0;
  } catch { results.loaderShell = false; }
}
try { const socket = await Bun.connect({ hostname: "127.0.0.1", port: target.port, socket: { data() {}, open() {}, error() {} } }); results.socket = true; socket.end(); }
catch { results.socket = false; }
try {
  const sqlite = new Database(target.db + "/legit.sqlite");
  sqlite.run("create table if not exists marker (value text)");
  sqlite.query("insert into marker values (?)").run("legitimate");
  results.sqlite = sqlite.query("select value from marker").get()?.value === "legitimate";
  sqlite.close();
} catch { results.sqlite = false; }
console.log(JSON.stringify(results));
`);

afterAll(() => { listener.stop(true); rmSync(root, { recursive: true, force: true }); });

async function run(confined: boolean) {
  rmSync(join(scratch, "preload-ran"), { force: true });
  const proc = confined
    ? copiedBox({ cmd: [process.execPath, mod], cwd: own, read: [own], write: [db], scratch })
    : Bun.spawn([process.execPath, mod], {
      cwd: own, env: { HOME: home, TMPDIR: scratch, PATH: dirname(process.execPath), BOX_CANARY: canary },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code).toBe(0);
  expect(stderr.includes(canary)).toBe(false);
  return { results: JSON.parse(stdout) as Record<string, boolean | string>, stdout };
}

function assertConfined(results: Record<string, boolean | string>) {
  // Seatbelt permits Bun children, which inherit its policy; only their host mutation is forbidden.
  for (const key of ["ssh", "envFile", "launcher", "world", "bootstrapCanary", "env", "envFileLoaded", "ambientPreload", "write", "truncate", "openTruncate", "writeOpen", "symlink", "chmod", "shell", "socket", ...(process.platform === "linux" ? ["childBun", "loaderShell", "xattr", "capabilities"] : [])]) {
    if (results[key] !== false) throw new Error(`Unexpected sandbox permission: ${key}`);
  }
  expect(results.sqlite).toBe(true);
  expect(results.imported).toBe("allowed import");
}

test("hostile mod cannot access synthetic host canaries while import and SQLite work", async () => {
  expect(boxReason()).toBeNull();
  const prior = process.env.BOX_CANARY;
  process.env.BOX_CANARY = canary;
  try {
    const { results, stdout } = await run(true);
    assertConfined(results);
    expect(stdout.includes(canary)).toBe(false);
    for (const path of [ssh, envFile, launcher, world, outside, bootstrapCanary]) expect(readFileSync(path, "utf8") === canary).toBe(true);
    expect(statSync(outside).mode & 0o777).toBe(0o644);
  } finally {
    if (prior === undefined) delete process.env.BOX_CANARY;
    else process.env.BOX_CANARY = prior;
  }
});

test("mutation check fails when same hostile mod runs without box", async () => {
  const { results } = await run(false);
  expect(() => assertConfined(results)).toThrow();
  expect(results.ambientPreload).toBe(true);
  expect(results.envFileLoaded).toBe(true);
});

test("boxed Bun retains host IPC and pipes diagnostics after confinement", async () => {
  let acknowledged = false;
  const proc = box({
    cmd: [process.execPath, "-e", "process.on('message', msg => { if (msg?.t === 'init') { process.send?.({ t: 'ack' }); process.exit(0) } }); console.log('healthy'); console.error('diagnostic')"],
    scratch,
    ipc(message) {
      if (message && typeof message === "object" && "t" in message && message.t === "ack") acknowledged = true;
    },
  });
  proc.send({ t: "init" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code).toBe(0);
  expect(acknowledged).toBe(true);
  expect(stdout.includes("healthy")).toBe(true);
  expect(stderr.includes("diagnostic")).toBe(true);
});

test("listing a world directory does not grant its sibling files", async () => {
  const worldRoot = join(root, "listing-world");
  const mods = join(worldRoot, "mods");
  mkdirSync(mods, { recursive: true });
  const privateEnv = join(worldRoot, ".env");
  writeFileSync(privateEnv, canary);
  writeFileSync(join(mods, "entry.ts"), "export const marker = 'imported';");
  const script = join(mods, "check.ts");
  writeFileSync(script, `
    import { readdirSync, readFileSync } from "node:fs";
    import { marker } from "./entry.ts";
    const world = ${JSON.stringify(worldRoot)};
    let leaked = false;
    try { leaked = readFileSync(world + "/.env", "utf8").length > 0; } catch {}
    console.log(JSON.stringify({ listed: readdirSync(world).includes("mods"), leaked, marker }));
  `);
  const proc = box({ cmd: [process.execPath, script], cwd: mods, read: [mods], list: [worldRoot], scratch });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code).toBe(0);
  expect((out + err).includes(canary)).toBe(false);
  expect(JSON.parse(out)).toEqual({ listed: true, leaked: false, marker: "imported" });
  expect(readFileSync(privateEnv, "utf8") === canary).toBe(true);
});

const signalOperations = ["rt_sigqueueinfo", "rt_tgsigqueueinfo", "F_SETOWN", "F_SETOWN_EX", "F_SETSIG"] as const;

function signalMod(operation: string, targetPid: number | "self") {
  const script = join(own, "signals.ts");
  writeFileSync(script, `
import { dlopen, ptr, read } from "bun:ffi";
import { closeSync, writeSync } from "node:fs";
const { symbols } = dlopen("libc.so.6", {
  syscall: { args: ["i64", "i64", "i64", "i64", "i64"], returns: "i64" },
  __errno_location: { args: [], returns: "ptr" },
  getuid: { args: [], returns: "u32" },
});
const nr = process.arch === "x64"
  ? { kill: 62, tgkill: 234, rt_sigqueueinfo: 129, rt_tgsigqueueinfo: 297, fcntl: 72, pipe2: 293, gettid: 186 }
  : { kill: 129, tgkill: 131, rt_sigqueueinfo: 138, rt_tgsigqueueinfo: 240, fcntl: 25, pipe2: 59, gettid: 178 };
function call(n: number, a = 0, b = 0, c = 0, d = 0) {
  const result = Number(symbols.syscall(n, a, b, c, d));
  return { result, errno: result === -1 ? read.i32(symbols.__errno_location()) : 0 };
}
const self = ${targetPid === "self"};
const target = ${targetPid === "self" ? "process.pid" : targetPid};
const operation = ${JSON.stringify(operation)};
let delivered = false;
const signal = Promise.withResolvers<void>();
process.on("SIGUSR1", () => { delivered = true; signal.resolve(); });
let outcome;
if (operation.startsWith("F_")) {
  const fds = Buffer.alloc(8);
  if (call(nr.pipe2, ptr(fds)).result !== 0) throw new Error("pipe2 failed");
  const input = fds.readInt32LE(0), output = fds.readInt32LE(4);
  try {
    // Enable async pipe notifications without changing any host-owned descriptor.
    const flags = call(nr.fcntl, input, 3);
    if (flags.result < 0 || call(nr.fcntl, input, 4, flags.result | 0x2000).result !== 0)
      throw new Error("ordinary fcntl flags failed");
    const owner = Buffer.alloc(8);
    owner.writeInt32LE(1, 0); // F_OWNER_PID, never a process group.
    owner.writeInt32LE(target, 4);
    if (operation === "F_SETSIG") call(nr.fcntl, input, 8, target);
    outcome = operation === "F_SETOWN" ? call(nr.fcntl, input, 8, target)
      : operation === "F_SETOWN_EX" ? call(nr.fcntl, input, 15, ptr(owner))
      : call(nr.fcntl, input, 10, 10); // SIGUSR1 instead of default SIGIO.
    writeSync(output, Buffer.from("synthetic"));
  } finally { closeSync(input); closeSync(output); }
} else {
  // Linux x86_64/aarch64 siginfo_t: three ints, alignment pad, then pid/uid.
  const info = Buffer.alloc(128);
  info.writeInt32LE(10, 0); // SIGUSR1
  info.writeInt32LE(-1, 8); // SI_QUEUE is required when addressing another process.
  info.writeInt32LE(process.pid, 16);
  info.writeUInt32LE(symbols.getuid(), 20);
  const tid = self ? call(nr.gettid).result : target;
  outcome = operation === "kill" ? call(nr.kill, target, 10)
    : operation === "tgkill" ? call(nr.tgkill, target, tid, 10)
    : operation === "rt_sigqueueinfo" ? call(nr.rt_sigqueueinfo, target, 10, ptr(info))
    : call(nr.rt_tgsigqueueinfo, target, tid, 10, ptr(info));
  if (self && outcome.result === 0) await signal.promise;
}
console.log(JSON.stringify({ ...outcome, delivered }));
`);
  return script;
}

for (const operation of signalOperations) {
  test.skipIf(process.platform !== "linux")(`boxed ${operation} cannot signal a synthetic victim`, async () => {
    for (const confined of [false, true]) {
      // Only this test-owned PID is ever targeted, including the unboxed positive control.
      const victim = Bun.spawn([process.execPath, "--no-env-file", "-e", `
        process.on("SIGUSR1", () => process.exit(42));
        process.on("SIGIO", () => process.exit(42));
        process.stdin.resume();
        console.log("ready");
      `], {
        cwd: scratch, env: { HOME: home, TMPDIR: scratch, PATH: dirname(process.execPath) },
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
      try {
        const reader = victim.stdout.getReader();
        const ready = await reader.read();
        reader.releaseLock();
        expect(Buffer.from(ready.value!).toString()).toBe("ready\n");
        const script = signalMod(operation, victim.pid);
        proc = confined
          ? box({ cmd: [process.execPath, script], cwd: scratch, read: [own], scratch })
          : Bun.spawn([process.execPath, "--no-env-file", script], {
            cwd: scratch, env: { HOME: home, TMPDIR: scratch, PATH: dirname(process.execPath) },
            stdin: "ignore", stdout: "pipe", stderr: "pipe",
          });
        const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        expect({ code, err }).toEqual({ code: 0, err: "" });
        expect(JSON.parse(out)).toEqual({ result: confined ? -1 : 0, errno: confined ? 1 : 0, delivered: false });
        if (confined) expect(victim.exitCode).toBeNull();
        else expect(await victim.exited).toBe(42);
      } finally {
        if (proc?.exitCode === null) proc.kill();
        if (victim.exitCode === null) victim.kill();
        await Promise.all([proc?.exited, victim.exited]);
      }
    }
  }, 15000);
}

for (const operation of ["kill", "tgkill", "rt_sigqueueinfo", "rt_tgsigqueueinfo"]) {
  test.skipIf(process.platform !== "linux")(`boxed ${operation} still delivers self signals`, async () => {
    const script = signalMod(operation, "self");
    const proc = box({ cmd: [process.execPath, script], cwd: scratch, read: [own], scratch });
    try {
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      expect(JSON.parse(out)).toEqual({ result: 0, errno: 0, delivered: true });
    } finally {
      if (proc.exitCode === null) proc.kill();
      await proc.exited;
    }
  });
}
