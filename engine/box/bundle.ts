// Bundles a mod's server.ts and client.ts. Bundling runs the mod's macros and reads whatever it imports, so for a mod the host runs this file in the mod sandbox (build.ts) and writes the files it prints itself; only the engine's own seed mods are bundled in the host's process.
import { dirname } from "node:path";

export type Side = "server" | "client";
/** A built file by its name next to the entry ("./client.js", "./logo-a1b2.png"), and its bytes in base64. */
export type Output = { path: string; data: string };
export type Bundled = { ok: true; sides: Partial<Record<Side, Output[]>> } | { ok: false; logs: string };

/** Starts the line that carries the result, so whatever a macro prints around it is not read as one. */
export const RESULT = "sandbox-bundle:";

export async function bundle(entries: Partial<Record<Side, string>>): Promise<Bundled> {
  const result: Partial<Record<Side, Output[]>> = {};
  // One after the other, client first: builds in a process share what they read of each package.json, and a server build read first hides a package's browser field from the client's.
  for (const side of ["client", "server"] as const) {
    if (!entries[side]) continue;
    const built = await Bun.build({
      entrypoints: [entries[side]],
      target: side === "server" ? "bun" : "browser",
      format: "esm",
      external: side === "client" ? ["three", "three/*"] : [],
      throw: false,
    });
    if (!built.success) return { ok: false, logs: built.logs.map((l) => String(l)).join("\n") };
    result[side] = await Promise.all(built.outputs.map(async (o) => ({ path: o.path, data: Buffer.from(await o.arrayBuffer()).toString("base64") })));
  }
  return { ok: true, sides: result };
}

if (import.meta.main) {
  // Counted from this process's start: Bun starting in the sandbox and loading this file.
  const boot = performance.now();
  // The sandbox starts this in a scratch folder the same depth under the temp folder every time, so the source paths in a bundle's comments, relative to it, stay the same and a mod rebuilt unchanged comes out byte for byte the same.
  const entries = JSON.parse(process.argv[2]!) as Partial<Record<Side, string>>;
  // The sandbox can't list the folders above the world. Bun's runtime resolver passes over a folder it can't list, but the bundler's fails the build on one when it looks for node_modules there, and both share one cache of folders: resolving each entry here first caches those as empty.
  for (const entry of Object.values(entries)) Bun.resolveSync(entry, dirname(entry));
  const result: Bundled = await bundle(entries).catch((e: unknown) => ({ ok: false, logs: e instanceof Error ? e.message : String(e) }));
  await Bun.write(Bun.stdout, `\n${RESULT}${JSON.stringify({ ...result, ms: { boot, bundle: performance.now() - boot } })}\n`);
  process.exit(0);
}
