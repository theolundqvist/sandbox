import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export type BoxOptions = {
  cmd: string[];
  cwd?: string;
  read?: string[];
  list?: string[];
  write?: string[];
  scratch?: string;
  ipc?: (message: unknown, subprocess: Bun.Subprocess) => void;
};

const ROOT = dirname(import.meta.path);
const BUN = realpathSync(process.execPath);
const CONFIG = join(ROOT, "bunfig.toml");
const CHILD = join(ROOT, "child.ts");
const LOCK = join(ROOT, "lock.ts");
const CLEAN_ENV = { PATH: dirname(BUN) };
const LOADER = process.arch === "x64" ? "/lib64/ld-linux-x86-64.so.2" : "/lib/ld-linux-aarch64.so.1";
/** Why mods can't run in the box here, or null when they can; undefined until something asks. */
let available: string | null | undefined;
/** Counts decisions, so the startup probe never overwrites one made after it started. */
let generation = 0;
/** The startup probe running in the background, if any. */
let probing: Promise<void> | undefined;

function decide(reason: string | null) {
  generation++;
  return (available = reason);
}

type Probe = { argv: string[]; env: Record<string, string>; scratch: string };
const PROBE_IO = { cwd: ROOT, stdin: "ignore", stdout: "ignore", stderr: "ignore" } as const;

/** The trusted probe this platform runs, a Bun in the box that only exits 0, in a scratch folder of its own; or why there is none to run. */
function plan(): string | Probe {
  if (process.platform === "linux") {
    if (process.arch !== "x64" && process.arch !== "arm64") return "Mod sandbox requires a supported Linux CPU.";
    if (!existsSync(LOADER)) return "Mod sandbox cannot find Bun's dynamic loader.";
  } else if (process.platform === "darwin") {
    if (!existsSync("/usr/bin/sandbox-exec")) return "Mod sandbox requires macOS sandbox-exec.";
  } else return "Mod sandbox is unavailable on this operating system.";
  let scratch: string | undefined;
  try {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-box-probe-")));
    const cmd = ["--no-env-file", `--config=${CONFIG}`, "-e", "process.exit(0)"];
    const argv = process.platform === "linux" ? linuxArgv(ROOT, [], [], [scratch], cmd) : ["/usr/bin/sandbox-exec", "-p", macProfile([], [], [scratch]), BUN, ...cmd];
    return { argv, env: { ...CLEAN_ENV, HOME: scratch, TMPDIR: scratch }, scratch };
  } catch {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    return verdict(null)!;
  }
}

/** Only a probe that exited cleanly shows the protections applied. */
function verdict(code: number | null) {
  if (code === 0) return null;
  return process.platform === "linux" ? "Mod sandbox requires working Landlock and seccomp." : "Mod sandbox requires working macOS sandbox-exec.";
}

function probeNow(): string | null {
  const probe = plan();
  if (typeof probe === "string") return probe;
  try {
    return verdict(Bun.spawnSync(probe.argv, { ...PROBE_IO, env: probe.env }).exitCode);
  } catch {
    return verdict(null);
  } finally {
    rmSync(probe.scratch, { recursive: true, force: true });
  }
}

async function probeLater(): Promise<string | null> {
  const probe = plan();
  if (typeof probe === "string") return probe;
  try {
    return verdict(await Bun.spawn(probe.argv, { ...PROBE_IO, env: probe.env }).exited);
  } catch {
    return verdict(null);
  } finally {
    rmSync(probe.scratch, { recursive: true, force: true });
  }
}

/** A stable, plain explanation when this machine cannot safely run foreign mods. Probes now, blocking, when nothing has yet. */
export function boxReason(): string | null {
  return available !== undefined ? available : decide(probeNow());
}

/** Probes in the background, once, so the server sets up meanwhile and then asks boxReason without waiting. Never rejects. */
export async function prepareBox(): Promise<void> {
  if (available !== undefined) return;
  const started = generation;
  await (probing ??= probeLater()
    .catch(() => verdict(null))
    .then((reason) => {
      if (generation === started) decide(reason);
    }));
}

/** The refusal shown to the host, unchanged across initial load and reload. */
export function boxRefusal(): string | null {
  const reason = boxReason();
  return reason && `Mods can't run safely on this computer (${reason[0]!.toLowerCase()}${reason.slice(1).replace(/\.$/, "")}), so only the engine's unchanged starter mods run in this world.`;
}


function paths(paths: string[]) {
  return [...new Set(paths.map(path => {
    if (path.includes("\0")) throw new Error("Mod sandbox path contains a NUL byte.");
    const absolute = resolve(path);
    if (!existsSync(absolute)) throw new Error("Mod sandbox path does not exist.");
    return realpathSync(absolute);
  }))];
}

function macRule(path: string) {
  const escaped = path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return statSync(path).isDirectory() ? `(subpath "${escaped}")` : `(literal "${escaped}")`;
}

function linuxArgv(cwd: string, read: string[], list: string[], write: string[], cmd: string[]) {
  if (!existsSync(LOADER)) throw new Error("Mod sandbox cannot find Bun's dynamic loader.");
  const payload = Buffer.from(JSON.stringify({ bin: BUN, cwd, exec: [], read: [LOADER, CONFIG, LOCK, ...read,
    "/usr/lib", "/lib", "/etc/ssl/certs", "/dev/null", "/dev/urandom",
    "/proc/self/maps", "/proc/self/cgroup"].filter(existsSync),
    list: [ROOT, ...list],
    write: [...write, "/dev/null"],
    cmd: [...cmd.slice(0, 2), `--preload=${LOCK}`, ...cmd.slice(2)] })).toString("base64url");
  return [BUN, "--no-env-file", `--config=${CONFIG}`, CHILD, payload];
}

function macProfile(read: string[], list: string[], write: string[]) {
  const system = ["/System/Library", "/private/var/db/timezone", "/usr/lib", "/dev/null", "/dev/urandom"];
  return ["(version 1)", "(deny default)", "(allow process-fork)",
    `(allow process-exec (literal "${BUN.replaceAll('"', '\\"')}"))`,
    '(allow file-read* (literal "/"))',
    "(allow file-read-metadata)",
    ...[BUN, CONFIG, ...read, ...system.filter(existsSync)].map(path => `(allow file-read* ${macRule(path)})`),
    ...[ROOT, ...list].map(path => `(allow file-read-data (literal "${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"))`),
    ...[...write, "/dev/null"].map(path => `(allow file-read* file-write* ${macRule(path)})`),
    "(allow sysctl-read)"].join("\n");
}


export type ShellBoxOptions = {
  script: string;
  cwd: string;
  /** Folders the shell may change. */
  write: string[];
  /** Files it may read and run besides the system's programs. */
  run?: string[];
  env: Record<string, string>;
  stdin?: Uint8Array;
};

const SHELL = "/bin/bash";
/** The system's programs and libraries, readable and runnable in a shell box: nothing there is the player's. Bun is not: seccomp lets only the box's first process signal itself, and Bun aborts without that. */
const PROGRAMS = ["/usr", "/bin", "/lib", "/lib64", "/sbin", "/opt/homebrew", "/usr/local"];
const DEVICES = ["/dev/null", "/dev/zero", "/dev/urandom", "/dev/random"];

function macShellProfile(run: string[], write: string[]) {
  const quoted = (path: string) => `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const programs = [...PROGRAMS, "/System/Library", "/Library/Developer/CommandLineTools", "/private/var/db/dyld", "/private/var/db/timezone"].filter(existsSync).map(path => `(subpath ${quoted(realpathSync(path))})`);
  const files = run.map(macRule);
  return ["(version 1)", "(deny default)", "(allow process-fork)",
    `(allow process-exec ${[...programs, ...files].join(" ")})`,
    `(allow file-read* (literal "/") ${[...programs, ...files].join(" ")} ${DEVICES.filter(existsSync).map(path => `(literal ${quoted(path)})`).join(" ")})`,
    "(allow file-read-metadata)",
    ...[...write, "/dev/null"].map(path => `(allow file-read* file-write* ${macRule(path)})`),
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)"].join("\n");
}

/** Bash that can run the system's programs, change only `write`, reach no network and never leave its process group (kill -pid stops it all). */
export function shellBox(options: ShellBoxOptions): Bun.Subprocess<"ignore" | Uint8Array, "pipe", "pipe"> {
  const refusal = boxReason();
  if (refusal) throw new Error(refusal);
  const write = paths(options.write);
  const run = paths(options.run ?? []);
  const blocked = [sep, realpathSync(join(ROOT, "../..")), realpathSync(process.env.HOME || ROOT)];
  if ([...write, ...run].some(path => blocked.includes(path))) throw new Error("Mod sandbox requires narrow filesystem grants.");
  const cwd = realpathSync(options.cwd);
  const io = { env: options.env, stdin: options.stdin ?? "ignore", stdout: "pipe", stderr: "pipe", detached: true } as const;
  const cmd = ["--noprofile", "--norc", "-c", options.script];
  if (process.platform === "darwin") return Bun.spawn(["/usr/bin/sandbox-exec", "-p", macShellProfile(run, write), SHELL, ...cmd], { ...io, cwd });
  const payload = Buffer.from(JSON.stringify({
    bin: SHELL, cwd, list: [],
    read: [LOADER, ...DEVICES, "/etc/ssl/certs", "/etc/localtime", "/proc/self/maps", "/proc/self/cgroup"].filter(existsSync),
    write: [...write, "/dev/null"],
    exec: [...PROGRAMS.filter(existsSync).map(path => realpathSync(path)), ...run],
    cmd,
  })).toString("base64url");
  return Bun.spawn([BUN, "--no-env-file", `--config=${CONFIG}`, CHILD, payload], { ...io, cwd: ROOT });
}

/** Start a Bun process with no ambient environment, filesystem grants or network access. */
export function box(options: BoxOptions): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  const refusal = boxRefusal();
  if (refusal) throw new Error(refusal);
  if (!options.cmd.length || realpathSync(options.cmd[0]!) !== BUN) {
    throw new Error("Mod sandbox can only execute Bun.");
  }
  const cwd = realpathSync(options.cwd ?? ROOT);
  const scratch = options.scratch ? realpathSync(options.scratch) : mkdtempSync(join(tmpdir(), "sandbox-box-"));
  const read = paths(options.read ?? []);
  const list = paths(options.list ?? []);
  if (list.some(path => !statSync(path).isDirectory())) throw new Error("Mod sandbox list grants require directories.");
  const write = paths([...(options.write ?? []), scratch]);
  const blocked = [sep, realpathSync(join(ROOT, "../..")), realpathSync(process.env.HOME || ROOT)];
  if ([...read, ...list, ...write].some(path => blocked.includes(path))) {
    throw new Error("Mod sandbox requires narrow filesystem grants.");
  }
  const env = { ...CLEAN_ENV, HOME: scratch, TMPDIR: scratch };
  const cmd = ["--no-env-file", `--config=${CONFIG}`, ...options.cmd.slice(1)];
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    if (process.platform === "linux") {
      proc = Bun.spawn(linuxArgv(cwd, read, list, write, cmd), {
        cwd: ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(options.ipc ? { ipc: options.ipc } : {}),
      });
    } else {
      proc = Bun.spawn(["/usr/bin/sandbox-exec", "-p", macProfile(read, list, write), BUN, ...cmd], {
        cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(options.ipc ? { ipc: options.ipc } : {}),
      });
    }
  } catch {
    if (!options.scratch) rmSync(scratch, { recursive: true, force: true });
    decide("Mod sandbox could not apply its protections.");
    throw new Error(boxRefusal()!);
  }
  // Registered before the caller gets the process, so this runs ahead of the caller's own exit handlers, which then read the answer from boxRefusal().
  proc.exited.then((code) => {
    // 125 is the code for protections the box couldn't apply, and mod code can exit with it too: a fresh trusted probe decides which it was. A box that failed stays failed.
    if (code === 125 && !available) decide(probeNow());
    if (!options.scratch) rmSync(scratch, { recursive: true, force: true });
  });
  return proc;
}
