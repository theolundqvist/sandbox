// Community mods end to end: a mod packed from one world's folder, published to a throwaway Community (Postgres and an S3 stand-in), then found, read and added by another world's agent tools.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { unzipSync } from "fflate";
import { startStack } from "../community/server/stack";
import { packMod } from "./modshare";

const dir = mkdtempSync(join(tmpdir(), "sandbox-mods-"));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const WORLD_KEY = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
let stack: Awaited<ReturnType<typeof startStack>>;
let world: Subprocess;
let key: string;
let account: string;

const source = join(dir, "source");
const put = (path: string, text: string) => (mkdirSync(join(source, path, ".."), { recursive: true }), writeFileSync(join(source, path), text));
const lantern = {
  "mods/lantern/server.ts": `import type { ServerMod } from "../../api";
/** Lanterns that glow at night. */
export default {
  exports: {
    /** How bright the lanterns are, 0 to 1. */
    brightness(world, at: number): number {
      return at > 0.5 ? 1 : 0.2;
    },
  },
} satisfies ServerMod;
`,
  "mods/lantern/client.ts": `import { noise } from "simplex-noise";\nimport { clock } from "../daynight/clock";\nexport default { init() {} };\n`,
  "mods/lantern/README.md": "# Lanterns\nWarm lanterns that light up when the sun goes down.\n",
  "mods/lantern/assets/note.txt": "the invite is SECRET-INVITE-123 do not share",
  "mods/lantern/node_modules/junk/index.js": "junk",
  "mods/lantern/community.json": `{"id":"aaaaaaaaaaaa"}`,
  "package.json": JSON.stringify({ dependencies: { "simplex-noise": "^4.0.3", unused: "1.0.0" } }),
};

async function tool(name: string, args: Record<string, string> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(args)) form.append(k, v);
  const res = await fetch(`${BASE}/cli/${name}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
  return { status: res.status, text: (await res.text()).split("\n\nWhen you are done")[0]! };
}
const api = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
  fetch(`${stack.api}${path}`, { method: init.method ?? (init.body ? "POST" : "GET"), body: init.body ? JSON.stringify(init.body) : undefined, headers: { "content-type": "application/json", "x-real-ip": `10.9.0.${Math.floor(Math.random() * 250)}`, ...(init.token && { authorization: `Bearer ${init.token}` }) } });

beforeAll(async () => {
  stack = await startStack();
  for (const [path, text] of Object.entries(lantern)) put(path, text);
  account = (await (await api("/accounts", { body: { email: "maker@example.com", password: "correct horse battery", username: "maker" } })).json()).token;
  const install = (await (await api("/installs", { method: "POST" })).json()).token;
  writeFileSync(join(dir, "secrets.json"), JSON.stringify({ install: { token: install, host: stack.api } }));
  const data = join(dir, "world");
  mkdirSync(data);
  writeFileSync(join(data, "config.json"), JSON.stringify({ name: "Test", rules: "open", start: "basics", invite: "test-invite", hostKey: "test-host", telemetry: WORLD_KEY }));
  world = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], { env: { ...process.env, SANDBOX_DATA: data, SANDBOX_SECRETS: join(dir, "secrets.json"), SANDBOX_COMMUNITY: stack.api, PORT: String(PORT) }, stdout: "ignore", stderr: "inherit" });
  for (let i = 0; i < 200 && !(await fetch(`${BASE}/api/info`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
  ({ key } = await (await fetch(`${BASE}/api/join`, { method: "POST", body: JSON.stringify({ invite: "test-invite", name: "builder" }) })).json());
}, 120_000);

afterAll(async () => {
  world?.kill();
  await world?.exited;
  await stack?.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 20 });
}, 30_000);

/** Publishes a packed mod the way the desktop app does: the share, the uploads to the signed URLs, then done. */
async function publish(pack: ReturnType<typeof packMod>, extra: object = {}) {
  const cover = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
  const res = await api("/mods", { token: account, body: { name: "lantern", title: "Lanterns", description: "Lanterns that glow at night.", readme: pack.readme, api: pack.api, packages: pack.packages, needs: pack.needs, engineVersion: "test", files: { zip: pack.zip.length, cover: cover.length }, ...extra } });
  expect(res.status).toBe(201);
  const { id, uploads } = await res.json();
  await fetch(uploads.zip, { method: "PUT", body: pack.zip, headers: { "content-type": "application/zip" } });
  await fetch(uploads.cover, { method: "PUT", body: cover, headers: { "content-type": "image/jpeg" } });
  expect((await api(`/worlds/${id}/done`, { method: "POST", token: account })).status).toBe(200);
  return id as string;
}

test("a packed mod carries its code, assets, README and API, without the world's secrets, node_modules or where it came from", () => {
  const pack = packMod(source, "lantern", ["SECRET-INVITE-123"]);
  const files = unzipSync(pack.zip);
  expect(Object.keys(files).sort()).toEqual(["README.md", "assets/note.txt", "client.ts", "server.ts"]);
  expect(new TextDecoder().decode(files["assets/note.txt"])).toBe("the invite is [secret] do not share");
  expect(pack.readme).toContain("light up when the sun goes down");
  expect(pack.api).toBe(`// server.ts, reached with world.use("lantern")\n/** How bright the lanterns are, 0 to 1. */\nbrightness(world, at: number): number`);
  expect(pack.packages).toEqual({ "simplex-noise": "^4.0.3" });
  expect(pack.needs).toEqual(["daynight"]);
  expect(() => packMod(source, "../etc", [])).toThrow("That isn't a mod.");
});

test("an agent searches Community, reads a mod's README and API, and adds it live; each world counts as one use", async () => {
  writeFileSync(join(source, "mods/lantern/client.ts"), "export default { init() {} };\n");
  const pack = packMod(source, "lantern", []);
  expect(pack.packages).toEqual({});
  const id = await publish(pack);

  const found = await tool("search_mods", { q: "sun goes down" });
  expect(found.status).toBe(200);
  expect(found.text).toContain(`${id}  lantern · Lanterns, by maker, 0 worlds use it, 0 upvotes\n    Lanterns that glow at night.\n    preview: http`);
  expect((await tool("search_mods", { q: "submarine" })).text).toStartWith('No Community mod matches "submarine".');

  const read = await tool("read_mod", { id: `https://sandbox.example/m/${id}` });
  expect(read.text).toContain("README:\n# Lanterns");
  expect(read.text).toContain("API:\n// server.ts, reached with world.use(\"lantern\")\n/** How bright the lanterns are, 0 to 1. */\nbrightness(world, at: number): number");
  expect((await tool("read_mod", { id: "nope" })).status).toBe(422);

  const added = await tool("add_mod", { id });
  expect(added.status).toBe(200);
  expect(added.text).toContain("Added Lanterns by maker as mods/lantern/ (README.md, assets/note.txt, client.ts, server.ts)");
  expect(added.text).toContain("lantern v1 is live");
  const tree = join(dir, "world", "world", "mods", "lantern");
  expect(JSON.parse(readFileSync(join(tree, "community.json"), "utf8"))).toMatchObject({ id, name: "lantern", author: "maker" });
  expect(readFileSync(join(tree, "server.ts"), "utf8")).toBe(lantern["mods/lantern/server.ts"]);
  expect((await (await api(`/mods/${id}`)).json()).uses).toBe(1);

  // It is a normal mod now: edited and reloaded like any other.
  writeFileSync(join(tree, "server.ts"), lantern["mods/lantern/server.ts"].replace("0.2", "0.3"));
  expect((await tool("reload", { mod: "lantern" })).text).toStartWith("lantern v2 is live");

  expect((await tool("add_mod", { id })).text).toStartWith("mods/lantern/ already exists here. Pass as=<another name>");
  expect((await tool("add_mod", { id, as: "lantern-two" })).text).toContain("as mods/lantern-two/");
  expect((await (await api(`/mods/${id}`)).json()).uses).toBe(1);

  expect((await api(`/worlds/${id}`, { method: "DELETE", token: account })).status).toBe(204);
  expect((await tool("read_mod", { id })).text).toStartWith("That mod was taken down.");
  expect(existsSync(join(tree, "server.ts"))).toBe(true);
}, 120_000);
