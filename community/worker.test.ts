// The community Worker on wrangler dev with local D1 and R2: publish, update, upload, list, fetch, report and delete, as the launcher and the site use them.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = import.meta.dir;
const persist = mkdtempSync(join(tmpdir(), "community-test-"));
const PORT = 18787;
const API = `http://127.0.0.1:${PORT}`;
const wrangler = (...args: string[]) => Bun.spawn([join(dir, "node_modules/.bin/wrangler"), ...args, "--persist-to", persist], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
let dev: ReturnType<typeof wrangler>;

beforeAll(async () => {
  const schema = wrangler("d1", "execute", "sandbox-community", "--local", "--file", "schema.sql");
  if (await schema.exited) throw new Error(await new Response(schema.stderr).text());
  dev = wrangler("dev", "--local", "--port", String(PORT), "--ip", "127.0.0.1");
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${API}/worlds`).then((r) => r.ok, () => false)) return;
    await Bun.sleep(500);
  }
  throw new Error("wrangler dev didn't start");
}, 90_000);
afterAll(async () => {
  dev?.kill();
  await dev?.exited;
  rmSync(persist, { recursive: true, force: true });
});

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 9, 9]);
const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(1000).fill(7)]);
function form(fields: Record<string, string>, files: Record<string, Uint8Array<ArrayBuffer>> = {}) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  for (const [k, v] of Object.entries(files)) f.set(k, new Blob([v]), k);
  return f;
}
const meta = { title: "Lava Run", description: "Jump the lava.", author: "ana", visibility: "public", engine_version: "abc123", mods: "3" };
const publish = (fields: Record<string, string>, files: Record<string, Uint8Array<ArrayBuffer>> = { cover: jpeg, clip: webm }) => fetch(`${API}/worlds`, { method: "POST", body: form(fields, files) });
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

test("a published world is listed and served only once its zip is in, and only its owner changes it", async () => {
  const res = await publish(meta);
  expect(res.status).toBe(201);
  const { id, link, ownerToken } = await res.json();
  expect(id).toMatch(/^[a-z0-9]{12}$/);
  expect(link).toEndWith(`/w/${id}`);
  // Without its zip the world is nowhere to be seen.
  expect((await fetch(`${API}/worlds/${id}`)).status).toBe(404);
  expect(await (await fetch(`${API}/worlds`)).json()).toEqual([]);

  expect((await fetch(`${API}/worlds/${id}/zip`, { method: "PUT", body: zip, headers: auth("wrong") })).status).toBe(403);
  expect((await fetch(`${API}/worlds/${id}/zip`, { method: "PUT", body: zip, headers: auth(ownerToken) })).status).toBe(200);

  const world = await (await fetch(`${API}/worlds/${id}`)).json();
  expect(world).toMatchObject({ id, title: "Lava Run", author: "ana", visibility: "public", mods: 3, size: zip.length, remixOf: null });
  expect(JSON.stringify(world)).not.toContain("token");
  expect(new Uint8Array(await (await fetch(world.zip)).arrayBuffer())).toEqual(zip);
  expect(new Uint8Array(await (await fetch(world.cover)).arrayBuffer())).toEqual(jpeg);
  expect((await fetch(world.clip)).headers.get("content-type")).toBe("video/webm");
  expect((await (await fetch(`${API}/worlds`)).json()).map((w: any) => w.id)).toEqual([id]);

  // Republishing changes the same world, keeping the clip it isn't sent again.
  expect((await fetch(`${API}/worlds/${id}`, { method: "PUT", body: form({ ...meta, title: "Lava Run 2", visibility: "link" }), headers: auth("wrong") })).status).toBe(403);
  expect((await fetch(`${API}/worlds/${id}`, { method: "PUT", body: form({ ...meta, title: "Lava Run 2", visibility: "link" }), headers: auth(ownerToken) })).status).toBe(200);
  const updated = await (await fetch(`${API}/worlds/${id}`)).json();
  expect(updated).toMatchObject({ title: "Lava Run 2", visibility: "link" });
  expect(updated.clip).not.toBeNull();
  // Link-only worlds open by their link but aren't listed.
  expect(await (await fetch(`${API}/worlds`)).json()).toEqual([]);

  expect((await fetch(`${API}/worlds/${id}/report`, { method: "POST" })).status).toBe(200);

  expect((await fetch(`${API}/worlds/${id}`, { method: "DELETE", headers: auth("wrong") })).status).toBe(403);
  expect((await fetch(`${API}/worlds/${id}`, { method: "DELETE", headers: auth(ownerToken) })).status).toBe(204);
  expect((await fetch(`${API}/worlds/${id}`)).status).toBe(404);
  expect((await fetch(`${API}/worlds/${id}/zip`)).status).toBe(404);
});

test("a remix names the world it came from, and the newest public world lists first", async () => {
  const first = await (await publish(meta)).json();
  await fetch(`${API}/worlds/${first.id}/zip`, { method: "PUT", body: zip, headers: auth(first.ownerToken) });
  const remix = await (await publish({ ...meta, title: "Lava Run remix", author: "ben", remix_of: first.id }, { cover: jpeg })).json();
  await fetch(`${API}/worlds/${remix.id}/zip`, { method: "PUT", body: zip, headers: auth(remix.ownerToken) });
  const list = await (await fetch(`${API}/worlds`)).json();
  expect(list.map((w: any) => w.id)).toEqual([remix.id, first.id]);
  expect(list[0]).toMatchObject({ remixOf: first.id, clip: null });
});

test("publishing checks what it is sent", async () => {
  expect(await (await publish({ ...meta, visibility: "everyone" })).json()).toEqual({ error: "Visibility is link or public." });
  expect(await (await publish({ ...meta, title: " " })).json()).toEqual({ error: "A world needs a title." });
  expect(await (await publish(meta, { clip: webm })).json()).toEqual({ error: "A world needs a cover." });
  expect(await (await publish(meta, { cover: webm })).json()).toEqual({ error: "A cover is a JPEG under 2 MB." });
  expect(await (await publish(meta, { cover: jpeg, clip: jpeg })).json()).toEqual({ error: "A clip is a WebM under 6 MB." });
  expect((await fetch(`${API}/worlds/abc`)).status).toBe(404);
});

test("an oversized zip is turned away before it is stored", async () => {
  const { id, ownerToken } = await (await publish(meta)).json();
  const res = await fetch(`${API}/worlds/${id}/zip`, { method: "PUT", body: new Uint8Array(96 << 20), headers: auth(ownerToken) });
  expect(res.status).toBe(413);
  expect((await fetch(`${API}/worlds/${id}`)).status).toBe(404);
});

test("one IP publishes at most ten worlds an hour", async () => {
  // Earlier tests in this file sent nine publishes; refused ones count too.
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await publish(meta)).status);
  expect(statuses).toEqual([201, 429, 429]);
});
