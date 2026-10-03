import { closeSync, constants, createReadStream, fstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Loaded by path at run time, so the shipped runner bundle uses the engine's own box beside it. */
const { shellBox }: typeof import("../box") = await import(join(import.meta.dir, "../box/index.ts"));

export const TOOL_NAMES = ["box_bash", "box_read", "box_write", "box_edit", "box_grep", "box_read_image"] as const;

/** The player's world as the runner reaches it: the world server's address and this player's key for its CLI. */
export type World = { base: string; key: string; name: string };

/** The runner's private folder for one agent: the world's code (`world/`), the box's home (`scratch/`), the channel to the world and the `world` command. */
export type Run = { dir: string; world: string; scratch: string; channel: string; bin: string };

export function makeRun(dir: string): Run {
  const run = { dir, world: join(dir, "world"), scratch: join(dir, "scratch"), channel: join(dir, "channel"), bin: join(dir, "bin") };
  for (const d of [dir, run.world, run.scratch, join(run.scratch, "tmp"), run.channel, run.bin, join(dir, "taken")]) mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(join(run.bin, "world"), WORLD_COMMAND, { mode: 0o700 });
  return run;
}

const LIVE = new Set<number>();

/** Kills every box this runner started, and everything they started. */
export function killBoxes() {
  for (const pid of LIVE) killGroup(pid);
}

function killGroup(pid: number) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
  LIVE.delete(pid);
}

type Shell = { stdout: Buffer; stderr: Buffer; code: number | null; timedOut: boolean };

/** Runs a script in a shell box over the run's world folder and kills whatever it left running. */
export async function inBox(run: Run, script: string, opts: { env?: Record<string, string>; stdin?: Uint8Array; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Shell> {
  const proc = shellBox({
    script,
    cwd: run.world,
    write: [run.world, run.scratch, run.channel],
    run: [run.bin],
    stdin: opts.stdin,
    env: {
      PATH: [run.bin, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
      HOME: run.scratch,
      TMPDIR: join(run.scratch, "tmp"),
      LANG: "C.UTF-8",
      TERM: "dumb",
      GIT_CONFIG_NOSYSTEM: "1",
      SANDBOX_CHANNEL: run.channel,
      ...opts.env,
    },
  });
  LIVE.add(proc.pid);
  let timedOut = false;
  const stop = () => killGroup(proc.pid);
  const timer = setTimeout(() => ((timedOut = true), stop()), opts.timeoutMs ?? 120_000);
  opts.signal?.addEventListener("abort", stop);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).arrayBuffer(), proc.exited]);
    return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), code, timedOut };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", stop);
    stop();
  }
}

const MAX_OUTPUT = 30_000;
const clip = (text: string) => (text.length > MAX_OUTPUT ? `(first ${text.length - MAX_OUTPUT} characters cut)\n${text.slice(-MAX_OUTPUT)}` : text);

async function file(run: Run, path: string, signal?: AbortSignal) {
  const r = await inBox(run, 'cat -- "$P"', { env: { P: path }, signal });
  if (r.code !== 0) throw new Error(r.stderr.toString().trim() || `Cannot read ${path}.`);
  return r.stdout;
}

async function writeFile(run: Run, path: string, content: string, signal?: AbortSignal) {
  const r = await inBox(run, 'mkdir -p -- "$(dirname -- "$P")" && cat > "$P"', { env: { P: path }, stdin: Buffer.from(content), signal });
  if (r.code !== 0) throw new Error(r.stderr.toString().trim() || `Cannot write ${path}.`);
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const IMAGE_TYPES: [string, (b: Buffer) => boolean][] = [
  ["image/png", (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", (b) => b.subarray(0, 4).toString("latin1") === "GIF8"],
  ["image/webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
];
const MAX_IMAGE = 3_750_000;

/** The agent's only tools: each runs in a shell box over the world's private copy, so the kernel, not these functions, decides what they reach. */
export function boxTools(run: Run) {
  const tool = (name: (typeof TOOL_NAMES)[number], description: string, properties: Record<string, object>, required: string[], execute: (params: any, signal?: AbortSignal) => Promise<any>) => ({
    name,
    label: name.slice(4).replace("_", " "),
    description,
    loadMode: "essential" as const,
    parameters: { type: "object", properties, required, additionalProperties: false } as any,
    execute: (_id: string, params: any, _update: unknown, _ctx: unknown, signal?: AbortSignal) => execute(params, signal),
  });
  return [
    tool(
      "box_bash",
      "Run a bash command in the world's code folder. It has coreutils, grep, sed, git and the `world` command, no network, and stops after timeout seconds (default 120). Background processes stop when the command ends.",
      { command: { type: "string" }, timeout: { type: "number", description: "Seconds, at most 600." } },
      ["command"],
      async ({ command, timeout }, signal) => {
        const r = await inBox(run, `exec 2>&1\n${command}`, { timeoutMs: Math.min(Math.max(Number(timeout) || 120, 1), 600) * 1000, signal });
        const out = clip(r.stdout.toString());
        return text(`${out}${out.endsWith("\n") || !out ? "" : "\n"}${r.timedOut ? "(stopped: timed out)" : `(exit ${r.code})`}`);
      },
    ),
    tool(
      "box_read",
      "Read a text file, with line numbers. offset is the first line (1-based), limit the number of lines (default 2000).",
      { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } },
      ["path"],
      async ({ path, offset, limit }, signal) => {
        const lines = (await file(run, path, signal)).toString().split("\n");
        const from = Math.max(Number(offset) || 1, 1);
        const shown = lines.slice(from - 1, from - 1 + (Number(limit) || 2000));
        return text(clip(shown.map((l, i) => `${from + i}\t${l}`).join("\n")) + (from - 1 + shown.length < lines.length ? `\n(${lines.length} lines in all)` : ""));
      },
    ),
    tool("box_write", "Create or overwrite a file, making its folders.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"], async ({ path, content }, signal) => {
      await writeFile(run, path, content, signal);
      return text(`Wrote ${path}.`);
    }),
    tool(
      "box_edit",
      "Replace old_string with new_string in a file. old_string must occur exactly once unless replace_all is true.",
      { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } },
      ["path", "old_string", "new_string"],
      async ({ path, old_string, new_string, replace_all }, signal) => {
        const before = (await file(run, path, signal)).toString();
        const count = old_string ? before.split(old_string).length - 1 : 0;
        if (count === 0) throw new Error(`old_string is not in ${path}.`);
        if (count > 1 && !replace_all) throw new Error(`old_string occurs ${count} times in ${path}; add context or set replace_all.`);
        await writeFile(run, path, replace_all ? before.replaceAll(old_string, () => new_string) : before.replace(old_string, () => new_string), signal);
        return text(`Edited ${path} (${replace_all ? count : 1} replacement${count > 1 && replace_all ? "s" : ""}).`);
      },
    ),
    tool(
      "box_grep",
      "Search files for an extended regular expression, recursively from path (default the world folder). glob limits it to matching file names.",
      { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, ignore_case: { type: "boolean" } },
      ["pattern"],
      async ({ pattern, path, glob, ignore_case }, signal) => {
        const r = await inBox(run, `grep -rnIE --exclude-dir=.git ${ignore_case ? "-i " : ""}${glob ? '--include="$G" ' : ""}-e "$Q" -- "$P"`, { env: { Q: pattern, P: path || ".", G: glob ?? "" }, signal });
        if (r.code === 1) return text("No matches.");
        if (r.code !== 0) throw new Error(r.stderr.toString().trim());
        return text(clip(r.stdout.toString()));
      },
    ),
    tool("box_read_image", "Look at an image file (PNG, JPEG, GIF or WebP), such as the path `world screenshot` prints.", { path: { type: "string" } }, ["path"], async ({ path }, signal) => {
      const bytes = await file(run, path, signal);
      if (bytes.length > MAX_IMAGE) throw new Error(`${path} is ${bytes.length} bytes; images can be at most ${MAX_IMAGE}.`);
      const mimeType = IMAGE_TYPES.find(([, is]) => is(bytes))?.[0];
      if (!mimeType) throw new Error(`${path} is not a PNG, JPEG, GIF or WebP image.`);
      return { content: [{ type: "text" as const, text: path }, { type: "image" as const, data: bytes.toString("base64"), mimeType }] };
    }),
  ];
}

/** The box's `world` command: it leaves each call as a folder in the channel, names it on the requests FIFO and reads the answer from its own reply FIFO. */
const WORLD_COMMAND = `#!/bin/bash
set -eu
c=$SANDBOX_CHANNEL
[ $# -gt 0 ] || set -- help
case $1 in *[!a-z_]*|'') echo "Unknown tool $1. Run world alone to list the tools." >&2; exit 2 ;; esac
id=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n')
d=$c/$id
mkdir "$d" "$d/text" "$d/files"
printf %s "$1" > "$d/tool"
shift
for arg do
  case $arg in *=*) ;; *) echo "Arguments are name=value, got: $arg" >&2; exit 2 ;; esac
  n=\${arg%%=*}
  v=\${arg#*=}
  case $n in *[!a-z_]*|'') echo "Argument names are lowercase, got: $n" >&2; exit 2 ;; esac
  case $v in
    -) cat > "$d/files/$n" ;;
    @*) if [ -f "\${v#@}" ]; then cat -- "\${v#@}" > "$d/files/$n"; else printf %s "$v" > "$d/text/$n"; fi ;;
    *) printf %s "$v" > "$d/text/$n" ;;
  esac
done
mkfifo "$c/$id.out"
trap 'rm -f "$c/$id.out"' EXIT
echo "$id" > "$c/requests"
exec 3< "$c/$id.out"
read -r status type <&3
if [ "$type" = image/jpeg ]; then
  out=\${TMPDIR:-/tmp}/screenshot-$id.jpg
  cat <&3 > "$out"
  echo "$out"
else
  cat <&3
fi
[ "$status" = 200 ]
`;

const KEEP_LISTENING = "\n\nWhen you are done with this, call wait_for_chat again. Never end your turn.\n";
const MAX_REQUEST = 32 * 1024 * 1024;

/** Reads a file the box left, refusing anything but a plain file of its own. */
function boxFile(path: string, budget: { left: number }) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > budget.left) throw new Error("bad request file");
    budget.left -= st.size;
    const buf = Buffer.alloc(st.size);
    let at = 0;
    while (at < st.size) {
      const n = readSync(fd, buf, at, st.size - at, at);
      if (n === 0) break;
      at += n;
    }
    return buf.subarray(0, at);
  } finally {
    closeSync(fd);
  }
}

/** Takes a call the box left: moves its folder where the box can't write, then reads it. */
function takeCall(run: Run, id: string) {
  const held = join(run.dir, "taken", id);
  renameSync(join(run.channel, id), held);
  try {
    const budget = { left: MAX_REQUEST };
    const tool = boxFile(join(held, "tool"), budget).toString();
    if (!/^[a-z_]{1,40}$/.test(tool)) throw new Error("bad tool");
    const args: { name: string; value: Buffer; file: boolean }[] = [];
    for (const file of [false, true])
      for (const name of readdirSync(join(held, file ? "files" : "text"))) {
        if (!/^[a-z_]{1,40}$/.test(name)) throw new Error("bad argument");
        args.push({ name, value: boxFile(join(held, file ? "files" : "text", name), budget), file });
      }
    return { tool, args };
  } finally {
    rmSync(held, { recursive: true, force: true });
  }
}

async function reply(run: Run, id: string, status: number, type: string, body: Buffer) {
  const path = join(run.channel, `${id}.out`);
  const until = Date.now() + 10_000;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (e: any) {
      if (e.code !== "ENXIO" || Date.now() > until) return;
      await Bun.sleep(5);
    }
  }
  try {
    if (!fstatSync(fd).isFIFO()) return;
    const data = Buffer.concat([Buffer.from(`${status} ${type}\n`), body]);
    let at = 0;
    while (at < data.length) {
      try {
        at += writeSync(fd, data, at);
      } catch (e: any) {
        if (e.code !== "EAGAIN" || Date.now() > until + 50_000) return;
        await Bun.sleep(2);
      }
    }
  } finally {
    closeSync(fd);
  }
}

/** Serves the box's world calls until `signal` aborts: each goes to the world server as this player, and base hashes the box's copy read are filled in. */
export function serveWorld(run: Run, world: World, hashes: Map<string, string>, signal: AbortSignal) {
  const requests = join(run.channel, "requests");
  const made = Bun.spawnSync(["mkfifo", "-m", "600", requests]);
  if (made.exitCode !== 0) throw new Error(`Cannot make the world channel: ${made.stderr.toString()}`);
  const stream = createReadStream(requests, { fd: openSync(requests, constants.O_RDWR) });
  signal.addEventListener("abort", () => stream.destroy());
  const lines = createInterface({ input: stream });
  lines.on("line", (id) => {
    if (/^[0-9a-f]{16}$/.test(id)) handle(id).catch(() => {});
  });
  async function handle(id: string) {
    let call;
    try {
      call = takeCall(run, id);
    } catch {
      return reply(run, id, 400, "text/plain", Buffer.from("The world command could not read this call.\n"));
    }
    const { status, type, body } = await callWorld(world, call.tool, call.args, hashes, signal).catch((e) => ({ status: 502, type: "text/plain", body: Buffer.from(`The world did not answer: ${e.message}\n`) }));
    await reply(run, id, status, type, body);
  }
}

async function callWorld(world: World, tool: string, args: { name: string; value: Buffer; file: boolean }[], hashes: Map<string, string>, signal: AbortSignal) {
  const auth = { authorization: `Bearer ${world.key}` };
  const path = args.find((a) => a.name === "path")?.value.toString();
  let res: Response;
  if (tool === "help") res = await fetch(`${world.base}/cli/help`, { headers: auth, signal });
  else {
    const form = new FormData();
    for (const a of args) {
      if (a.file) form.append(a.name, new Blob([new Uint8Array(a.value)]), a.name);
      else form.append(a.name, a.value.toString());
    }
    if ((tool === "write_file" || tool === "edit_file") && path && !form.has("base_hash") && hashes.has(path)) form.append("base_hash", hashes.get(path)!);
    res = await fetch(`${world.base}/cli/${tool}`, { method: "POST", headers: auth, body: form, signal });
  }
  const type = res.headers.get("content-type")?.startsWith("image/jpeg") ? "image/jpeg" : "text/plain";
  const body = Buffer.from(await res.arrayBuffer());
  if (type !== "text/plain") return { status: res.status, type, body };
  const answer = body.toString().replace(KEEP_LISTENING, "\n");
  const hash = (tool === "read_file" ? answer.match(/^hash: (\S+)/) : answer.match(/New hash: ([^\s.]+)/))?.[1];
  if (res.ok && path && hash) hashes.set(path, hash);
  return { status: res.status, type, body: Buffer.from(answer) };
}

/** Copies the world's code into the run's world folder (text files; assets stay on the world) and records each file's hash for its first write. */
export async function cloneWorld(run: Run, world: World, hashes: Map<string, string>) {
  const auth = { authorization: `Bearer ${world.key}` };
  const post = async (tool: string, fields: Record<string, string> = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const res = await fetch(`${world.base}/cli/${tool}`, { method: "POST", headers: auth, body: form });
    const body = await res.text();
    if (!res.ok) throw new Error(body.replace(KEEP_LISTENING, "").trim());
    return body;
  };
  const listing = (await post("list_files")).replace(KEEP_LISTENING, "").trim();
  const files = listing
    .split("\n")
    .map((l) => l.split(/\s+/)[0]!)
    .filter((p) => p && !/^mods\/[^/]+\/assets\//.test(p) && !p.split("/").some((s) => s === ".." || s === "" || s === ".git"));
  for (let i = 0; i < files.length; i += 8)
    await Promise.all(
      files.slice(i, i + 8).map(async (path) => {
        const body = await post("read_file", { path });
        const hash = body.match(/^hash: (\S+)\n/);
        if (!hash) return;
        hashes.set(path, hash[1]!);
        mkdirSync(join(run.world, path, ".."), { recursive: true });
        writeFileSync(join(run.world, path), body.slice(hash[0].length));
      }),
    );
  if (Bun.which("git")) {
    const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=Sandbox", "-c", "user.email=agent@sandbox.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: run.world, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", HOME: run.scratch } });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", `${world.name} as the agent started`);
  }
  return files.length;
}
