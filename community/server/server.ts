// Community worlds: rows in Postgres, files in R2 behind presigned URLs, owner tokens instead of sign-in.
import { SQL } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bucketFromEnv, client as s3, presign } from "./r2";

const MB = 1 << 20;
const LIMITS = { zip: 200 * MB, cover: 2 * MB, clip: 6 * MB };
const KINDS = {
  zip: { name: "world.zip", type: "application/zip", magic: [0x50, 0x4b, 0x03, 0x04], refusal: "A world is a zip under 200 MB." },
  cover: { name: "cover.jpg", type: "image/jpeg", magic: [0xff, 0xd8], refusal: "A cover is a JPEG under 2 MB." },
  clip: { name: "clip.webm", type: "video/webm", magic: [0x1a, 0x45, 0xdf, 0xa3], refusal: "A clip is a WebM under 6 MB." },
} as const;
type Kind = keyof typeof KINDS;
/** How often each action may happen: per IP, or per install (or the site's anonymous id) for voice and usage stats. Usage stats come every 10 s from each of an install's pages, plus a last batch as one closes. */
const RATE = { publish: [10, "1 hour"], update: [30, "1 hour"], report: [10, "1 hour"], install: [5, "1 hour"], voice: [30, "1 minute"], events: [20, "1 minute"] } as const;
const ID = /^[a-z0-9]{12}$/;

const SITE = process.env.SITE!;
const worlds = bucketFromEnv(process.env.R2_BUCKET!);
const files = s3(worlds);
export const sql = process.env.DATABASE_URL
  ? new SQL(process.env.DATABASE_URL)
  : new SQL({ path: "/var/run/postgresql/.s.PGSQL.5432", username: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD, database: process.env.POSTGRES_DB });
await sql.unsafe(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));

/** A request this server turns down, with words for whoever sent it. */
class Refusal extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const cors = { "access-control-allow-origin": SITE, vary: "origin" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const randomId = (length: number) => [...randomBytes(length)].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");

/** The client's IP, hashed; NPM, in front, names it in X-Real-IP. */
const client = (req: Request, ip: string) => sha256(`sandbox-community:${req.headers.get("x-real-ip") ?? ip}`);
/** Counts this action for whoever it is and refuses it over the limit. */
async function limit(who: string, action: keyof typeof RATE, refusal: string) {
  const [max, window] = RATE[action];
  const [{ n }] = await sql`select count(*)::int n from hits where ip = ${who} and action = ${action} and at > now() - ${window}::interval`;
  if (n >= max) throw new Refusal(refusal, 429);
  await sql`insert into hits (ip, action) values (${who}, ${action})`;
}

/** A world's owner, by the token handed out when it was first shared. */
async function owned(req: Request, id: string) {
  const [row] = await sql`select * from worlds where id = ${id}`;
  if (!row) throw new Refusal("There is no such world.", 404);
  const token = req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "";
  if (sha256(token) !== row.owner_token_hash) throw new Refusal("Only whoever shared this world can change it.", 403);
  return row;
}

/** What a share says about the world, checked, and the sizes of the files it is about to upload. */
function details(body: any, update: boolean) {
  const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);
  const meta = {
    title: text(body.title, 60),
    description: text(body.description, 200),
    author: text(body.author, 24),
    visibility: text(body.visibility, 10),
    remix_of: text(body.remixOf, 12) || null,
    engine_version: text(body.engineVersion, 40),
    mods: Math.max(0, Math.floor(Number(body.mods) || 0)),
  };
  if (!meta.title) throw new Refusal("A world needs a title.");
  if (!meta.author) throw new Refusal("A world needs its author's name.");
  if (meta.visibility !== "link" && meta.visibility !== "public") throw new Refusal("Visibility is link or public.");
  if (meta.remix_of && !ID.test(meta.remix_of)) throw new Refusal("remixOf is a world id.");
  const sizes: Partial<Record<Kind, number>> = {};
  for (const kind of Object.keys(KINDS) as Kind[]) {
    const size = body.files?.[kind];
    if (size === undefined) continue;
    if (!Number.isInteger(size) || size < KINDS[kind].magic.length || size > LIMITS[kind]) throw new Refusal(KINDS[kind].refusal);
    sizes[kind] = size;
  }
  if (sizes.zip === undefined) throw new Refusal("A share sends the world's zip.");
  if (!update && sizes.cover === undefined) throw new Refusal("A world needs a cover.");
  return { meta, sizes };
}

/** Every upload gets fresh keys, so the world stays whole while it is replaced and its file URLs change when it does. */
async function prepare(id: string, meta: object, sizes: Partial<Record<Kind, number>>) {
  const upload = randomId(8);
  const keys = Object.fromEntries(Object.keys(sizes).map((kind) => [kind, `worlds/${id}/${upload}/${KINDS[kind as Kind].name}`]));
  const [old] = await sql`select pending from worlds where id = ${id}`;
  await forget(old?.pending);
  await sql`update worlds set pending = ${{ upload, meta, sizes, keys }} where id = ${id}`;
  return Object.fromEntries(Object.entries(keys).map(([kind, key]) => [kind, presign(worlds, key, { type: KINDS[kind as Kind].type, length: sizes[kind as Kind]! })]));
}

const forget = async (pending: { keys: Record<string, string> } | null | undefined) => {
  if (pending) await Promise.allSettled(Object.values(pending.keys).map((key) => files.delete(key)));
};

async function publish(req: Request, ip: string) {
  await limit(client(req, ip), "publish", "Too many worlds shared from here this hour. Try again later.");
  const { meta, sizes } = details(await req.json(), false);
  const id = randomId(12);
  const ownerToken = randomBytes(24).toString("hex");
  await sql`insert into worlds (id, title, description, author, visibility, owner_token_hash, remix_of, engine_version, mods)
    values (${id}, ${meta.title}, ${meta.description}, ${meta.author}, ${meta.visibility}, ${sha256(ownerToken)}, ${meta.remix_of}, ${meta.engine_version}, ${meta.mods})`;
  return json({ id, ownerToken, link: `${SITE}/w/${id}`, uploads: await prepare(id, meta, sizes) }, 201);
}

async function update(req: Request, ip: string, id: string) {
  await owned(req, id);
  await limit(client(req, ip), "update", "Too many updates from here this hour. Try again later.");
  const { meta, sizes } = details(await req.json(), true);
  return json({ id, link: `${SITE}/w/${id}`, uploads: await prepare(id, meta, sizes) });
}

/** The upload landed: each file is the size it was signed for and the kind it claims, so the world goes live in one step. */
async function done(req: Request, id: string) {
  const row = await owned(req, id);
  const pending = row.pending;
  if (!pending) throw new Refusal("Nothing is waiting to be uploaded.", 409);
  for (const [kind, key] of Object.entries(pending.keys) as [Kind, string][]) {
    const file = files.file(key);
    const size = await file.stat().then((s) => s.size, () => null);
    const head = size === pending.sizes[kind] ? new Uint8Array(await file.slice(0, KINDS[kind].magic.length).arrayBuffer()) : null;
    if (!head || !KINDS[kind].magic.every((b, i) => head[i] === b)) throw new Refusal("The world's files didn't all arrive. Share it again.");
  }
  const { meta, keys, sizes } = pending;
  const [live] = await sql`update worlds set title = ${meta.title}, description = ${meta.description}, author = ${meta.author}, visibility = ${meta.visibility},
      remix_of = coalesce(remix_of, ${meta.remix_of}), engine_version = ${meta.engine_version}, mods = ${meta.mods}, size = ${sizes.zip},
      zip_key = ${keys.zip}, cover_key = ${keys.cover ?? row.cover_key}, clip_key = ${keys.clip ?? row.clip_key}, pending = null, updated_at = now()
    where id = ${id} and pending->>'upload' = ${pending.upload} returning *`;
  if (!live) throw new Refusal("This world changed while it uploaded. Share it again.", 409);
  const replaced = [row.zip_key, keys.cover && row.cover_key, keys.clip && row.clip_key].filter(Boolean) as string[];
  await Promise.allSettled(replaced.map((key) => files.delete(key)));
  return json(shown(live));
}

async function remove(req: Request, id: string) {
  const row = await owned(req, id);
  await takeDown(row);
  return new Response(null, { status: 204, headers: cors });
}

/** Deletes a world and every file it has; Stop sharing and takedown both end here. */
export async function takeDown(row: any) {
  await forget(row.pending);
  await Promise.allSettled([row.zip_key, row.cover_key, row.clip_key].filter(Boolean).map((key: string) => files.delete(key)));
  await sql`delete from worlds where id = ${row.id}`;
}

/** A world as anyone sees it: no owner token, and links to its files that last the hour. */
function shown(row: any) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    author: row.author,
    visibility: row.visibility,
    remixOf: row.remix_of,
    engineVersion: row.engine_version,
    mods: row.mods,
    size: Number(row.size),
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    link: `${SITE}/w/${row.id}`,
    zip: presign(worlds, row.zip_key),
    cover: presign(worlds, row.cover_key),
    clip: row.clip_key ? presign(worlds, row.clip_key) : null,
  };
}

/** Shares abandoned halfway leave files and rows nobody can see; a day later they go. */
async function sweep() {
  for (const row of await sql`select * from worlds where zip_key is null and created_at < now() - interval '1 day'`) await takeDown(row);
  for (const row of await sql`select id, pending from worlds where pending is not null and zip_key is not null and updated_at < now() - interval '1 day'`) {
    await forget(row.pending);
    await sql`update worlds set pending = null where id = ${row.id} and pending->>'upload' = ${row.pending.upload}`;
  }
  await sql`delete from hits where at < now() - interval '1 hour'`;
}

/** Free voice for every install of the app: speech to text and text to speech through ElevenLabs, never a language model. Each install has a lifetime allowance, and everyone together a daily cap. */
const ELEVENLABS = process.env.ELEVENLABS_URL ?? "https://api.elevenlabs.io";
/** ElevenLabs' pay-as-you-go list prices, https://elevenlabs.io/pricing/api: Flash v2.5 at $0.04 per 1,000 characters, Scribe v2 at $0.22 per hour. Money is in millionths of a dollar. */
const PRICES = { ttsPerCharacter: 40, sttPerHour: 220_000 };
const ALLOWANCE = 1_000_000;
const DAILY_CAP = 20_000_000;
/** A spoken line at most, and a recording of 60 s at most, which at the 64 kbit/s browsers record speech at is under 512 KB. */
const SPEECH = { characters: 2000, seconds: 60, bytes: 512 * 1024 };
const VOICE_ID = /^[A-Za-z0-9]{8,40}$/;
const DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb";
const sttCost = (seconds: number) => Math.ceil((seconds * PRICES.sttPerHour) / 3600);

async function register(req: Request, ip: string) {
  await limit(client(req, ip), "install", "Too many new installs from here this hour. Try again later.");
  const id = randomId(12);
  const token = randomBytes(32).toString("base64url");
  await sql`insert into installs (id, token_hash) values (${id}, ${sha256(token)})`;
  return json({ id, token }, 201);
}

async function installOf(req: Request) {
  const token = req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "";
  const [row] = await sql`select id, spent from installs where token_hash = ${sha256(token)}`;
  if (!row) throw new Refusal("This computer isn't signed up for free voice.", 401);
  return row as { id: string; spent: string };
}

/** Counts the cost against this install's allowance and today's cap, or refuses when either would go over (see reserve_voice in schema.sql). Returns the day it was counted on. One statement, not sql.begin: Bun 1.3's pool can hand a transaction's connection to another query under a burst, which leaves the transaction hanging. */
async function reserve(install: string, cost: number) {
  try {
    const [{ day }] = await sql`select reserve_voice(${install}, ${cost}, ${ALLOWANCE}, ${DAILY_CAP}) as day`;
    return day as string;
  } catch (e) {
    if ((e as { errno?: string }).errno === "SV001") throw new Refusal("Free voice is used up on this computer.", 402);
    if ((e as { errno?: string }).errno === "SV002") throw new Refusal("Free voice is paused for today.", 429);
    throw e;
  }
}
/** Corrects a reservation by what the call cost after all: its whole cost back when the call failed. */
const settle = (install: string, day: string, change: number) =>
  change && sql`with mine as (update installs set spent = spent + ${change} where id = ${install}) update voice_days set spent = spent + ${change} where day = ${day}::date`;

function available() {
  if (!process.env.ELEVENLABS_API_KEY) throw new Refusal("Free voice isn't available right now.", 503);
}
function elevenLabs(path: string, body: BodyInit, headers: Record<string, string> = {}) {
  return fetch(`${ELEVENLABS}${path}`, { method: "POST", headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY!, ...headers }, body, signal: AbortSignal.timeout(60_000) }).catch(() => new Response(null, { status: 502 }));
}

async function speak(req: Request) {
  available();
  const install = await installOf(req);
  await limit(install.id, "voice", "Too much voice at once. Wait a minute.");
  const body = await req.json();
  const text = String(body.text ?? "").trim();
  if (!text) throw new Refusal("Give text to speak.");
  if (text.length > SPEECH.characters) throw new Refusal("Speech is 2,000 characters at most at a time.", 413);
  const voice = VOICE_ID.test(body.voice ?? "") ? body.voice : DEFAULT_VOICE;
  const cost = text.length * PRICES.ttsPerCharacter;
  const day = await reserve(install.id, cost);
  const res = await elevenLabs(`/v1/text-to-speech/${voice}/stream?output_format=mp3_44100_64`, JSON.stringify({ text, model_id: "eleven_flash_v2_5" }), { "content-type": "application/json" });
  if (!res.ok || !res.body) {
    await settle(install.id, day, -cost);
    console.error("tts", res.status, (await res.text()).slice(0, 300));
    throw new Refusal("Speech didn't go through. Try again.", 502);
  }
  return new Response(res.body, { headers: { "content-type": "audio/mpeg" } });
}

async function listen(req: Request) {
  available();
  const install = await installOf(req);
  if (Number(req.headers.get("content-length") ?? Infinity) > SPEECH.bytes) throw new Refusal("A recording is 60 seconds at most.", 413);
  await limit(install.id, "voice", "Too much voice at once. Wait a minute.");
  const audio = new Blob([await req.arrayBuffer()], { type: req.headers.get("content-type") ?? "audio/webm" });
  if (audio.size > SPEECH.bytes) throw new Refusal("A recording is 60 seconds at most.", 413);
  // Reserved as the longest recording, settled by how long the speech ran.
  const most = sttCost(SPEECH.seconds);
  const day = await reserve(install.id, most);
  const form = new FormData();
  form.append("file", new File([audio], `speech.${audio.type.split(/[/;]/)[1] || "webm"}`, { type: audio.type }));
  form.append("model_id", "scribe_v2");
  form.append("language_code", "eng");
  form.append("tag_audio_events", "true");
  const res = await elevenLabs("/v1/speech-to-text", form);
  if (!res.ok) {
    await settle(install.id, day, -most);
    console.error("stt", res.status, (await res.text()).slice(0, 300));
    throw new Refusal("Voice didn't go through. Try again.", 502);
  }
  const heard = await res.json();
  const seconds = Math.min(SPEECH.seconds, Math.max(1, Math.ceil(Math.max(0, ...(heard.words ?? []).map((w: { end?: number }) => w.end ?? 0)))));
  await settle(install.id, day, sttCost(seconds) - most);
  return json({ text: String(heard.text ?? "") });
}

/** Usage stats: a batch of screens shown and buttons pressed outside the game, from an install (by its token, stored only as the install's id) or from the site (by an anonymous id). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENT_NAME = /^[a-z0-9][a-z0-9:._/-]{0,63}$/;
const SURFACES = ["app", "menu", "site"];
async function events(req: Request) {
  const body = await req.json();
  const install = req.headers.has("authorization") ? (await installOf(req)).id : null;
  const anon = install ? null : String(body.anon ?? "");
  if (anon !== null && !UUID.test(anon)) throw new Refusal("Send the install's token or an anonymous id.", 401);
  const list: any[] = Array.isArray(body.events) ? body.events : [];
  if (!list.length || list.length > 50) throw new Refusal("Send 1 to 50 events at a time.");
  await limit(install ?? `anon:${anon}`, "events", "Send usage stats every 10 seconds at most.");
  const app = Object.fromEntries(["version", "os"].flatMap((k) => (typeof body.app?.[k] === "string" ? [[k, body.app[k].slice(0, 40)]] : [])));
  const rows = list.map((e) => {
    if (JSON.stringify(e).length > 4096) throw new Refusal("An event is 4 KB at most.", 413);
    const props = e.props ?? {};
    if (!SURFACES.includes(e.surface) || !EVENT_NAME.test(e.action) || (e.screen != null && !EVENT_NAME.test(e.screen)) || !UUID.test(e.session) || typeof props !== "object" || Array.isArray(props))
      throw new Refusal("An event is a session, surface, screen, action and props.");
    return { install, session: e.session, surface: e.surface, screen: e.screen ?? null, action: e.action, props: { ...props, ...app, ...(anon && { anon }) } };
  });
  await sql`insert into events ${sql(rows)}`;
  return new Response(null, { status: 204, headers: cors });
}

async function route(req: Request, ip: string) {
  const url = new URL(req.url);
  if (req.method === "POST" && url.pathname === "/installs") return register(req, ip);
  if (req.method === "POST" && url.pathname === "/events") return events(req);
  if (req.method === "POST" && url.pathname === "/ai/tts") return speak(req);
  if (req.method === "POST" && url.pathname === "/ai/stt") return listen(req);
  if (req.method === "GET" && url.pathname === "/ai/usage") return json({ used: Number((await installOf(req)).spent) / 1e6, of: ALLOWANCE / 1e6 });
  const [top, id, sub, ...rest] = url.pathname.split("/").filter(Boolean);
  if (top !== "worlds" || rest.length) throw new Refusal("Not found.", 404);
  if (id && !ID.test(id)) throw new Refusal("There is no such world.", 404);
  const verb = `${req.method} ${id ? ":id" : ""}${sub ? `/${sub}` : ""}`;
  switch (verb) {
    case "GET ":
      return json((await sql`select * from worlds where visibility = 'public' and zip_key is not null order by created_at desc limit 200`).map(shown));
    case "POST ":
      return publish(req, ip);
    case "GET :id": {
      const [row] = await sql`select * from worlds where id = ${id} and zip_key is not null`;
      if (!row) throw new Refusal("There is no such world.", 404);
      return json(shown(row));
    }
    case "PUT :id":
      return update(req, ip, id!);
    case "POST :id/done":
      return done(req, id!);
    case "DELETE :id":
      return remove(req, id!);
    case "POST :id/report": {
      await limit(client(req, ip), "report", "Thanks, we have your reports.");
      const [row] = await sql`update worlds set reports = reports + 1 where id = ${id} and zip_key is not null returning id`;
      if (!row) throw new Refusal("There is no such world.", 404);
      return json({ reported: true });
    }
  }
  throw new Refusal("Not found.", 404);
}

if (import.meta.main) {
  setInterval(() => sweep().catch((e) => console.error("sweep", e)), 3600_000);
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 9200),
    // Room for a 60 s recording; every other body is a little JSON.
    maxRequestBodySize: 600 * 1024,
    async fetch(req, server) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type" } });
      try {
        return await route(req, server.requestIP(req)?.address ?? "");
      } catch (e: any) {
        if (e instanceof Refusal) return json({ error: e.message }, e.status);
        if (e instanceof SyntaxError) return json({ error: "Send JSON." }, 400);
        console.error(req.method, new URL(req.url).pathname, e);
        return json({ error: "Something went wrong. Try again." }, 500);
      }
    },
  });
  console.log(`community api on :${server.port}`);
}
