// Community worlds end to end: two throwaway launchers and the community API on throwaway Postgres and S3. One shares a world, the other hosts and remixes it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { unzipSync } from "fflate";
import { startStack } from "../community/server/stack";

const dir = mkdtempSync(join(tmpdir(), "sandbox-community-"));
const procs: Subprocess[] = [];
let stack: Awaited<ReturnType<typeof startStack>>;
let COMMUNITY: string;
/** No relay answers here, so hosted worlds stay off the public one. */
const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.endsWith("_API_KEY"))), SANDBOX_RELAY: "http://127.0.0.1:1", SANDBOX_COMMUNITY: COMMUNITY, SANDBOX_NO_OPEN: "1" });
const COVER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]).toString("base64");
const CLIP = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 4, 5, 6]).toString("base64");

type Launcher = { base: string; key: string; data: string };
const menu = async (l: Launcher, action: string, body?: object) => {
  const res = await fetch(`${l.base}/api/menu/${action}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${l.key}` }, body: body && JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) };
};
async function launcher(name: string): Promise<Launcher> {
  const port = 23000 + Math.floor(Math.random() * 1000);
  const data = join(dir, name);
  mkdirSync(data);
  procs.push(Bun.spawn(["bun", join(import.meta.dir, "launcher.ts")], { env: { ...env(), PORT: String(port), SANDBOX_DATA: data }, stdout: "ignore" }));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100 && !(await fetch(`${base}/menu`).then(() => true, () => false)); i++) await Bun.sleep(100);
  return { base, data, key: (await (await fetch(`${base}/api/local-key`)).json()).key };
}

let ana: Launcher, ben: Launcher;
beforeAll(async () => {
  stack = await startStack();
  COMMUNITY = stack.api;
  [ana, ben] = await Promise.all([launcher("ana"), launcher("ben")]);
}, 120_000);
afterAll(async () => {
  for (const p of procs) p.kill();
  await Promise.allSettled(procs.map((p) => p.exited));
  await stack?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("a shared world goes up as its export, comes down on another computer as a remix, and only its sharer changes it", async () => {
  const created = await menu(ana, "create", { name: "Lava Keep", start: "basics" });
  const id = created.running.id;
  const folder = join(ana.data, "worlds", id);
  const config = JSON.parse(readFileSync(join(folder, "config.json"), "utf8"));
  // What its players did and said: a chat line and a tool call in the record, a Timelapse moment's chat, and where a player sits.
  expect((await menu(ana, "stop", {})).status).toBe(200);
  const record = new Database(join(folder, "record.sqlite"));
  record.run("insert into events (at, kind, who, data) values (1, 'chat', 'ana', ?), (2, 'tool', 'ana', ?)", [JSON.stringify({ text: "CHAT-CANARY meet at the lava" }), JSON.stringify({ tool: "TOOL-CANARY_edit" })]);
  record.close();
  const saved = new Database(join(folder, "world.sqlite"));
  const moment = [{ at: 1, t: "feed", text: "MOMENT-CANARY lava rose", kind: "info" }, { at: 1, t: "chat", from: "ana", text: "MOMENT-CHAT-CANARY see you at the lava" }];
  saved.run("insert into timelapse (at, full, data, activity) values (1, 1, x'00', ?)", [JSON.stringify(moment)]);
  saved.close();
  writeFileSync(join(folder, "seats.json"), JSON.stringify({ "SEAT-CANARY-player": { game: null, lastPos: {} } }));

  // A new world has no picture until its host plays it, so sharing asks for the current view.
  expect((await menu(ana, "share", { id, visibility: "link", author: "ana" })).error).toBe("This world has no picture yet. Pick Current view.");
  const shared = await menu(ana, "share", { id, title: "Lava Keep", description: "Run from the lava.", visibility: "link", author: "ana", cover: COVER, clip: CLIP });
  expect(shared.status).toBe(200);
  expect(shared.visibility).toBe("link");
  const communityId = shared.link.match(/\/w\/([a-z0-9]{12})$/)[1];
  // The owner token stays in the launcher's own file, never in the menu's state or the world's folder.
  const state = await menu(ana, "state");
  expect(state.worlds.find((w: any) => w.id === id).shared).toEqual({ link: shared.link, visibility: "link", title: "Lava Keep", description: "Run from the lava." });
  expect(JSON.stringify(state)).not.toContain("ownerToken");
  expect(readFileSync(join(ana.data, "community.json"), "utf8")).toContain("ownerToken");

  // What went up is the world without its keys or what its players did and said; who made its mods stays as their credit.
  const world = await (await fetch(`${COMMUNITY}/worlds/${communityId}`)).json();
  expect(world).toMatchObject({ title: "Lava Keep", author: "ana", visibility: "link", remixOf: null });
  const files = unzipSync(new Uint8Array(await (await fetch(world.zip)).arrayBuffer()));
  expect(Object.keys(files)).toContain("config.json");
  expect(Object.keys(files)).toContain("owners.json");
  expect(Object.keys(files)).toContain("world.sqlite");
  expect(Object.keys(files)).not.toContain("record.sqlite");
  expect(Object.keys(files)).not.toContain("seats.json");
  // The Timelapse goes with it, every moment kept but what players said in them.
  const timelapse = join(dir, "shared.sqlite");
  writeFileSync(timelapse, files["world.sqlite"]!);
  const sharedSave = new Database(timelapse, { readonly: true });
  expect(sharedSave.query("select at, activity from timelapse where at = 1").all()).toEqual([{ at: 1, activity: JSON.stringify([moment[0]]) }]);
  sharedSave.close();
  const text = Object.values(files).map((f) => Buffer.from(f).toString("latin1")).join("\n");
  for (const secret of [config.invite, config.hostKey, "CHAT-CANARY", "TOOL-CANARY", "MOMENT-CHAT-CANARY", "SEAT-CANARY"]) expect(text).not.toContain(secret);

  // Link-only: not listed, but anyone with the link opens it.
  expect((await (await fetch(`${COMMUNITY}/worlds`)).json()).map((w: any) => w.id)).not.toContain(communityId);
  expect((await menu(ana, "community-world", { link: shared.link })).mine).toBe(true);
  const seen = await menu(ben, "community-world", { link: shared.link.replace(/^https?:\/\//, "") });
  expect(seen).toMatchObject({ id: communityId, title: "Lava Keep", mine: false });

  // Someone else's world runs their code here, so getting it needs trust.
  expect((await menu(ben, "community-get", { id: communityId })).error).toBe("This world runs code from ana. Only play worlds from people you trust.");
  const remixed = await menu(ben, "community-get", { id: communityId, trust: true });
  expect(remixed.worlds.find((w: any) => w.id === remixed.world).name).toBe("Lava Keep");
  expect(existsSync(join(ben.data, "worlds", remixed.world, "config.json"))).toBe(true);

  // Ben's remix, shared for everyone, names the world it came from.
  const benShared = await menu(ben, "share", { id: remixed.world, title: "Lava Keep, colder", visibility: "public", author: "ben", cover: COVER });
  const listed = await (await fetch(`${COMMUNITY}/worlds`)).json();
  expect(listed.map((w: any) => [w.title, w.remixOf, w.clip])).toEqual([["Lava Keep, colder", communityId, null]]);
  const community = await (await fetch(`${ben.base}/api/menu/community`, { method: "POST", headers: { authorization: `Bearer ${ben.key}` }, body: "{}" })).json();
  expect(community.map((w: any) => [w.title, w.mine])).toEqual([["Lava Keep, colder", true]]);

  // Sharing again updates the same world.
  const again = await menu(ana, "share", { id, title: "Lava Keep 2", visibility: "public", author: "ana" });
  expect(again.link).toBe(shared.link);
  expect(await (await fetch(`${COMMUNITY}/worlds/${communityId}`)).json()).toMatchObject({ title: "Lava Keep 2", visibility: "public" });

  // Hosting a community world again reuses the copy it made, instead of piling up copies.
  const hosted = await menu(ben, "community-get", { id: communityId, trust: true, host: true });
  expect(hosted.running.id).toBe(hosted.world);
  expect((await menu(ben, "community-get", { id: communityId, trust: true, host: true })).world).toBe(hosted.world);

  // Stopping sharing takes it out of Community; Ben's remix stays.
  expect((await menu(ben, "unshare", { id })).error).toBe("That world isn't shared.");
  expect((await menu(ana, "unshare", { id })).status).toBe(200);
  expect((await fetch(`${COMMUNITY}/worlds/${communityId}`)).status).toBe(404);
  expect((await menu(ana, "state")).worlds.find((w: any) => w.id === id).shared).toBeNull();
  expect((await fetch(benShared.link.replace(/^.*\/w\//, `${COMMUNITY}/worlds/`))).status).toBe(200);
}, 120_000);
