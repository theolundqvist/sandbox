import { afterAll, expect, test } from "bun:test";
import { EgressError } from "./box/broker";
import { ASSET_LIMIT, download } from "./egress";

const secretHits: string[] = [];
const secret = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) => {
    secretHits.push(new URL(req.url).pathname);
    return new Response("host-key-canary");
  },
});
/** The smallest real binary glTF: the glTF 2.0 header, then one JSON chunk with a scene holding one empty node. */
const GLB = new Uint8Array([...Buffer.from("glTF"), 2, 0, 0, 0, 112, 0, 0, 0, 92, 0, 0, 0, ...Buffer.from('JSON{"asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],"nodes":[{"name":"dragon"}]}  ')]);
const stubHits: { path: string; host: string | null }[] = [];
/** A file host the tests let through although it is on loopback, the way only a test can. */
const stub = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    stubHits.push({ path, host: req.headers.get("host") });
    if (path === "/dragon.glb") return new Response(GLB, { headers: { "content-type": "model/gltf-binary" } });
    if (path === "/raw.glb") return new Response(GLB, { headers: { "content-type": "application/octet-stream" } });
    if (path === "/page.glb") return new Response("<script>steal()</script>", { headers: { "content-type": "text/html" } });
    if (path === "/text.png") return new Response("not a picture", { headers: { "content-type": "text/plain" } });
    if (path === "/level.json") return new Response('{"a":1}', { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (path === "/big.glb") return new Response(new Uint8Array(2048), { headers: { "content-type": "model/gltf-binary" } });
    if (path === "/streamed.glb")
      return new Response(new ReadableStream({ pull: (c) => (c.enqueue(new Uint8Array(512)), void 0) }), { headers: { "content-type": "model/gltf-binary" } });
    if (path === "/to-secret") return Response.redirect(`http://127.0.0.1:${secret.port}/api/local-key`, 302);
    if (path === "/to-metadata") return Response.redirect("http://169.254.169.254/latest/meta-data/", 302);
    return new Response("missing", { status: 404 });
  },
});
afterAll(() => {
  secret.stop(true);
  stub.stop(true);
});
const allowStub = { allow: [`127.0.0.1:${stub.port}`] };
const fromStub = (path: string) => `http://127.0.0.1:${stub.port}${path}`;

test.each([
  `http://127.0.0.1:${secret.port}/api/local-key`,
  `http://localhost:${secret.port}/`,
  `http://[::ffff:127.0.0.1]:${secret.port}/`,
  `http://2130706433:${secret.port}/`,
  "http://[::1]/",
  "http://169.254.169.254/latest/meta-data/",
  "http://[fe80::1]/",
  "http://10.0.0.8/",
  "http://172.16.0.1/",
  "http://192.168.1.20/",
  "http://100.64.0.1/",
  "http://[fd00::1]/",
  "file:///etc/passwd",
])("a builder's download never reaches %s", async (url) => {
  await expect(download(url, "dragon.glb")).rejects.toBeInstanceOf(EgressError);
  expect(secretHits).toEqual([]);
});

test("every redirect is checked again, so a public file can't hand the download to the host or the cloud metadata service", async () => {
  await expect(download(fromStub("/to-secret"), "dragon.glb", ASSET_LIMIT, allowStub)).rejects.toThrow("egress refused: 127.0.0.1 is not a public address");
  await expect(download(fromStub("/to-metadata"), "dragon.glb", ASSET_LIMIT, allowStub)).rejects.toThrow("egress refused: 169.254.169.254 is not a public address");
  expect(secretHits).toEqual([]);
});

test("a name resolves once and the download goes to the address that was checked, under the name's Host", async () => {
  const lookups: string[] = [];
  const lookup = async (host: string) => (lookups.push(host), [{ address: "127.0.0.1", family: 4 }]);
  const bytes = await download(`http://models.example:${stub.port}/dragon.glb`, "dragon.glb", ASSET_LIMIT, { ...allowStub, lookup });
  expect(new Uint8Array(bytes)).toEqual(GLB);
  expect(lookups).toEqual(["models.example"]);
  expect(stubHits.at(-1)).toEqual({ path: "/dragon.glb", host: `models.example:${stub.port}` });
  // The same name resolving to the host itself, on a port nobody allowed, is refused.
  await expect(download(`http://models.example:${secret.port}/`, "dragon.glb", ASSET_LIMIT, { ...allowStub, lookup })).rejects.toThrow("egress refused: models.example is not a public address");
  expect(secretHits).toEqual([]);
});

test("a legitimate model comes down whole; the file has to be a kind add_asset takes, and say so", async () => {
  expect(new Uint8Array(await download(fromStub("/dragon.glb"), "dragon.glb", ASSET_LIMIT, allowStub))).toEqual(GLB);
  expect(new Uint8Array(await download(fromStub("/raw.glb"), "dragon.glb", ASSET_LIMIT, allowStub))).toEqual(GLB);
  expect(new TextDecoder().decode(await download(fromStub("/level.json"), "level.json", ASSET_LIMIT, allowStub))).toBe('{"a":1}');
  // The skills' avatar and Mixamo formats and fonts, all inert files, come down as they are.
  for (const name of ["avatar.vrm", "dance.fbx", "sign.ttf", "title.woff2"]) expect(new Uint8Array(await download(fromStub("/raw.glb"), name, ASSET_LIMIT, allowStub))).toEqual(GLB);
  await expect(download(fromStub("/page.glb"), "dance.fbx", ASSET_LIMIT, allowStub)).rejects.toThrow("sent text/html, not a .fbx file.");
  await expect(download(fromStub("/page.glb"), "dragon.glb", ASSET_LIMIT, allowStub)).rejects.toThrow(`http://127.0.0.1:${stub.port} sent text/html, not a .glb file.`);
  await expect(download(fromStub("/text.png"), "grass.png", ASSET_LIMIT, allowStub)).rejects.toThrow("sent text/plain, not a .png file.");
  const before = stubHits.length;
  for (const name of ["page.html", "script.js", "icon.svg", "dragon.glb.html", "x.constructor"])
    await expect(download(fromStub("/dragon.glb"), name, ASSET_LIMIT, allowStub)).rejects.toBeInstanceOf(EgressError);
  expect(stubHits.length).toBe(before);
});

test("a file over the limit is refused, whether its size is announced or only streamed", async () => {
  expect(ASSET_LIMIT).toBe(50 * 1024 * 1024);
  await expect(download(fromStub("/big.glb"), "big.glb", 1024, allowStub)).rejects.toThrow(/larger than the \d+ MiB add_asset takes/);
  await expect(download(fromStub("/streamed.glb"), "streamed.glb", 4096, allowStub)).rejects.toThrow(/larger than the \d+ MiB add_asset takes/);
  expect(await download(fromStub("/big.glb"), "big.glb", 2048, allowStub)).toHaveLength(2048);
});
