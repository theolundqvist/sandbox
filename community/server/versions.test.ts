// World versions against real Postgres: each update that goes live is a version with its changelog, and a fork learns when its original moved past the version it came from.
import { expect, test } from "bun:test";
import { useStack, call, kit, publish, signUp, zip } from "./testkit";

useStack();

async function update(token: string, id: string, changelog?: string) {
  const res = await call(`/worlds/${id}`, { method: "PUT", token, body: { title: "Keep", visibility: "public", engineVersion: "x", mods: 0, files: { zip: zip.length }, changelog } });
  expect(res.status).toBe(200);
  await fetch((await res.json()).uploads.zip, { method: "PUT", body: zip, headers: { "content-type": "application/zip" } });
  expect((await call(`/worlds/${id}/done`, { method: "POST", token })).status).toBe(200);
}
const page = async (id: string) => await (await call(`/worlds/${id}`)).json();

test("updates become versions with their changelog, and a fork is told when its original moved on", async () => {
  const ana = await signUp("vana");
  const bo = await signUp("vbo");
  const world = await publish(ana.token);
  const fork = await publish(bo.token, { title: "Keep, colder", forkOf: world.id });
  expect(await page(world.id)).toMatchObject({ version: 1, history: [{ version: 1, changelog: "" }] });
  expect((await page(fork.id)).parent).toMatchObject({ id: world.id, updated: null });

  // An update the original's owner abandons halfway is no version.
  expect((await call(`/worlds/${world.id}`, { method: "PUT", token: ana.token, body: { title: "Keep", visibility: "public", engineVersion: "x", mods: 0, files: { zip: zip.length }, changelog: "Never landed" } })).status).toBe(200);
  await update(ana.token, world.id, `  Added a horse${"!".repeat(400)}`);
  await update(ana.token, world.id);
  const updated = await page(world.id);
  expect(updated.version).toBe(3);
  expect(updated.history.map((v: any) => [v.version, v.changelog.length])).toEqual([[3, 0], [2, 280], [1, 0]]);
  expect(updated.history[1].changelog).toStartWith("Added a horse");
  expect((await page(fork.id)).parent.updated).toMatchObject({ version: 3, changelog: "" });

  // A fork published after the update starts from the newest version; updating the fork itself keeps where it came from.
  const late = await publish(bo.token, { title: "Keep, late", forkOf: world.id });
  expect((await page(late.id)).parent.updated).toBeNull();
  await update(bo.token, fork.id, "Snow");
  expect((await page(fork.id)).parent.updated.version).toBe(3);

  // A world taken down keeps no changelog.
  expect((await call(`/worlds/${world.id}`, { method: "DELETE", token: ana.token })).status).toBe(204);
  expect((await page(fork.id)).parent).toEqual({ removed: true });
  expect((await kit.db`select count(*)::int as n from versions where world = ${world.id}`)[0].n).toBe(0);
});
