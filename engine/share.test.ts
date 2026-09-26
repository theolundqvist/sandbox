// A world published through the CLI, served by a stand-in GitHub, and played again on a throwaway launcher from Browse.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const dir = mkdtempSync(join(tmpdir(), "sandbox-share-"));
const LAUNCHER = 21000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${LAUNCHER}`;
const procs: Subprocess[] = [];
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.endsWith("_API_KEY")));
const HOST_TOKEN = "hosttoken-4f9a8b7c6d5e";
const VOICE_KEY = "sk_voice_0123456789abcdefghij";

/** GitHub as the launcher sees it: the marketplace list, and each repo's tarball wrapped in the folder GitHub adds. */
const repos = new Map<string, Blob>();
const github = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/worlds.json") return Response.json([{ repo: "maker/listed-world", name: "Listed", description: "On the list." }]);
    const tarball = repos.get(path.match(/^\/codeload\/(.+)\/tar\.gz\/HEAD$/)?.[1] ?? "");
    return tarball ? new Response(tarball) : new Response("404: Not Found", { status: 404 });
  },
});
const githubUrl = `http://127.0.0.1:${github.port}`;

let key: string;
const menu = async (action: string, body?: object) => {
  const res = await fetch(`${BASE}/api/menu/${action}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${key}` }, body: body && JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) };
};
const join_ = async (invite: string, name: string) => (await (await fetch(`${BASE}/api/join`, { method: "POST", body: JSON.stringify({ invite, name }) })).json()).key as string;
const tool = (player: string, name: string, args: Record<string, unknown> = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(args)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
  return fetch(`${BASE}/cli/${name}`, { method: "POST", headers: { authorization: `Bearer ${player}` }, body: form });
};

beforeAll(async () => {
  mkdirSync(join(dir, "data"));
  writeFileSync(join(dir, "data/secrets.json"), JSON.stringify({ elevenlabs: { key: VOICE_KEY, host: "https://api.elevenlabs.io" } }));
  procs.push(
    Bun.spawn(["bun", join(import.meta.dir, "launcher.ts")], {
      env: { ...env, PORT: String(LAUNCHER), SANDBOX_DATA: join(dir, "data"), SANDBOX_NO_OPEN: "1", SANDBOX_MARKET: `${githubUrl}/worlds.json`, SANDBOX_RAW: `${githubUrl}/raw`, SANDBOX_CODELOAD: `${githubUrl}/codeload`, SANDBOX_HOST_TOKEN: HOST_TOKEN },
      stdout: "ignore",
    }),
  );
  for (let i = 0; i < 100 && !(await fetch(`${BASE}/menu`).then(() => true, () => false)); i++) await Bun.sleep(100);
  ({ key } = await (await fetch(`${BASE}/api/local-key`)).json());
});

afterAll(() => {
  for (const p of procs) p.kill();
  github.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const STASH = `import type { ServerMod } from "../../api";
export default {
  load(world) {
    world.db.run("create table if not exists notes (who text, text text)");
    if (!world.db.get("select 1 from notes")) world.db.run("insert into notes values ('world', 'the well is north'), ('ana', 'hid three coins'), ('world', 'Ana was here')");
    if (!world.query("marker").length) {
      world.spawn({ marker: "well", pos: [1, 0, 1] });
      world.spawn({ marker: "chest", owner: "ana", pos: [2, 0, 2] });
      world.spawn({ marker: "note", only: ["bo"], pos: [3, 0, 3] });
    }
  },
} satisfies ServerMod;`;

test("a published world holds only what a new host needs, never a key, a recording, chat or a player's name", async () => {
  const s = await menu("create", { name: "Secret Keep", start: "basics", rules: "additive" });
  const worldDir = join(dir, "data/worlds", s.running.id);
  const ana = await join_(s.running.invite, "ana");
  await join_(s.running.invite, "bo");
  expect((await tool(ana, "write_file", { path: "mods/stash/server.ts", content: STASH })).status).toBe(200);
  expect((await tool(ana, "reload", { mod: "stash" })).status).toBe(200);
  expect((await tool(ana, "say", { text: "my secret chat line" })).status).toBe(200);

  const res = await tool(ana, "publish", { handle: "maker", description: "A well and a chest." });
  expect(res.status).toBe(200);
  const files = await new Bun.Archive(await res.bytes()).files();
  const paths = [...files.keys()].sort();
  expect(paths.every((p) => /^(world\.json|README\.md|mods\/(basics|stash)\/.+|state\/(entities|about)\.json|state\/db\/stash\.sql)$/.test(p))).toBe(true);
  expect(paths).toContain("mods/stash/server.ts");

  const config = JSON.parse(readFileSync(join(worldDir, "config.json"), "utf8"));
  const playerKeys = Object.keys(JSON.parse(readFileSync(join(worldDir, "keys.json"), "utf8")));
  const everything = (await Promise.all([...files.values()].map((f) => f.text()))).join("\n");
  for (const secret of [config.hostKey, config.invite, ...playerKeys, VOICE_KEY, HOST_TOKEN, "my secret chat line"]) expect(everything).not.toContain(secret);
  const state = (await files.get("state/entities.json")!.text()) + (await files.get("state/db/stash.sql")!.text());
  expect(state).not.toMatch(/\bana\b|\bbo\b/i);
  expect(state).toContain("the well is north");
  expect(state).toContain('"marker":"well"');
  expect(JSON.parse(await files.get("world.json")!.text())).toMatchObject({ name: "Secret Keep", description: "A well and a chest.", author: "maker", start: "basics", rules: "additive" });

  // A key a mod wrote into its code stops the whole publish.
  expect((await tool(ana, "write_file", { path: "mods/leaky/server.ts", content: `export default { load() { fetch("x", { headers: { t: "${HOST_TOKEN}" } }); } };` })).status).toBe(200);
  expect((await tool(ana, "reload", { mod: "leaky" })).status).toBe(200);
  const refused = await tool(ana, "publish", { handle: "maker", description: "x" });
  expect(refused.status).toBe(422);
  expect(await refused.text()).toContain("mods/leaky/server.ts contains what looks like a key");

  const wrapped = Object.fromEntries(await Promise.all([...files].map(async ([p, f]) => [`maker-listed-world-abc123/${p}`, await f.bytes()] as const)));
  repos.set("maker/listed-world", await new Bun.Archive(wrapped, { compress: "gzip" }).blob());
  repos.set("stranger/their-world", repos.get("maker/listed-world")!);
}, 60_000);

test("Browse lists the marketplace, and a listed world plays after one download, with its mods and state", async () => {
  const listed = await menu("browse");
  expect(listed).toMatchObject({ 0: { repo: "maker/listed-world", name: "Listed", description: "On the list.", cover: `${githubUrl}/raw/maker/listed-world/HEAD/cover.jpg` } });
  expect(await menu("check", { repo: "https://github.com/maker/listed-world.git" })).toMatchObject({ repo: "maker/listed-world", owner: "maker", listed: true });

  const s = await menu("install", { repo: "maker/listed-world" });
  expect(s.running.name).toBe("Secret Keep");
  const cy = await join_(s.running.invite, "cy");
  const status = JSON.parse((await (await tool(cy, "status")).text()).split("\n\n")[0]!);
  expect(status.rules).toStartWith("additive");
  expect(status.mods.map((m: { name: string; author: string }) => `${m.name}:${m.author}`).sort()).toEqual(["basics:maker", "stash:maker"]);
  const markers = await (await tool(cy, "query_world", { components: ["marker"] })).text();
  expect(markers).toContain('"marker":"well"');
  expect(markers).toContain("(1 matching entities)");
  const notes = await (await tool(cy, "query_db", { mod: "stash", sql: "select text from notes" })).text();
  expect(notes).toContain("the well is north");
  expect(notes).not.toContain("coins");
}, 120_000);

test("a pasted link to a world that isn't listed needs the host's trust, and a missing one says so", async () => {
  expect(await menu("check", { repo: "github.com/stranger/their-world" })).toMatchObject({ repo: "stranger/their-world", owner: "stranger", listed: false });
  const refused = await menu("install", { repo: "stranger/their-world" });
  expect(refused.error).toBe("This world runs code from stranger. Only play worlds from people you trust.");
  expect((await menu("install", { repo: "stranger/their-world", trust: true })).running.name).toBe("Secret Keep");
  expect((await menu("install", { repo: "stranger/nothing", trust: true })).error).toBe("There is no public world at github.com/stranger/nothing.");
  expect((await menu("check", { repo: "https://example.com/a/b" })).error).toStartWith("Paste a GitHub link");
}, 120_000);
