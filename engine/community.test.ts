// Community worlds end to end: two throwaway launchers and the community API on throwaway Postgres and S3. One shares a world, the other hosts and remixes it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
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
/** ElevenLabs for both Community's free voice (its key is "community-key") and a host's own key: it says what it heard and who paid. */
const MP3 = new Uint8Array([0xff, 0xfb, 7, 7]);
const KEYS = ["community-key", "sk_own_elevenlabs"];
const elevenLabs = { spoken: [] as { key: string; text: string }[], heard: [] as string[] };
const voiceStub = Bun.serve({
  port: 0,
  async fetch(req) {
    const key = req.headers.get("xi-api-key") ?? "";
    if (!KEYS.includes(key)) return Response.json({ detail: { type: "authentication_error" } }, { status: 401 });
    if (new URL(req.url).pathname.startsWith("/v1/text-to-speech/")) {
      elevenLabs.spoken.push({ key, text: (await req.json()).text });
      return new Response(MP3, { headers: { "content-type": "audio/mpeg" } });
    }
    const file = (await req.formData()).get("file") as File;
    if (file.size) elevenLabs.heard.push(key);
    return Response.json({ text: "the lava rises", words: [{ text: "rises", end: 3.2 }] });
  },
});
/** No relay answers here, so hosted worlds stay off the public one. */
const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.endsWith("_API_KEY"))), SANDBOX_RELAY: "http://127.0.0.1:1", SANDBOX_COMMUNITY: COMMUNITY, SANDBOX_STT: voiceStub.url.origin, SANDBOX_NO_OPEN: "1" });
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
  stack = await startStack("https://sandbox.example", { ELEVENLABS_URL: voiceStub.url.origin, ELEVENLABS_API_KEY: "community-key" });
  COMMUNITY = stack.api;
  [ana, ben] = await Promise.all([launcher("ana"), launcher("ben")]);
}, 120_000);
afterAll(async () => {
  for (const p of procs) p.kill();
  await Promise.allSettled(procs.map((p) => p.exited));
  await stack?.stop();
  voiceStub.stop(true);
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

test("a host without a voice key gets free voice from Community, counted against their computer, and their own key goes around it", async () => {
  const secrets = join(ana.data, "secrets.json");
  for (let i = 0; i < 100 && !existsSync(secrets); i++) await Bun.sleep(100);
  const { install } = JSON.parse(readFileSync(secrets, "utf8"));
  expect(install.host).toBe(COMMUNITY);
  expect(await menu(ana, "free-voice")).toEqual({ status: 200, used: 0, of: 1 });

  const created = await menu(ana, "create", { name: "Voice Keep", start: "blank" });
  const player = await (await fetch(`${ana.base}/api/join`, { method: "POST", body: JSON.stringify({ invite: created.running.invite, name: "ana", host: created.running.hostKey }) })).json();
  const auth = { authorization: `Bearer ${player.key}` };
  expect((await (await fetch(`${ana.base}/api/status`, { headers: auth })).json()).voice).toStartWith("on");
  const speak = async (text: string, headers: Record<string, string> = auth) => {
    const res = await fetch(`${ana.base}/api/speak`, { method: "POST", headers, body: JSON.stringify({ text }) });
    return { status: res.status, ...(res.status === 401 ? {} : await res.json()) };
  };
  const used = async () => (await (await fetch(`${COMMUNITY}/ai/usage`, { headers: { authorization: `Bearer ${install.token}` } })).json()).used;

  // ctx.speak: each line is made once, however many players ask for it at once, and this world serves it.
  const first = await speak("Round two!");
  expect(first.url).toMatch(/^\/speech\/[0-9a-f]{64}\.mp3$/);
  const [a, b, again] = await Promise.all([speak("Lava rises."), speak("Lava rises."), speak("Round two!")]);
  expect([a.url, again.url]).toEqual([b.url, first.url]);
  const mp3 = await fetch(`${ana.base}${first.url}`);
  expect(mp3.headers.get("content-type")).toBe("audio/mpeg");
  expect(new Uint8Array(await mp3.arrayBuffer())).toEqual(MP3);
  expect(elevenLabs.spoken).toEqual([{ key: "community-key", text: "Round two!" }, { key: "community-key", text: "Lava rises." }]);
  expect(await used()).toBeCloseTo((10 + 11) * 0.00004, 8);
  expect((await speak("Hi", {})).status).toBe(401);

  // What a player says goes through Community too, counted by how long they spoke.
  await fetch(`${ana.base}/api/voice`, { method: "POST", headers: auth, body: new Blob([new Uint8Array(2000)], { type: "audio/webm" }) });
  for (let i = 0; i < 100 && !elevenLabs.heard.length; i++) await Bun.sleep(50);
  expect(elevenLabs.heard).toEqual(["community-key"]);
  for (let i = 0; i < 100 && (await used()) < 0.001; i++) await Bun.sleep(50);
  expect(await used()).toBeCloseTo((10 + 11) * 0.00004 + Math.ceil((4 * 220_000) / 3600) / 1e6, 8);

  // The host's own ElevenLabs key wins, and Community counts none of it.
  const before = await used();
  expect((await menu(ana, "voice", { key: "sk_own_elevenlabs" })).voiceKey).toBe("ElevenLabs ••••labs");
  expect(await menu(ana, "free-voice")).toEqual({ status: 200 });
  await speak("My own voice.");
  expect(elevenLabs.spoken.at(-1)).toEqual({ key: "sk_own_elevenlabs", text: "My own voice." });
  expect(await used()).toBe(before);
  expect((await menu(ana, "voice", { key: "" })).voiceKey).toBeNull();

  // Once this computer's dollar is spent, mods and players are told so in plain words.
  const db = new SQL(stack.env.DATABASE_URL);
  await db`update installs set spent = 1000000`;
  await db.close();
  expect(await speak("One more line.")).toEqual({ status: 400, error: "Free voice is used up on this computer." });
  expect((await menu(ana, "stop", {})).status).toBe(200);
}, 60_000);

test("the menu page's usage stats land under this computer's install, never its token, and with Share usage stats off nothing reaches Community", async () => {
  const secrets = join(ben.data, "secrets.json");
  for (let i = 0; i < 100 && !existsSync(secrets); i++) await Bun.sleep(100);
  const { token } = JSON.parse(readFileSync(secrets, "utf8")).install;
  const db = new SQL(stack.env.DATABASE_URL);
  const [{ id }] = await db`select id from installs where token_hash = encode(sha256(${token}::bytea), 'hex')`;
  const session = crypto.randomUUID();
  const send = (screen: string) =>
    fetch(`${ben.base}/api/menu/events`, { method: "POST", headers: { authorization: `Bearer ${ben.key}`, "content-type": "application/json" }, body: JSON.stringify({ events: [{ session, surface: "menu", screen, action: "screen" }, { session, surface: "menu", screen, action: "create-go" }] }) });
  const rows = () => db`select screen, action, props from events where install = ${id} order by id`;
  /** Every request Community got from this install, whether or not it stored anything. */
  const requests = async () => (await db`select count(*)::int n from hits where ip = ${id} and action = 'events'`)[0].n;

  expect((await send("create")).status).toBe(204);
  for (let i = 0; i < 50 && (await rows()).length < 2; i++) await Bun.sleep(100);
  expect((await rows()).map((r: any) => [r.screen, r.action])).toEqual([["create", "screen"], ["create", "create-go"]]);
  expect((await rows())[0].props).toEqual({ version: expect.any(String), os: process.platform });
  const [{ found }] = await db`select count(*)::int found from events e where e::text like ${`%${token}%`}`;
  expect(found).toBe(0);

  expect((await menu(ben, "share-usage", { share: false })).shareUsage).toBe(false);
  const before = await requests();
  expect((await send("worlds")).status).toBe(204);
  await Bun.sleep(1000);
  expect(await requests()).toBe(before);
  expect((await rows()).length).toBe(2);

  expect((await menu(ben, "share-usage", { share: true })).shareUsage).toBe(true);
  await send("community");
  for (let i = 0; i < 50 && (await rows()).length < 4; i++) await Bun.sleep(100);
  expect((await rows()).map((r: any) => r.screen)).toEqual(["create", "create", "community", "community"]);
  await db.close();
});
