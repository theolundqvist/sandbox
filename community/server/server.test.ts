// The community API against real Postgres and an S3 stand-in: share, upload, list, fetch, report and delete, as the launcher and the site use them.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startStack, type CommunityStack } from "./stack";

let stack: CommunityStack;
let ana: string;
beforeAll(async () => {
  stack = await startStack();
  ana = (await (await call("/accounts", { body: { email: "ana@example.com", password: "lava lava lava", username: "ana" }, ip: "10.9.0.1" })).json()).token;
}, 120_000);
afterAll(() => stack?.stop(), 30_000);

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 9, 9]);
const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(1000).fill(7)]);
const TYPES = { zip: "application/zip", cover: "image/jpeg", clip: "video/webm" } as const;
const meta = { title: "Lava Run", description: "Jump the lava.", visibility: "public", engineVersion: "abc123", mods: 3 };

const call = (path: string, init: { method?: string; body?: unknown; token?: string; ip?: string } = {}) =>
  fetch(`${stack.api}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    body: init.body ? JSON.stringify(init.body) : undefined,
    headers: { "content-type": "application/json", "x-real-ip": init.ip ?? "10.0.0.1", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
  });
const sizes = (files: Partial<Record<keyof typeof TYPES, Uint8Array<ArrayBuffer>>>) => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.length]));
async function upload(uploads: Record<string, string>, files: Partial<Record<keyof typeof TYPES, Uint8Array<ArrayBuffer>>>) {
  for (const [kind, url] of Object.entries(uploads)) {
    const res = await fetch(url, { method: "PUT", body: files[kind as keyof typeof TYPES], headers: { "content-type": TYPES[kind as keyof typeof TYPES] } });
    expect(res.status).toBe(200);
  }
}
/** Shares a world the way the launcher does: details first, files straight to storage, then done. */
async function share(details: object, files: Partial<Record<keyof typeof TYPES, Uint8Array<ArrayBuffer>>> = { zip, cover: jpeg, clip: webm }, ip?: string) {
  const res = await call("/worlds", { body: { ...details, files: sizes(files) }, ip, token: ana });
  expect(res.status).toBe(201);
  const world = await res.json();
  await upload(world.uploads, files);
  expect((await call(`/worlds/${world.id}/done`, { method: "POST", token: ana })).status).toBe(200);
  return world;
}

test("a shared world is listed and served only once its files are in, and only its owner changes it", async () => {
  const ownerToken = ana;
  const res = await call("/worlds", { body: { ...meta, files: sizes({ zip, cover: jpeg, clip: webm }) }, token: ana });
  expect(res.status).toBe(201);
  const { id, link, uploads } = await res.json();
  expect(id).toMatch(/^[a-z0-9]{12}$/);
  expect(link).toBe(`https://sandbox.example/w/${id}`);
  expect(Object.keys(uploads).sort()).toEqual(["clip", "cover", "zip"]);
  // Until its files are in, the world is nowhere to be seen.
  expect((await call(`/worlds/${id}/done`, { method: "POST", token: ownerToken })).status).toBe(400);
  expect((await call(`/worlds/${id}`)).status).toBe(404);
  expect(await (await call("/worlds")).json()).toEqual([]);

  // Storage takes only the bytes and kind the server signed for.
  expect((await fetch(uploads.zip, { method: "PUT", body: new Uint8Array(zip.length + 1), headers: { "content-type": TYPES.zip } })).status).toBe(403);
  expect((await fetch(uploads.cover, { method: "PUT", body: jpeg, headers: { "content-type": "text/html" } })).status).toBe(403);
  await upload(uploads, { zip, cover: jpeg, clip: webm });
  expect((await call(`/worlds/${id}/done`, { method: "POST", token: "wrong" })).status).toBe(403);
  expect((await call(`/worlds/${id}/done`, { method: "POST", token: ownerToken })).status).toBe(200);

  const world = await (await call(`/worlds/${id}`)).json();
  expect(world).toMatchObject({ id, title: "Lava Run", author: "ana", visibility: "public", mods: 3, size: zip.length, forkOf: null });
  expect(JSON.stringify(world)).not.toContain(ownerToken);
  expect(new Uint8Array(await (await fetch(world.zip)).arrayBuffer())).toEqual(zip);
  expect(new Uint8Array(await (await fetch(world.cover)).arrayBuffer())).toEqual(jpeg);
  expect(new Uint8Array(await (await fetch(world.clip)).arrayBuffer())).toEqual(webm);
  expect((await (await call("/worlds")).json()).map((w: any) => w.id)).toEqual([id]);

  // Sharing again changes the same world: a new zip, the cover and clip it isn't sent again kept, the old zip gone.
  const zip2 = new Uint8Array([...zip, 8, 8]);
  const again = { ...meta, title: "Lava Run 2", visibility: "link", files: sizes({ zip: zip2 }) };
  expect((await call(`/worlds/${id}`, { method: "PUT", body: again, token: "wrong" })).status).toBe(403);
  const put = await call(`/worlds/${id}`, { method: "PUT", body: again, token: ownerToken });
  expect(put.status).toBe(200);
  await upload((await put.json()).uploads, { zip: zip2 });
  // While the new zip uploads, everyone still gets the old world.
  expect(await (await call(`/worlds/${id}`)).json()).toMatchObject({ title: "Lava Run", size: zip.length });
  expect((await call(`/worlds/${id}/done`, { method: "POST", token: ownerToken })).status).toBe(200);
  const updated = await (await call(`/worlds/${id}`)).json();
  expect(updated).toMatchObject({ title: "Lava Run 2", visibility: "link", size: zip2.length, cover: world.cover, clip: world.clip });
  expect(new Uint8Array(await (await fetch(updated.zip)).arrayBuffer())).toEqual(zip2);
  expect((await fetch(world.zip)).status).toBe(404);
  // Link-only worlds open by their link but aren't listed.
  expect(await (await call("/worlds")).json()).toEqual([]);

  expect(await (await call(`/worlds/${id}/report`, { method: "POST" })).json()).toEqual({ reported: true });

  expect((await call(`/worlds/${id}`, { method: "DELETE", token: "wrong" })).status).toBe(403);
  expect((await call(`/worlds/${id}`, { method: "DELETE", token: ownerToken })).status).toBe(204);
  expect((await call(`/worlds/${id}`)).status).toBe(410);
  for (const url of [updated.zip, updated.cover, updated.clip]) expect((await fetch(url)).status).toBe(404);
});

test("a fork names the world it came from, and the newest public world lists first", async () => {
  const first = await share(meta);
  const fork = await share({ ...meta, title: "Lava Run fork", forkOf: first.id }, { zip, cover: jpeg });
  const list = await (await call("/worlds")).json();
  expect(list.slice(0, 2).map((w: any) => w.id)).toEqual([fork.id, first.id]);
  expect(list[0]).toMatchObject({ forkOf: first.id, clip: null });
});

test("a file that isn't what it claims keeps the world from going live", async () => {
  const res = await call("/worlds", { body: { ...meta, files: sizes({ zip, cover: jpeg }) }, ip: "10.0.0.2", token: ana });
  const { id, uploads } = await res.json();
  await upload(uploads, { zip, cover: new Uint8Array([1, 2, 3, 4, 5, 6, 7]) });
  expect(await (await call(`/worlds/${id}/done`, { method: "POST", token: ana })).json()).toEqual({ error: "The world's files didn't all arrive. Share it again." });
  expect((await call(`/worlds/${id}`)).status).toBe(404);
});

test("sharing checks what it is sent", async () => {
  const refusal = async (body: object) => (await call("/worlds", { body, ip: "10.0.0.3", token: ana })).json();
  const files = sizes({ zip, cover: jpeg });
  expect(await refusal({ ...meta, visibility: "everyone", files })).toEqual({ error: "Visibility is link or public." });
  expect(await refusal({ ...meta, title: " ", files })).toEqual({ error: "A world needs a title." });
  expect(await refusal({ ...meta, files: { zip: zip.length } })).toEqual({ error: "A world needs a cover." });
  expect(await refusal({ ...meta, files: { ...files, cover: 3 << 20 } })).toEqual({ error: "A cover is a JPEG under 2 MB." });
  expect(await refusal({ ...meta, files: { ...files, zip: 201 << 20 } })).toEqual({ error: "A world is a zip under 200 MB." });
  expect((await call("/worlds/abc")).status).toBe(404);
});

test("one IP shares at most ten worlds an hour", async () => {
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await call("/worlds", { body: { ...meta, files: sizes({ zip, cover: jpeg }) }, ip: "10.0.0.4", token: ana })).status);
  expect(statuses).toEqual([...new Array(10).fill(201), 429]);
  expect((await call("/worlds", { body: { ...meta, files: sizes({ zip, cover: jpeg }) }, ip: "10.0.0.5", token: ana })).status).toBe(201);
});

test("only the site's origin may read the API from a browser", async () => {
  expect((await call("/worlds")).headers.get("access-control-allow-origin")).toBe("https://sandbox.example");
});
