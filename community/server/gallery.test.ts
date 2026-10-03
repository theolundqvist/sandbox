// A world's gallery and timelapse against real Postgres and S3: the pictures the publisher picked go on its page, a new pick replaces them, and turning the timelapse off takes its clip down.
import { expect, test } from "bun:test";
import { useStack, call, kit, jpeg, publish, signUp, zip } from "./testkit";

useStack();

const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
const picture = (n: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n]);
const r2 = () => new Bun.S3Client({ endpoint: kit.stack.env.R2_ENDPOINT, bucket: kit.stack.env.R2_BUCKET, region: kit.stack.env.R2_REGION, accessKeyId: kit.stack.env.R2_ACCESS_KEY_ID, secretAccessKey: kit.stack.env.R2_SECRET_ACCESS_KEY });
const page = async (id: string) => await (await call(`/worlds/${id}`)).json();
const bytes = async (url: string) => [...new Uint8Array(await (await fetch(url)).arrayBuffer())];

/** An update with these files; uploads every one it is handed and returns how the share answered before going live. */
async function update(token: string, id: string, files: { gallery?: Uint8Array<ArrayBuffer>[]; clip?: Uint8Array<ArrayBuffer> }, extra: object = {}) {
  const sizes: Record<string, unknown> = { zip: zip.length };
  if (files.gallery) sizes.gallery = files.gallery.map((g) => g.length);
  if (files.clip) sizes.clip = files.clip.length;
  const res = await call(`/worlds/${id}`, { method: "PUT", token, body: { title: "Keep", visibility: "public", engineVersion: "x", mods: 0, files: sizes, ...extra } });
  expect(res.status).toBe(200);
  const { uploads } = await res.json();
  const body: Record<string, Uint8Array<ArrayBuffer>> = { zip, ...(files.clip ? { clip: files.clip } : {}), ...Object.fromEntries((files.gallery ?? []).map((g, i) => [`gallery${i}`, g])) };
  for (const [name, url] of Object.entries(uploads as Record<string, string>)) await fetch(url, { method: "PUT", body: body[name]!, headers: { "content-type": name === "zip" ? "application/zip" : name === "clip" ? "video/webm" : "image/jpeg" } });
  expect((await call(`/worlds/${id}/done`, { method: "POST", token })).status).toBe(200);
  return Object.keys(uploads).sort();
}
const keys = async (id: string) => (await kit.db`select clip_key, gallery_keys from worlds where id = ${id}`)[0]!;
const stored = async (key: string) => await r2().exists(key);

test("the gallery is what the publisher last picked, in order, and the timelapse's clip stays until it is turned off", async () => {
  const ana = await signUp("gana");
  const world = await publish(ana.token);
  expect((await page(world.id)).gallery).toEqual([]);

  // Two pictures and a clip, in the order picked.
  expect(await update(ana.token, world.id, { gallery: [picture(1), picture(2)], clip: webm })).toEqual(["clip", "gallery0", "gallery1", "zip"]);
  const first = await page(world.id);
  expect(await Promise.all(first.gallery.map(bytes))).toEqual([[...picture(1)], [...picture(2)]]);
  expect(first.clip).toBeString();
  const before = await keys(world.id);

  // An update that picks nothing keeps both.
  await update(ana.token, world.id, {});
  expect(await keys(world.id)).toEqual(before);

  // A new pick replaces the old pictures, which leave storage.
  await update(ana.token, world.id, { gallery: [picture(3)] });
  const after = await keys(world.id);
  expect(after.gallery_keys).toHaveLength(1);
  expect(await bytes((await page(world.id)).gallery[0])).toEqual([...picture(3)]);
  for (const old of before.gallery_keys) expect(await stored(old)).toBe(false);

  // The timelapse turned off takes the clip down, even when one is sent along.
  expect(await update(ana.token, world.id, { clip: webm }, { timelapse: false })).toEqual(["zip"]);
  expect((await page(world.id)).clip).toBeNull();
  expect(await stored(before.clip_key)).toBe(false);

  // An empty pick clears the gallery.
  await update(ana.token, world.id, { gallery: [] });
  expect((await page(world.id)).gallery).toEqual([]);
  expect(await stored(after.gallery_keys[0])).toBe(false);
});

test("a gallery is at most 8 JPEGs under 2 MB, each checked once it arrives", async () => {
  const bo = await signUp("gbo");
  const world = await publish(bo.token);
  const put = (files: object) => call(`/worlds/${world.id}`, { method: "PUT", token: bo.token, body: { title: "Keep", visibility: "public", engineVersion: "x", mods: 0, files: { zip: zip.length, ...files } } });
  for (const gallery of [Array(9).fill(jpeg.length), [3 * 1024 * 1024], ["big"]]) {
    const res = await put({ gallery });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("The gallery is up to 8 JPEGs under 2 MB each.");
  }
  // A picture that isn't a JPEG keeps the update from going live.
  const { uploads } = await (await put({ gallery: [zip.length] })).json();
  await fetch(uploads.zip, { method: "PUT", body: zip, headers: { "content-type": "application/zip" } });
  await fetch(uploads.gallery0, { method: "PUT", body: zip, headers: { "content-type": "image/jpeg" } });
  expect((await call(`/worlds/${world.id}/done`, { method: "POST", token: bo.token })).status).toBe(400);
  expect((await page(world.id)).gallery).toEqual([]);
});

test("a world taken down keeps no gallery", async () => {
  const cy = await signUp("gcy");
  const world = await publish(cy.token);
  await update(cy.token, world.id, { gallery: [picture(4)] });
  const { gallery_keys } = await keys(world.id);
  expect((await call(`/worlds/${world.id}`, { method: "DELETE", token: cy.token })).status).toBe(204);
  expect((await keys(world.id)).gallery_keys).toBeNull();
  expect(await stored(gallery_keys[0])).toBe(false);
});
