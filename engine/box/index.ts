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
let available: string | null | undefined;

/** A stable, plain explanation when this machine cannot safely run foreign mods. */
export function boxReason(): string | null {
  if (available !== undefined) return available;
  if (process.platform === "linux") {
    if (process.arch !== "x64" && process.arch !== "arm64") return available = "Mod sandbox requires a supported Linux CPU.";
    const loader = process.arch === "x64" ? "/lib64/ld-linux-x86-64.so.2" : "/lib/ld-linux-aarch64.so.1";
    if (!existsSync(loader)) return available = "Mod sandbox cannot find Bun's dynamic loader.";
    try {
      const probe = Bun.spawnSync(linuxArgv(ROOT, [], [], [], ["--no-env-file", `--config=${CONFIG}`, "-e", "process.exit(0)"]), {
        cwd: ROOT, env: { HOME: ROOT, TMPDIR: tmpdir(), PATH: dirname(BUN) },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      return available = probe.exitCode === 0 ? null : "Mod sandbox requires working Landlock and seccomp.";
    } catch {
      return available = "Mod sandbox requires working Landlock and seccomp.";
    }
  }
  if (process.platform === "darwin") {
    if (!existsSync("/usr/bin/sandbox-exec")) return available = "Mod sandbox requires macOS sandbox-exec.";
    try {
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-box-probe-")));
      const probe = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", macProfile([], [], [scratch]), BUN,
        "--no-env-file", `--config=${CONFIG}`, "-e", "process.exit(0)"], {
        cwd: ROOT, env: { HOME: scratch, TMPDIR: scratch, PATH: dirname(BUN) },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      return available = probe.exitCode === 0 ? null : "Mod sandbox requires working macOS sandbox-exec.";
    } catch {
      return available = "Mod sandbox requires working macOS sandbox-exec.";
    }
  }
  return available = "Mod sandbox is unavailable on this operating system.";
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
  const loader = process.arch === "x64" ? "/lib64/ld-linux-x86-64.so.2" : "/lib/ld-linux-aarch64.so.1";
  if (!existsSync(loader)) throw new Error("Mod sandbox cannot find Bun's dynamic loader.");
  const payload = Buffer.from(JSON.stringify({ bun: BUN, cwd, read: [loader, CONFIG, LOCK, ...read,
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
    available = "Mod sandbox could not apply its protections.";
    throw new Error(boxRefusal()!);
  }
  proc.exited.then((code) => {
    if (code === 125) available = "Mod sandbox could not apply its protections.";
    if (!options.scratch) rmSync(scratch, { recursive: true, force: true });
  });
  return proc;
}
