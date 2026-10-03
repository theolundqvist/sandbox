import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("without confinement only source-verified seeds run, forged cached builds stay held, and seeds can unload", async () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-seed-test-"));
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "seed.child.ts"), root], {
    env: { HOME: root, TMPDIR: root, PATH: process.env.PATH! },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ unavailable: true, trustedSeedRuns: true, forgedBuildRejected: true, foreignReloadRefused: true, heldStatePreserved: true, unload: true });
  } finally {
    child.kill();
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
