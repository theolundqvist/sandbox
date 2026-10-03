// A throwaway world's add_asset and the files it serves: a builder's url reaches only the public internet, a model is served from the world's own origin as what it is, and assets travel with the world.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { unzipSync } from "fflate";

const dir = mkdtempSync(join(tmpdir(), "sandbox-assets-"));
const data = join(dir, "data");
/** The smallest real binary glTF: the glTF 2.0 header, then one JSON chunk with a scene holding one empty node. */
const GLB = new Uint8Array([...Buffer.from("glTF"), 2, 0, 0, 0, 112, 0, 0, 0, 92, 0, 0, 0, ...Buffer.from('JSON{"asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],"nodes":[{"name":"dragon"}]}  ')]);
/** Stands in for the host's launcher and anything else on this computer: no download may reach it. */
const hits: string[] = [];
const local = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) => {
    hits.push(req.url);
    return new Response(GLB, { headers: { "content-type": "model/gltf-binary" } });
  },
});
let world: Subprocess;
let base: string;
let key: string;

beforeAll(async () => {
  mkdirSync(join(dir, "home"));
  mkdirSync(data);
  writeFileSync(join(data, "config.json"), JSON.stringify({ name: "Assets", rules: "open", start: "blank", invite: "assets-invite", hostKey: "assets-host" }));
  const port = Promise.withResolvers<number>();
  world = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "server.ts")], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: join(dir, "home"), TMPDIR: tmpdir(), SANDBOX_DATA: data, PORT: "0" },
    stdout: "ignore",
    stderr: "inherit",
    ipc: (msg) => typeof msg?.port === "number" && port.resolve(msg.port),
  });
  base = `http://127.0.0.1:${await port.promise}`;
  ({ key } = await (await fetch(`${base}/api/join`, { method: "POST", body: JSON.stringify({ invite: "assets-invite", name: "builder" }) })).json());
}, 60_000);

afterAll(async () => {
  world?.kill();
  await world?.exited;
  local.stop(true);
  rmSync(dir, { recursive: true, force: true, maxRetries: 20 });
});

/** A tool's HTTP status: what it said is for the builder, so the tests check what it did. */
async function tool(name: string, args: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(args)) form.append(k, v);
  const res = await fetch(`${base}/cli/${name}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
  await res.body?.cancel();
  return res.status;
}

async function archive<T>(msg: object): Promise<T> {
  const worker = new Worker(new URL("./archive.ts", import.meta.url));
  const answer = Promise.withResolvers<T & { error?: string }>();
  worker.onmessage = ({ data }) => answer.resolve(data);
  worker.onerror = (error) => answer.reject(error);
  worker.postMessage(msg);
  try {
    const result = await answer.promise;
    if (result.error) throw new Error(result.error);
    return result;
  } finally {
    worker.terminate();
  }
}

test("add_asset never downloads from this computer, its network or the cloud metadata service", async () => {
  const refused = [
    `http://127.0.0.1:${local.port}/dragon.glb`,
    `http://localhost:${local.port}/dragon.glb`,
    "http://169.254.169.254/latest/meta-data/dragon.glb",
    "http://10.0.0.8/dragon.glb",
    "http://192.168.1.20/dragon.glb",
    "http://[fe80::1]/dragon.glb",
  ];
  for (const url of refused) expect(await tool("add_asset", { mod: "lava", name: "dragon.glb", url })).toBe(422);
  expect(hits).toEqual([]);
  expect(existsSync(join(data, "world", "mods", "lava"))).toBe(false);
});

test("a model added with add_asset is served from the world's own origin as what it is; other files only as inert bytes", async () => {
  const assets = join(data, "world", "mods", "lava", "assets");
  const script = Buffer.from("<script>alert(1)</script>").toString("base64");
  expect(await tool("add_asset", { mod: "lava", name: "page.html", base64: script })).toBe(422);
  expect(existsSync(join(assets, "page.html"))).toBe(false);
  expect(await tool("add_asset", { mod: "lava", name: "dragon.glb", base64: Buffer.from(GLB).toString("base64") })).toBe(200);
  expect(new Uint8Array(readFileSync(join(assets, "dragon.glb")))).toEqual(GLB);
  const model = await fetch(`${base}/assets/lava/dragon.glb`);
  expect([model.status, model.headers.get("content-type"), model.headers.get("x-content-type-options"), model.headers.get("content-security-policy")]).toEqual([200, "model/gltf-binary", "nosniff", "default-src 'none'; sandbox"]);
  expect(new Uint8Array(await model.arrayBuffer())).toEqual(GLB);
  // The skills' avatar and Mixamo files and fonts are served as the inert files they are. The server never reads an asset, so any bytes stand in.
  const opaque = new Uint8Array([1, 2, 3, 4]);
  for (const [name, type] of [["avatar.vrm", "model/gltf-binary"], ["dance.fbx", "application/octet-stream"], ["sign.ttf", "font/ttf"], ["title.woff2", "font/woff2"]]) {
    expect(await tool("add_asset", { mod: "lava", name: name!, base64: Buffer.from(opaque).toString("base64") })).toBe(200);
    const file = await fetch(`${base}/assets/lava/${name}`);
    expect([file.status, file.headers.get("content-type"), file.headers.get("x-content-type-options")]).toEqual([200, type, "nosniff"]);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(opaque);
  }
  // A file put there some other way is still served, but never as a page or a script.
  writeFileSync(join(assets, "page.html"), "<script>alert(1)</script>");
  const page = await fetch(`${base}/assets/lava/page.html`);
  expect([page.status, page.headers.get("content-type"), page.headers.get("x-content-type-options")]).toEqual([200, "application/octet-stream", "nosniff"]);
});

test("assets travel with the world's export and its Community pack, and come back on import", async () => {
  writeFileSync(join(data, "world", "mods", "lava", "assets", "dragon.glb"), GLB);
  for (const community of [false, true]) {
    const { zip } = await archive<{ zip: Uint8Array }>({ t: "pack", dir: data, community });
    expect(unzipSync(zip)["world/mods/lava/assets/dragon.glb"]).toEqual(GLB);
    const into = join(dir, `imported-${community}`);
    await archive({ t: "unpack", zip, into });
    expect(new Uint8Array(readFileSync(join(into, "world", "mods", "lava", "assets", "dragon.glb")))).toEqual(GLB);
  }
}, 60_000);
