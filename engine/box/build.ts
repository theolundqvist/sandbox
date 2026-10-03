// Builds mods in the mod sandbox: bundling runs a mod's macros and reads any file a mod's source points it at.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle, RESULT, type Bundled, type Output, type Side } from "./bundle";
import { box, type BoxOptions } from "./index";

const BUNDLE = join(import.meta.dir, "bundle.ts");
/** The engine's own packages: TypeScript and the types the world's tsconfig names. Nothing in it is the host's. */
export const ENGINE_MODULES = join(import.meta.dir, "../../node_modules");
const BUILD_MS = 60_000;
/** What a build may name its files: the entry and its assets, side by side. */
const FILE = /^[\w@+-][\w@.+-]*$/;

/** Runs a command in the sandbox to its end, killed after ms. */
export async function runBoxed(options: BoxOptions, ms: number) {
  const proc = box(options);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, ms);
  const [out, err, code] = await Promise.all([
    proc.stdout instanceof ReadableStream ? new Response(proc.stdout).text() : "",
    proc.stderr instanceof ReadableStream ? new Response(proc.stderr).text() : "",
    proc.exited,
  ]);
  clearTimeout(timer);
  return { out, err, code, timedOut };
}

/**
 * What of a world a build or typecheck may read: its mods (they import each other), its installed packages, and the package.json, tsconfig.json and api.ts copy they look up.
 * Its folder is listed, never read, since Bun lists it to find those; nothing else there, such as an .env, can be opened.
 */
export function worldGrants(root: string) {
  return { read: ["mods", "node_modules", "package.json", "tsconfig.json", "api.ts"].map((name) => join(root, name)).filter(existsSync), list: [root] };
}

/** A mod's entry points: its server.ts and client.ts, whichever it has. */
function entries(dir: string) {
  const found: Partial<Record<Side, string>> = {};
  for (const side of ["server", "client"] as const) if (existsSync(join(dir, `${side}.ts`))) found[side] = join(dir, `${side}.ts`);
  return found;
}

/** Where each side's entry was written, or the build's errors. */
export type Built = Partial<Record<Side, string>> | string;
/** Where a sandboxed build's time went: Bun starting in the sandbox and loading the bundler, the bundling, and the rest: entering the sandbox, the processes starting and ending, and the answer coming back. */
export type BuildSpent = { boot: number; bundle: number; box: number };

const isOutputs = (value: unknown): value is Output[] => Array.isArray(value) && value.length > 0 && value.every((o) => typeof o?.path === "string" && typeof o?.data === "string");

/** Writes a build's files under out/<side>/, each by a plain name, never through anything already there. */
function write(result: unknown, wanted: Partial<Record<Side, string>>, out: string): Built {
  const answer = result as { ok?: unknown; logs?: unknown; sides?: Record<string, unknown> } | null;
  if (answer?.ok === false && typeof answer.logs === "string") return answer.logs;
  if (answer?.ok !== true || typeof answer.sides !== "object" || !answer.sides) return "The build answered with something that isn't a build.";
  const built: Partial<Record<Side, string>> = {};
  for (const side of Object.keys(wanted) as Side[]) {
    const outputs = answer.sides[side];
    if (!isOutputs(outputs)) return `The build made no ${side} file.`;
    const names = outputs.map((o) => o.path.replace(/^\.\//, ""));
    const bad = names.find((name) => !FILE.test(name));
    if (bad !== undefined) return `The build made a file named ${JSON.stringify(bad)}, which isn't a plain file name.`;
    mkdirSync(join(out, side), { recursive: true });
    outputs.forEach((o, i) => writeFileSync(join(out, side, names[i]!), Buffer.from(o.data, "base64"), { flag: "wx" }));
    built[side] = join(out, side, names[0]!);
  }
  return built;
}

/** Bundles a mod in the sandbox, which reads only what worldGrants allows and writes only its own scratch folder; the host writes the files it answers with under out. A build that answers fills in spent. */
export async function buildMod(root: string, dir: string, out: string, spent?: BuildSpent): Promise<Built> {
  const wanted = entries(dir);
  const scratch = mkdtempSync(join(tmpdir(), "sandbox-build-"));
  try {
    const { read, list } = worldGrants(root);
    const started = performance.now();
    const { out: stdout, err, code, timedOut } = await runBoxed({ cmd: [process.execPath, BUNDLE, JSON.stringify(wanted)], cwd: scratch, scratch, read: [BUNDLE, ...read], list }, BUILD_MS);
    const ran = performance.now() - started;
    if (timedOut) return `The build ran for over ${BUILD_MS / 1000} s and was stopped.`;
    const line = stdout.split("\n").findLast((l) => l.startsWith(RESULT));
    if (!line) return `The build stopped before it finished${code ? ` (exit code ${code})` : ""}:\n${err.trim().slice(-2000)}`;
    let result: unknown;
    try {
      result = JSON.parse(line.slice(RESULT.length));
    } catch {
      return "The build answered with something that isn't a build.";
    }
    const timing = typeof result === "object" && result !== null && "ms" in result && typeof result.ms === "object" && result.ms !== null ? result.ms : {};
    const boot = "boot" in timing ? timing.boot : undefined;
    const bundling = "bundle" in timing ? timing.bundle : undefined;
    if (spent && typeof boot === "number" && typeof bundling === "number") Object.assign(spent, { boot, bundle: bundling, box: ran - boot - bundling });
    return write(result, wanted, out);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Bundles one of the engine's seed mods in this process, from the engine's own copy: for a world whose seed mod is unchanged, and a computer without the sandbox, where only those run. */
export async function buildSeed(dir: string, out: string): Promise<Built> {
  const wanted = entries(dir);
  const result: Bundled = await bundle(wanted);
  return write(result, wanted, out);
}
