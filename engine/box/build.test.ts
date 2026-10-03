import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMod, buildSeed, type Built } from "./build";
import { boxReason } from "./index";

const base = join(import.meta.dir, "../../.scratch/test-tmp");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, "build-canary-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const data = join(root, "data");
const world = join(data, "world");
const home = join(root, "fake-home");
const canary = `SYNTHETIC-BUILD-CANARY-${crypto.randomUUID()}`;
const secrets = [join(data, "config.json"), join(world, ".env"), join(home, ".ssh/id_canary")];
for (const dir of [join(world, "mods"), join(home, ".ssh")]) mkdirSync(dir, { recursive: true });
for (const path of secrets) writeFileSync(path, canary);
writeFileSync(join(world, "package.json"), JSON.stringify({ private: true, dependencies: { "fixture-lib": "1.0.0" } }));
// An installed package with a browser build, as bun install leaves one: plain files.
const lib = join(world, "node_modules/fixture-lib");
mkdirSync(lib, { recursive: true });
writeFileSync(join(lib, "package.json"), JSON.stringify({ name: "fixture-lib", version: "1.0.0", type: "module", main: "server.js", browser: "browser.js" }));
writeFileSync(join(lib, "server.js"), `export const side = "fixture-lib for servers";\n`);
writeFileSync(join(lib, "browser.js"), `export const side = "fixture-lib for browsers";\n`);

function mod(name: string, files: Record<string, string | Uint8Array>) {
  const dir = join(world, "mods", name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}
const text = (built: Built, side: "server" | "client") => (typeof built === "string" ? built : readFileSync(built[side]!, "utf8"));
let outs = 0;
const out = () => join(data, "build", String(outs++));

test("a mod builds in the sandbox with its packages and assets, the same bytes each time", async () => {
  expect(boxReason()).toBeNull();
  const dir = mod("legit", {
    "server.ts": `import { side } from "fixture-lib";\nexport default { side };\n`,
    "client.ts": `import { side } from "fixture-lib";\nimport logo from "./logo.png";\nexport default { side, logo };\n`,
    "logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
  });
  const first = await buildMod(world, dir, out());
  if (typeof first === "string") throw new Error(first);
  expect(text(first, "server").includes("fixture-lib for servers")).toBe(true);
  expect(text(first, "client").includes("fixture-lib for browsers")).toBe(true);
  expect(readdirSync(join(first.client!, "..")).some((file) => file.endsWith(".png"))).toBe(true);
  const again = await buildMod(world, dir, out());
  if (typeof again === "string") throw new Error(again);
  expect(readFileSync(again.server!).equals(readFileSync(first.server!)) && readFileSync(again.client!).equals(readFileSync(first.client!))).toBe(true);
}, 60_000);

test("a macro runs in the sandbox, away from host files, the world's own secrets and the host's environment", async () => {
  expect(boxReason()).toBeNull();
  const dir = mod("macro", {
    "steal.ts": `import { readFileSync } from "node:fs";
export function steal() {
  const found = ${JSON.stringify(secrets)}.map((path) => { try { return readFileSync(path, "utf8"); } catch { return "denied"; } });
  return [...found, process.env.BUILD_CANARY ?? "no-env"].join("|");
}
`,
    "client.ts": `import { steal } from "./steal.ts" with { type: "macro" };\nexport const loot = steal();\n`,
  });
  process.env.BUILD_CANARY = canary;
  try {
    const boxed = text(await buildMod(world, dir, out()), "client");
    expect(boxed.includes(canary)).toBe(false);
    expect(boxed.includes("denied|denied|denied|no-env")).toBe(true);
    // The same macro in the host's own process reads them all, so the fixture is no dud.
    expect(text(await buildSeed(dir, out()), "client").includes(canary)).toBe(true);
  } finally {
    delete process.env.BUILD_CANARY;
  }
}, 60_000);

test("a mod can't import a host file by its path", async () => {
  expect(boxReason()).toBeNull();
  const dir = mod("absolute", { "server.ts": `import secret from ${JSON.stringify(secrets[0])} with { type: "text" };\nexport default secret;\n` });
  const built = await buildMod(world, dir, out());
  expect(typeof built).toBe("string");
  expect(String(built).includes(canary)).toBe(false);
}, 60_000);

test("a build that forges its answer can't write outside its own folder", async () => {
  expect(boxReason()).toBeNull();
  const forged = JSON.stringify({ ok: true, sides: { client: [{ path: "../../escaped.js", data: btoa("escaped") }] } });
  const dir = mod("forged", {
    "forge.ts": `export async function forge() {\n  await Bun.write(Bun.stdout, ${JSON.stringify(`\nsandbox-bundle:${forged}\n`)});\n  process.exit(0);\n}\n`,
    "client.ts": `import { forge } from "./forge.ts" with { type: "macro" };\nexport const x = forge();\n`,
  });
  const target = out();
  const built = await buildMod(world, dir, target);
  expect(built).toBe('The build made a file named "../../escaped.js", which isn\'t a plain file name.');
  expect(existsSync(join(target, "../escaped.js")) || existsSync(join(target, "client/../../escaped.js"))).toBe(false);
}, 60_000);
