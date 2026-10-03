// Community worlds: rows in Postgres, files in R2 behind presigned URLs, and accounts for whoever publishes, votes or comments.
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
/** How often each action may happen, per hashed IP, install (or the site's anonymous id), account or email, over a fixed window. Usage stats come every 10 s from each of an install's pages, plus a last batch as one closes. Sign-in backs off from 5 a minute to 20 an hour per IP. */
const RATE = {
  publish: [10, "1 hour"],
  update: [30, "1 hour"],
  report: [10, "1 hour"],
  install: [5, "1 hour"],
  voice: [30, "1 minute"],
  events: [20, "1 minute"],
  auth: [5, "1 minute"],
  "auth-hour": [20, "1 hour"],
  "auth-email": [5, "1 minute"],
  vote: [60, "1 minute"],
  play: [30, "1 hour"],
  heartbeat: [10, "1 minute"],
  comment: [1, "20 seconds"],
} as const;
const ID = /^[a-z0-9]{12}$/;

const SITE = process.env.SITE!;
const worlds = bucketFromEnv(process.env.R2_BUCKET!);
const STORAGE = !!worlds.endpoint;
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

const cors = { "access-control-allow-origin": SITE, "access-control-allow-credentials": "true", vary: "origin" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { ...cors, ...headers } });
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const randomId = (length: number) => [...randomBytes(length)].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
const bearer = (req: Request) => req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "";

/** The client's IP, hashed; NPM, in front, names it in X-Real-IP. */
const client = (req: Request, ip: string) => sha256(`sandbox-community:${req.headers.get("x-real-ip") ?? ip}`);
/** Counts this action for whoever it is and refuses it over the limit. */
async function limit(who: string, action: keyof typeof RATE, refusal: string) {
  const [max, window] = RATE[action];
  const [{ n }] = await sql`insert into limits (who, action) values (${who}, ${action})
    on conflict (who, action) do update set
      n = case when limits.since < now() - ${window}::interval then 1 else limits.n + 1 end,
      since = case when limits.since < now() - ${window}::interval then now() else limits.since end
    returning n`;
  if (n > max) throw new Refusal(refusal, 429);
}

// ---------- accounts ----------

type Account = { id: string; email: string; username: string; created_at: Date; username_changed_at: Date | null; banned_at: Date | null };
const USERNAME = /^[a-z0-9_]{3,20}$/;
const RESERVED = new Set(["admin", "administrator", "sandbox", "community", "support", "help", "moderator", "mod", "mods", "staff", "root", "system", "official", "api", "www", "account", "settings", "null", "undefined"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_DAYS = 90;
const COOKIE = "session";

function username(raw: unknown) {
  const name = String(raw ?? "").trim().toLowerCase();
  if (!USERNAME.test(name)) throw new Refusal("A username is 3 to 20 letters, digits or _.");
  if (RESERVED.has(name)) throw new Refusal("That username is taken.");
  return name;
}
function credentials(body: any) {
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (email.length > 254 || !EMAIL.test(email)) throw new Refusal("That doesn't look like an email address.");
  if (password.length < 8 || password.length > 128) throw new Refusal("A password is 8 to 128 characters.");
  return { email, password };
}

/** Argon2 is slow on purpose; a few at a time keep a burst of sign-ins from taking the server down. */
const ARGON = { running: 0, most: 4, waiting: [] as (() => void)[] };
async function argon<T>(work: () => Promise<T>) {
  if (ARGON.running >= ARGON.most) {
    if (ARGON.waiting.length >= 64) throw new Refusal("Too many people are signing in. Try again in a moment.", 503);
    await new Promise<void>((resolve) => ARGON.waiting.push(resolve));
  } else ARGON.running++;
  try {
    return await work();
  } finally {
    const next = ARGON.waiting.shift();
    if (next) next();
    else ARGON.running--;
  }
}
const hashPassword = (password: string) => argon(() => Bun.password.hash(password, { algorithm: "argon2id" }));
const verifyPassword = (password: string, hash: string) => argon(() => Bun.password.verify(password, hash));
/** Checked against when there is no such account, so a wrong email takes as long as a wrong password. */
const NOBODY = await Bun.password.hash(randomBytes(16).toString("hex"), { algorithm: "argon2id" });

const cookie = (req: Request) => req.headers.get("cookie")?.match(/(?:^|;\s*)session=([^;]+)/)?.[1] ?? "";
/** The signed-in account: a bearer session from the desktop app, or the site's cookie. A cookie changes nothing unless the request comes from the site itself with its header, so no other page can act as the visitor. */
async function sessionOf(req: Request): Promise<Account | null> {
  let token = bearer(req);
  if (!token) {
    token = cookie(req);
    if (token && req.method !== "GET" && (req.headers.get("origin") !== SITE || req.headers.get("x-sandbox") !== "1")) return null;
  }
  return token ? accountOfToken(token) : null;
}
async function accountOfToken(token: string): Promise<Account | null> {
  const [account] = await sql`with s as (
      update sessions set last_seen = now() where token_hash = ${sha256(token)} and last_seen > now() - ${`${SESSION_DAYS} days`}::interval returning account
    ) select a.id, a.email, a.username, a.created_at, a.username_changed_at, a.banned_at from accounts a join s on s.account = a.id`;
  return (account as Account) ?? null;
}
async function signedIn(req: Request) {
  const account = await sessionOf(req);
  if (!account) throw new Refusal("Sign in first.", 401);
  return account;
}
function allowed(account: Account) {
  if (account.banned_at) throw new Refusal("This account can't do that any more.", 403);
  return account;
}

const me = (a: Account) => ({ id: a.id, email: a.email, username: a.username, createdAt: new Date(a.created_at).getTime(), usernameChangedAt: a.username_changed_at ? new Date(a.username_changed_at).getTime() : null });
/** A new session: the site gets it as a cookie it can't read, the desktop app as a token it keeps encrypted. */
async function startSession(req: Request, account: Account, ip: string, status = 200) {
  const token = randomBytes(32).toString("base64url");
  await sql`insert into sessions (token_hash, account) values (${sha256(token)}, ${account.id})`;
  await sql`insert into known_ips (account, ip) values (${account.id}, ${client(req, ip)}) on conflict do nothing`;
  if (req.headers.get("origin") === SITE)
    return json({ account: me(account) }, status, { "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` });
  return json({ account: me(account), token }, status);
}

/** Sign-up and sign-in share their limits: per IP always, and per email unless this IP has signed in to that account before. */
async function authLimits(req: Request, ip: string, email: string) {
  const who = client(req, ip);
  const refusal = "Too many tries. Wait a minute and try again.";
  await limit(who, "auth", refusal);
  await limit(who, "auth-hour", "Too many tries from here. Try again in an hour.");
  const [known] = await sql`select 1 from known_ips k join accounts a on a.id = k.account where a.email = ${email} and k.ip = ${who}`;
  if (!known) await limit(sha256(`email:${email}`), "auth-email", refusal);
}

async function signUp(req: Request, ip: string) {
  const body = await req.json();
  const { email, password } = credentials(body);
  const name = username(body.username);
  await authLimits(req, ip, email);
  const [taken] = await sql`select email = ${email} as email from accounts where email = ${email} or username = ${name} limit 1`;
  if (taken) throw new Refusal(taken.email ? "That email already has an account. Sign in instead." : "That username is taken.", 409);
  const hash = await hashPassword(password);
  const [account] = await sql`insert into accounts (email, password_hash, username) values (${email}, ${hash}, ${name}) on conflict do nothing returning *`;
  if (!account) throw new Refusal("That email or username is taken.", 409);
  return startSession(req, account as Account, ip, 201);
}

async function signIn(req: Request, ip: string) {
  const body = await req.json();
  const email = String(body.email ?? "").trim().toLowerCase().slice(0, 254);
  const password = String(body.password ?? "").slice(0, 128);
  await authLimits(req, ip, email);
  const [account] = await sql`select * from accounts where email = ${email}`;
  const right = await verifyPassword(password, account?.password_hash ?? NOBODY);
  if (!account || !right) throw new Refusal("Wrong email or password.", 401);
  return startSession(req, account as Account, ip);
}

async function signOut(req: Request) {
  const token = bearer(req) || cookie(req);
  if (token && (await sessionOf(req))) await sql`delete from sessions where token_hash = ${sha256(token)}`;
  return new Response(null, { status: 204, headers: { ...cors, "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } });
}

async function rename(req: Request) {
  const account = await signedIn(req);
  const name = username((await req.json()).username);
  if (name === account.username) return json({ account: me(account) });
  if (account.username_changed_at && Date.now() - new Date(account.username_changed_at).getTime() < 30 * 86400_000) throw new Refusal("A username can change once every 30 days.", 429);
  const [renamed] = await sql`update accounts set username = ${name}, username_changed_at = now() where id = ${account.id}
      and not exists (select 1 from accounts where username = ${name}) returning *`.catch(() => []);
  if (!renamed) throw new Refusal("That username is taken.", 409);
  return json({ account: me(renamed as Account) });
}

/** Deleting an account takes its worlds out of Community and removes its sessions, votes and comments; plays and playtime stay, no longer tied to anyone. It asks for the password again. */
async function deleteAccount(req: Request) {
  const account = await signedIn(req);
  const [row] = await sql`select password_hash from accounts where id = ${account.id}`;
  if (!(await verifyPassword(String((await req.json()).password ?? "").slice(0, 128), row.password_hash))) throw new Refusal("Wrong password.", 403);
  await logDeletion("account", account.id);
  await removeAccount(account.id);
  return new Response(null, { status: 204, headers: { ...cors, "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } });
}
export async function removeAccount(id: string) {
  for (const world of await sql`select * from worlds where account = ${id} and removed_at is null`) await takeDown(world, "account", false);
  await sql`delete from reports where reporter = ${id}`;
  await sql`delete from accounts where id = ${id}`;
}

/** Every removal is written to R2 first, so a restored backup can have them done again (replay.ts). */
async function logDeletion(kind: "account" | "world", id: string, by = "") {
  // Without R2 there are no backups either, so nothing could bring the removed rows back.
  if (!STORAGE) return;
  await files.write(`deletions/${new Date().toISOString()}-${kind}-${by ? `${by}-` : ""}${id}`, "");
}

// ---------- worlds ----------

/** A live world, its owner's username, and who may change it: its account, or, shared before accounts and not yet claimed, its owner token, which can only take it down. */
async function owned(req: Request, id: string, { token = false } = {}) {
  const [row] = await sql`select w.*, a.username from worlds w left join accounts a on a.id = w.account where w.id = ${id}`;
  if (!row) throw new Refusal("There is no such world.", 404);
  if (row.removed_at) throw new Refusal("This world was taken down.", 410);
  const account = await sessionOf(req);
  if (row.account) {
    if (account?.id !== row.account) throw new Refusal("Only whoever published this world can change it.", 403);
    return { row, account };
  }
  if (token && bearer(req) && sha256(bearer(req)) === row.owner_token_hash) return { row, account: null };
  throw new Refusal("Only whoever published this world can change it.", 403);
}

/** A world shared before accounts moves to the account that shows its owner token, once: the same account may ask again, anyone else is refused. From then on the token does nothing. */
async function claim(req: Request, id: string) {
  const account = await signedIn(req);
  const token = String((await req.json()).ownerToken ?? "");
  const [row] = await sql`select id, account, owner_token_hash, pending from worlds where id = ${id} and removed_at is null`;
  if (!row || !token || sha256(token) !== row.owner_token_hash) throw new Refusal("That isn't this world's owner token.", 403);
  const [claimed] = await sql`update worlds set account = ${account.id}, pending = null where id = ${id} and (account is null or account = ${account.id}) returning id`;
  if (!claimed) throw new Refusal("Another account already claimed this world.", 409);
  if (row.pending && !row.account) await forget(row.pending);
  return json({ id });
}

/** What a share says about the world, checked, and the sizes of the files it is about to upload. */
function details(body: any, update: boolean) {
  const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);
  const meta = {
    title: text(body.title, 60),
    description: text(body.description, 200),
    visibility: text(body.visibility, 10),
    remix_of: text(body.forkOf ?? body.remixOf, 12) || null,
    origin: text(body.origin, 40) || null,
    engine_version: text(body.engineVersion, 40),
    mods: Math.max(0, Math.floor(Number(body.mods) || 0)),
  };
  if (!meta.title) throw new Refusal("A world needs a title.");
  if (meta.visibility !== "link" && meta.visibility !== "public") throw new Refusal("Visibility is link or public.");
  if (meta.remix_of && !ID.test(meta.remix_of)) throw new Refusal("forkOf is a world id.");
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

/** A parent is a world Community has, or had: never the world itself or one of its own forks. */
async function parentOk(id: string | null, parent: string | null) {
  if (!parent) return;
  const [chain] = await sql`with recursive up (id, remix_of, depth) as (
      select id, remix_of, 0 from worlds where id = ${parent}
      union all select w.id, w.remix_of, up.depth + 1 from worlds w join up on w.id = up.remix_of where up.depth < 1000
    ) select count(*)::int n, bool_or(id = ${id ?? ""}) loops from up`;
  if (!chain.n) throw new Refusal("The world this was forked from isn't in Community.");
  if (chain.loops) throw new Refusal("A world can't be forked from itself.");
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
  if (!STORAGE) throw new Refusal("Publishing isn't available right now.", 503);
  const account = await signedIn(req);
  allowed(account);
  await limit(client(req, ip), "publish", "Too many worlds shared from here this hour. Try again later.");
  const { meta, sizes } = details(await req.json(), false);
  await parentOk(null, meta.remix_of);
  if (meta.origin && (await sql`select 1 from worlds where origin = ${meta.origin} and removed_by = 'moderator'`).length) throw new Refusal("This world was removed from Community.", 403);
  const id = randomId(12);
  await sql`insert into worlds (id, title, description, author, visibility, account, remix_of, origin, engine_version, mods)
    values (${id}, ${meta.title}, ${meta.description}, ${account.username}, ${meta.visibility}, ${account.id}, ${meta.remix_of}, ${meta.origin}, ${meta.engine_version}, ${meta.mods})`;
  return json({ id, link: `${SITE}/w/${id}`, uploads: await prepare(id, meta, sizes) }, 201);
}

async function update(req: Request, ip: string, id: string) {
  const { row, account } = await owned(req, id);
  allowed(account!);
  await limit(client(req, ip), "update", "Too many updates from here this hour. Try again later.");
  const { meta, sizes } = details(await req.json(), true);
  if (!row.remix_of) await parentOk(id, meta.remix_of);
  return json({ id, link: `${SITE}/w/${id}`, uploads: await prepare(id, meta, sizes) });
}

/** The upload landed: each file is the size it was signed for and the kind it claims, so the world goes live in one step. The parent, once set, never changes. */
async function done(req: Request, id: string) {
  const { row, account } = await owned(req, id);
  allowed(account!);
  const pending = row.pending;
  if (!pending) throw new Refusal("Nothing is waiting to be uploaded.", 409);
  for (const [kind, key] of Object.entries(pending.keys) as [Kind, string][]) {
    const file = files.file(key);
    const size = await file.stat().then((s) => s.size, () => null);
    const head = size === pending.sizes[kind] ? new Uint8Array(await file.slice(0, KINDS[kind].magic.length).arrayBuffer()) : null;
    if (!head || !KINDS[kind].magic.every((b, i) => head[i] === b)) throw new Refusal("The world's files didn't all arrive. Share it again.");
  }
  const { meta, keys, sizes } = pending;
  const [live] = await sql`update worlds set title = ${meta.title}, description = ${meta.description}, author = ${account!.username}, visibility = ${meta.visibility},
      remix_of = coalesce(remix_of, ${meta.remix_of}), origin = coalesce(${meta.origin ?? null}, origin), engine_version = ${meta.engine_version}, mods = ${meta.mods}, size = ${sizes.zip},
      zip_key = ${keys.zip}, cover_key = ${keys.cover ?? row.cover_key}, clip_key = ${keys.clip ?? row.clip_key}, pending = null, updated_at = now()
    where id = ${id} and removed_at is null and pending->>'upload' = ${pending.upload} returning *`;
  if (!live) throw new Refusal("This world changed while it uploaded. Share it again.", 409);
  const replaced = [row.zip_key, keys.cover && row.cover_key, keys.clip && row.clip_key].filter(Boolean) as string[];
  await Promise.allSettled(replaced.map((key) => files.delete(key)));
  return json(await shown({ ...live, username: account!.username }, account));
}

async function remove(req: Request, id: string) {
  const { row } = await owned(req, id, { token: true });
  await takeDown(row, "owner");
  return new Response(null, { status: 204, headers: cors });
}

/**
 * Takes a world out of Community: logged first, then the row becomes a tombstone at once (no files, no title, no owner token), so its link and its forks' "forked from" say it was removed.
 * Its files go after, retried by the sweep until R2 has let go of them. Unpublish, account deletion and a moderator's takedown all end here.
 */
export async function takeDown(row: any, by: "owner" | "account" | "moderator", log = true) {
  if (log) await logDeletion("world", row.id, by);
  const keys = [row.zip_key, row.cover_key, row.clip_key, ...Object.values(row.pending?.keys ?? {})].filter(Boolean) as string[];
  await sql`update worlds set removed_at = coalesce(removed_at, now()), removed_by = ${by}, title = '', description = '', author = '', owner_token_hash = null,
      zip_key = null, cover_key = null, clip_key = null, pending = null where id = ${row.id}`;
  if (keys.length) await sql`insert into doomed ${sql(keys.map((key) => ({ key })))} on conflict do nothing`;
  await deleteDoomed(keys);
}
async function deleteDoomed(keys: string[]) {
  await Promise.allSettled(keys.map(async (key) => (await files.delete(key), await sql`delete from doomed where key = ${key}`)));
}

/** A world as anyone sees it: no owner token, its owner's username as author, links to its files that last the hour, and whether it is the asker's own. */
async function shown(row: any, account?: Account | null) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    author: row.username ?? row.author,
    visibility: row.visibility,
    forkOf: row.remix_of,
    engineVersion: row.engine_version,
    mods: row.mods,
    size: Number(row.size),
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    link: `${SITE}/w/${row.id}`,
    zip: presign(worlds, row.zip_key),
    cover: presign(worlds, row.cover_key),
    clip: row.clip_key ? presign(worlds, row.clip_key) : null,
    votes: row.votes ?? 0,
    voted: !!row.voted,
    plays: row.plays ?? 0,
    players: row.players ?? 0,
    mine: !!account && row.account === account.id,
  };
}

/** Shares abandoned halfway leave files and rows nobody can see; a day later they go. Files of removed worlds are retried until they're gone. */
async function sweep() {
  for (const row of await sql`select * from worlds where zip_key is null and removed_at is null and created_at < now() - interval '1 day'`) {
    await forget(row.pending);
    await sql`delete from worlds where id = ${row.id} and zip_key is null and removed_at is null`;
  }
  for (const row of await sql`select id, pending from worlds where pending is not null and zip_key is not null and updated_at < now() - interval '1 day'`) {
    await forget(row.pending);
    await sql`update worlds set pending = null where id = ${row.id} and pending->>'upload' = ${row.pending.upload}`;
  }
  await deleteDoomed((await sql`select key from doomed`).map((r: { key: string }) => r.key));
  await sql`delete from limits where since < now() - interval '1 day'`;
  await sql`delete from sessions where last_seen < now() - ${`${SESSION_DAYS} days`}::interval`;
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

/** Worlds with their owner's username, their votes, and whether the asker voted. */
const worldRows = (account: Account | null) =>
  sql`select w.*, a.username, (select count(*)::int from votes v where v.world = w.id) as votes, exists(select 1 from votes v where v.world = w.id and v.account = ${account?.id ?? null}::uuid) as voted
    from worlds w left join accounts a on a.id = w.account`;
const PAGE = 50;

/** A vote is the state the asker wants, so sending it twice changes nothing. */
async function vote(req: Request, id: string) {
  const account = allowed(await signedIn(req));
  await limit(account.id, "vote", "That's a lot of votes. Wait a minute.");
  const up = (await req.json()).up === true;
  const [row] = await sql`select id from worlds where id = ${id} and zip_key is not null and removed_at is null`;
  if (!row) throw new Refusal("There is no such world.", 404);
  if (up) await sql`insert into votes (world, account) values (${id}, ${account.id}) on conflict do nothing`;
  else await sql`delete from votes where world = ${id} and account = ${account.id}`;
  const [{ votes }] = await sql`select count(*)::int as votes from votes where world = ${id}`;
  return json({ votes, voted: up });
}

// ---------- plays ----------

/** A play starts for an install (and the account signed in on it, if the app says) in a live world. From then on the install's earlier plays take no more time. */
async function startPlay(req: Request) {
  const install = await installOf(req);
  await limit(install.id, "play", "Too many plays from this computer this hour.");
  const world = String((await req.json()).world ?? "");
  const session = req.headers.get("x-session");
  const account = session ? await accountOfToken(session) : null;
  const [live] = ID.test(world) ? await sql`select id from worlds where id = ${world} and zip_key is not null and removed_at is null` : [];
  if (!live) throw new Refusal("There is no such world.", 404);
  const [play] = await sql`insert into plays (world, install, account) values (${world}, ${install.id}, ${account?.id ?? null}) returning id`;
  return json({ play: play.id }, 201);
}

/**
 * The app sends how long its play has lasted so far. It counts up to the time since the play started on this server, never less than before; a play that went past a minute updates its world's counts.
 * Replays, a second app on the same install, or a clock running fast credit nothing extra: only the install's newest play counts up.
 */
async function beat(req: Request, id: string) {
  const install = await installOf(req);
  await limit(install.id, "heartbeat", "Too many heartbeats from this computer.");
  const seconds = Math.max(0, Math.floor(Number((await req.json()).seconds) || 0));
  const [play] = UUID.test(id)
    ? await sql`update plays set seconds = greatest(seconds, least(${seconds}, extract(epoch from now() - started_at)::int)) where id = ${id} and install = ${install.id}
        and id = (select id from plays where install = ${install.id} order by started_at desc, id desc limit 1) returning world, seconds`
    : [];
  if (!play) throw new Refusal("That play has ended. Start another.", 409);
  if (play.seconds >= 60)
    await sql`update worlds set plays = c.plays, players = c.players from (select count(*)::int as plays, count(distinct install)::int as players from plays where world = ${play.world} and seconds >= 60) c where id = ${play.world}`;
  return json({ seconds: play.seconds });
}

// ---------- comments ----------

const shownComment = (c: any, account: Account | null) => ({
  id: String(c.id),
  author: c.username,
  body: c.removed_at ? "" : c.body,
  at: new Date(c.at).getTime(),
  removed: !!c.removed_at,
  mine: !!account && c.account === account.id,
  canRemove: !!account && !c.removed_at && (c.account === account.id || c.owner === account.id),
});
const COMMENT_ROWS = sql`select c.*, a.username, w.account as owner from comments c join accounts a on a.id = c.account join worlds w on w.id = c.world`;

/** A world's comments, oldest first, 100 at a time; ?after=<id> goes on from there. */
async function comments(req: Request, world: string) {
  const account = await sessionOf(req);
  const after = Number(new URL(req.url).searchParams.get("after")) || 0;
  const rows = await sql`${COMMENT_ROWS} where c.world = ${world} and c.id > ${after} and a.banned_at is null order by c.id limit 100`;
  return json(rows.map((c: any) => shownComment(c, account)));
}

async function comment(req: Request, world: string) {
  const account = allowed(await signedIn(req));
  const body = String((await req.json()).body ?? "").trim();
  if (!body || body.length > 1000) throw new Refusal("A comment is 1 to 1,000 characters.");
  const [live] = await sql`select id from worlds where id = ${world} and zip_key is not null and removed_at is null`;
  if (!live) throw new Refusal("There is no such world.", 404);
  await limit(account.id, "comment", "One comment every 20 seconds.");
  const [row] = await sql`insert into comments (world, account, body) values (${world}, ${account.id}, ${body}) returning id`;
  const [c] = await sql`${COMMENT_ROWS} where c.id = ${row.id}`;
  return json(shownComment(c, account), 201);
}

/** Its author or the owner of its world removes a comment; its words go, the row stays so the thread keeps its shape. */
async function uncomment(req: Request, id: string) {
  const account = await signedIn(req);
  const [c] = /^\d{1,18}$/.test(id) ? await sql`${COMMENT_ROWS} where c.id = ${id} and c.removed_at is null` : [];
  if (!c) throw new Refusal("There is no such comment.", 404);
  if (c.account !== account.id && c.owner !== account.id) throw new Refusal("Only its author or the world's owner removes a comment.", 403);
  await sql`update comments set removed_at = now(), removed_by = ${c.account === account.id ? "author" : "owner"}, body = '' where id = ${id}`;
  return new Response(null, { status: 204, headers: cors });
}

/** A report from one account, or one IP when signed out, counts once. */
async function report(req: Request, ip: string, kind: "comment", target: string) {
  await limit(client(req, ip), "report", "Thanks, we have your reports.");
  const [c] = /^\d{1,18}$/.test(target) ? await sql`select id from comments where id = ${target} and removed_at is null` : [];
  if (!c) throw new Refusal("There is no such comment.", 404);
  const reporter = (await sessionOf(req))?.id ?? client(req, ip);
  await sql`insert into reports (kind, target, reporter) values (${kind}, ${target}, ${reporter}) on conflict do nothing`;
  return json({ reported: true });
}

async function route(req: Request, ip: string) {
  const url = new URL(req.url);
  const at = `${req.method} ${url.pathname}`;
  if (at === "POST /installs") return register(req, ip);
  if (at === "POST /events") return events(req);
  if (at === "POST /ai/tts") return speak(req);
  if (at === "POST /ai/stt") return listen(req);
  if (at === "GET /ai/usage") return json({ used: Number((await installOf(req)).spent) / 1e6, of: ALLOWANCE / 1e6 });
  if (at === "POST /accounts") return signUp(req, ip);
  if (at === "POST /sessions") return signIn(req, ip);
  if (at === "DELETE /sessions") return signOut(req);
  if (at === "GET /account") return json({ account: me(await signedIn(req)) });
  if (at === "PATCH /account") return rename(req);
  if (at === "DELETE /account") return deleteAccount(req);
  if (at === "POST /plays") return startPlay(req);
  const [, part, part2, part3] = url.pathname.split("/");
  if (req.method === "PUT" && part === "plays" && part2 && !part3) return beat(req, part2);
  if (req.method === "DELETE" && part === "comments" && part2 && !part3) return uncomment(req, part2);
  if (req.method === "POST" && part === "comments" && part2 && part3 === "report") return report(req, ip, "comment", part2);
  if (at === "GET /account/worlds") {
    const account = await signedIn(req);
    const rows = await sql`${worldRows(account)} where w.account = ${account.id} and w.zip_key is not null and w.removed_at is null order by w.created_at desc, w.id desc`;
    return json(await Promise.all(rows.map((row: any) => shown(row, account))));
  }
  const [top, id, sub, ...rest] = url.pathname.split("/").filter(Boolean);
  if (top !== "worlds" || rest.length) throw new Refusal("Not found.", 404);
  if (id && !ID.test(id)) throw new Refusal("There is no such world.", 404);
  const verb = `${req.method} ${id ? ":id" : ""}${sub ? `/${sub}` : ""}`;
  switch (verb) {
    case "GET ": {
      // A page goes on from the last world of the one before, by that world's place in the order, ties broken by id.
      const account = await sessionOf(req);
      const after = url.searchParams.get("after") ?? "";
      // Compared in Postgres: its timestamps are finer than a JavaScript Date.
      // Most played first (by installs that played at least a minute), or newest first with ?sort=new.
      const top = url.searchParams.get("sort") !== "new";
      const cursor = !ID.test(after)
        ? sql``
        : top
          ? sql`and (w.players, w.created_at, w.id) < (select players, created_at, id from worlds where id = ${after})`
          : sql`and (w.created_at, w.id) < (select created_at, id from worlds where id = ${after})`;
      const rows = await sql`${worldRows(account)} where w.visibility = 'public' and w.zip_key is not null and w.removed_at is null and a.banned_at is null
        ${cursor} order by ${top ? sql`w.players desc,` : sql``} w.created_at desc, w.id desc limit ${PAGE}`;
      return json(await Promise.all(rows.map((row: any) => shown(row, account))));
    }
    case "POST ":
      return publish(req, ip);
    case "GET :id": {
      const account = await sessionOf(req);
      const [row] = await sql`${worldRows(account)} where w.id = ${id} and (w.zip_key is not null or w.removed_at is not null)`;
      if (!row) throw new Refusal("There is no such world.", 404);
      if (row.removed_at) throw new Refusal("This world was taken down.", 410);
      return json(await shown(row, account));
    }
    case "PUT :id":
      return update(req, ip, id!);
    case "POST :id/done":
      return done(req, id!);
    case "POST :id/claim":
      return claim(req, id!);
    case "DELETE :id":
      return remove(req, id!);
    case "PUT :id/vote":
      return vote(req, id!);
    case "GET :id/comments":
      return comments(req, id!);
    case "POST :id/comments":
      return comment(req, id!);
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
      if (req.method === "OPTIONS")
        return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE", "access-control-allow-headers": "content-type, x-sandbox", "access-control-max-age": "600" } });
      try {
        return await route(req, server.requestIP(req)?.address ?? "");
      } catch (e: any) {
        if (e instanceof Refusal) return json({ error: e.message }, e.status);
        if (e instanceof SyntaxError) return json({ error: "Send JSON." }, 400);
        // A database error can quote the values it was given, so it is logged by its code alone.
        console.error(req.method, new URL(req.url).pathname, e?.name === "PostgresError" ? `PostgresError ${e.errno ?? e.code}` : e);
        return json({ error: "Something went wrong. Try again." }, 500);
      }
    },
  });
  console.log(`community api on :${server.port}`);
}
