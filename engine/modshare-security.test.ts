import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";

test("a Community mod cannot install a host path supplied as an npm dependency", async () => {
  const root = mkdtempSync(join(tmpdir(), "modshare-canary-"));
  const world = join(root, "world");
  const home = join(root, "fake-home");
  const outside = join(home, "private-package");
  for (const path of [world, outside]) mkdirSync(path, { recursive: true });
  writeFileSync(join(world, "package.json"), '{"private":true}');
  writeFileSync(join(outside, "package.json"), '{"name":"private-canary","version":"1.0.0","main":"index.js"}');
  writeFileSync(join(outside, "index.js"), `module.exports = ${JSON.stringify(`CANARY-${crypto.randomUUID()}`)};`);
  const zip = zipSync({ "server.ts": new TextEncoder().encode("export default {};\n") });
  const service = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/mod.zip") return new Response(zip);
      return Response.json({ name: "garden", title: "Garden", author: "maker", packages: { "private-canary": `file:${outside}` }, zip: `http://127.0.0.1:${service.port}/mod.zip` });
    },
  });
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
      import { communityClient } from ${JSON.stringify(join(import.meta.dir, "modshare.ts"))};
      try { await communityClient(undefined, () => null).add("aaaaaaaaaaaa", undefined, ${JSON.stringify(world)}); console.log("accepted"); }
      catch (error) { console.log(error.message); process.exitCode = 42; }
    `], { cwd: root, env: { HOME: home, TMPDIR: root, PATH: process.env.PATH!, SANDBOX_COMMUNITY: `http://127.0.0.1:${service.port}` }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(42);
    expect(out + err).not.toContain("CANARY-");
    expect(existsSync(join(world, "node_modules/private-canary"))).toBe(false);
    expect(existsSync(join(world, "mods/garden"))).toBe(false);
    expect(JSON.parse(await Bun.file(join(world, "package.json")).text())).toEqual({ private: true });
  } finally {
    child?.kill();
    await child?.exited;
    service.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
