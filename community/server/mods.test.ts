// Community mods against real Postgres and an S3 stand-in: publish, search, read, uses once per world, lineage, and the world routes for comments, votes and takedown.
import { expect, test } from "bun:test";
import { call, freshIp, jpeg, kit, publish, signUp, useStack, zip } from "./testkit";

useStack();

const shareMod = (token: string | undefined, extra: object = {}) =>
  call("/mods", { token, body: { name: "day-night", title: "Day and night", description: "A sun that sets.", readme: "# Day and night\nA sun that crosses the sky every ten minutes.", api: "export const clock: { hour(): number }", packages: { suncalc: "^1.9.0" }, needs: ["basics"], engineVersion: "x", files: { zip: zip.length, cover: jpeg.length }, ...extra } });
async function publishMod(token: string, extra: object = {}) {
  const res = await shareMod(token, extra);
  expect(res.status).toBe(201);
  const mod = await res.json();
  for (const [kind, body] of [["zip", zip], ["cover", jpeg]] as const) if (mod.uploads[kind]) await fetch(mod.uploads[kind], { method: "PUT", body, headers: { "content-type": kind === "zip" ? "application/zip" : "image/jpeg" } });
  expect((await call(`/worlds/${mod.id}/done`, { method: "POST", token })).status).toBe(200);
  return mod as { id: string; link: string };
}
const install = async () => (await (await call("/installs", { method: "POST" })).json()).token as string;
const use = (id: string, world: string, token?: string) => call(`/mods/${id}/uses`, { body: { world }, token });
const search = async (q = "", sort = "top") => (await call(`/mods?q=${encodeURIComponent(q)}&sort=${sort}`)).json();

test("a mod is published by an account, found by words in its README, read with its API, and never listed as a world", async () => {
  expect((await shareMod(undefined)).status).toBe(401);
  const ana = await signUp("mod_ana");
  expect((await shareMod(ana.token, { files: { zip: zip.length } })).status).toBe(400);
  expect((await shareMod(ana.token, { name: "Not A Name" })).status).toBe(400);
  expect((await shareMod(ana.token, { files: { zip: 21 << 20, cover: jpeg.length } })).status).toBe(400);
  const mod = await publishMod(ana.token);
  expect(mod.link).toBe(`https://sandbox.example/m/${mod.id}`);

  const found = await search("crosses the SKY");
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ id: mod.id, name: "day-night", title: "Day and night", description: "A sun that sets.", author: "mod_ana", uses: 0, votes: 0, kind: "mod" });
  expect(found[0].cover).toStartWith("http");
  expect(found[0]).not.toHaveProperty("readme");
  expect(await search("no such words")).toEqual([]);
  // Every word counts, wherever it is: "day night" finds "Day and night".
  expect((await search("night DAY")).map((m: any) => m.id)).toEqual([mod.id]);
  expect(await search("day submarine")).toEqual([]);
  // Wildcards in a search are only letters.
  expect(await search("%")).toEqual([]);

  const page = await (await call(`/mods/${mod.id}`)).json();
  expect(page).toMatchObject({ readme: expect.stringContaining("ten minutes"), api: "export const clock: { hour(): number }", packages: { suncalc: "^1.9.0" }, needs: ["basics"], builders: ["mod_ana"], forks: 0, parent: null });
  expect(page.zip).toStartWith("http");
  expect((await (await call("/worlds")).json()).map((w: any) => w.id)).not.toContain(mod.id);
  expect((await (await call("/users/mod_ana")).json()).worlds).toEqual([]);

  // A world is not a mod.
  const world = await publish(ana.token, { title: "A world" });
  expect((await call(`/mods/${world.id}`)).status).toBe(404);
}, 30_000);

test("uses count each world once, only from an install, and order the list", async () => {
  const ben = await signUp("mod_ben");
  const popular = await publishMod(ben.token, { name: "inventory", title: "Inventory" });
  const quiet = await publishMod(ben.token, { name: "fishing", title: "Fishing" });
  const computer = await install();
  expect((await use(popular.id, "world-aaaaaaaaaaaa")).status).toBe(401);
  expect((await use(popular.id, "bad key", computer)).status).toBe(400);
  for (const world of ["world-aaaaaaaaaaaa", "world-aaaaaaaaaaaa", "world-bbbbbbbbbbbb"]) expect((await use(popular.id, world, computer)).status).toBe(200);
  expect(await (await use(popular.id, "world-aaaaaaaaaaaa", await install())).json()).toEqual({ uses: 2 });
  expect(await (await use(quiet.id, "world-aaaaaaaaaaaa", computer)).json()).toEqual({ uses: 1 });
  const top = (await search("", "top")).map((m: any) => m.id);
  expect(top.indexOf(popular.id)).toBeLessThan(top.indexOf(quiet.id));
  expect((await search("", "new"))[0].id).toBe(quiet.id);
}, 30_000);

test("a fork of a mod keeps its parent; only the owner updates a mod; a world and a mod are never each other's parent", async () => {
  const cara = await signUp("mod_cara");
  const dan = await signUp("mod_dan");
  const original = await publishMod(cara.token, { name: "weather" });
  const world = await publish(cara.token, { title: "Rainy" });
  expect((await shareMod(dan.token, { forkOf: world.id })).status).toBe(400);
  expect((await call("/worlds", { token: dan.token, body: { title: "Not a fork", visibility: "public", forkOf: original.id, engineVersion: "x", files: { zip: zip.length, cover: jpeg.length } } })).status).toBe(400);
  expect((await call(`/mods/${original.id}`, { method: "PUT", token: dan.token, body: { name: "weather", files: { zip: zip.length } } })).status).toBe(403);
  const fork = await publishMod(dan.token, { name: "weather", title: "Stormy weather", forkOf: original.id });
  expect((await (await call(`/mods/${fork.id}`)).json()).parent).toEqual({ id: original.id, title: "Day and night", author: "mod_cara" });
  expect((await (await call(`/mods/${original.id}`)).json()).forks).toBe(1);
  // Its owner hears of the fork, and the notice opens a mod's page.
  expect((await (await call("/notifications", { token: cara.token })).json())[0]).toMatchObject({ kind: "fork", actor: "mod_dan", world: { id: fork.id, kind: "mod" } });
  expect((await (await call(`/worlds/${original.id}/forks`)).json()).map((m: any) => m.id)).toEqual([fork.id]);

  // An update keeps the id and the preview, and replaces the README.
  const res = await call(`/mods/${original.id}`, { method: "PUT", token: cara.token, body: { name: "weather", readme: "Now with snow.", files: { zip: zip.length } } });
  expect(res.status).toBe(200);
  await fetch((await res.json()).uploads.zip, { method: "PUT", body: zip, headers: { "content-type": "application/zip" } });
  expect((await call(`/worlds/${original.id}/done`, { method: "POST", token: cara.token })).status).toBe(200);
  const updated = await (await call(`/mods/${original.id}`)).json();
  expect(updated.readme).toBe("Now with snow.");
  expect(updated.cover).toStartWith("http");
}, 30_000);

test("comments, votes and reports go through the world routes, and a taken-down mod leaves search and its page", async () => {
  const eve = await signUp("mod_eve");
  const fan = await signUp("mod_fan");
  const mod = await publishMod(eve.token, { name: "jetpack", readme: "Fly with space." });
  expect((await call(`/worlds/${mod.id}/vote`, { method: "PUT", body: { up: true }, token: fan.token })).status).toBe(200);
  expect((await call(`/worlds/${mod.id}/comments`, { body: { body: "<b>love it</b>" }, token: fan.token })).status).toBe(201);
  expect((await call(`/worlds/${mod.id}/report`, { method: "POST", ip: freshIp() })).status).toBe(200);
  const page = await (await call(`/mods/${mod.id}`, { token: fan.token })).json();
  expect(page).toMatchObject({ votes: 1, voted: true, mine: false });
  expect((await (await call(`/worlds/${mod.id}/comments`)).json())[0].body).toBe("<b>love it</b>");
  expect((await kit.db`select reports from worlds where id = ${mod.id}`)[0].reports).toBe(1);

  expect((await call(`/worlds/${mod.id}`, { method: "DELETE", token: fan.token })).status).toBe(403);
  expect((await call(`/worlds/${mod.id}`, { method: "DELETE", token: eve.token })).status).toBe(204);
  expect((await call(`/mods/${mod.id}`)).status).toBe(410);
  expect(await search("fly with space")).toEqual([]);
  const [row] = await kit.db`select title, mod, zip_key from worlds where id = ${mod.id}`;
  expect(row).toEqual({ title: "", mod: null, zip_key: null });
}, 30_000);
