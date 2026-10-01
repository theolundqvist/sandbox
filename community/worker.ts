// Community worlds: one row per world in D1, its zip, cover and clip in R2. No sign-in: whoever published a world holds its owner token.
type Env = { DB: any; FILES: any; SITE: string };

const MB = 1 << 20;
/** The 62-mod world everyone plays is 39 MB zipped; Workers take request bodies up to 100 MB. */
const ZIP_LIMIT = 95 * MB;
const COVER_LIMIT = 2 * MB;
const CLIP_LIMIT = 6 * MB;
/** Per IP, per hour. */
const LIMITS: Record<string, number> = { publish: 10, upload: 30, report: 10 };
const ID = /^[a-z0-9]{12}$/;
const PUBLIC_FIELDS = "id, title, description, author, visibility, remix_of, engine_version, mods, size, cover_key, clip_key, created_at, updated_at";

const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS", "access-control-allow-headers": "authorization, content-type" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const fail = (error: string, status = 400) => json({ error }, status);

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (text: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
function randomId(length: number) {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return [...crypto.getRandomValues(new Uint8Array(length))].map((b) => alphabet[b % alphabet.length]).join("");
}

/** Counts this action for this IP and says whether it is over the hour's limit. */
async function limited(env: Env, req: Request, action: string) {
  const ip = await sha256(`sandbox-community:${req.headers.get("cf-connecting-ip") ?? "local"}`);
  const hour = Date.now() - 3600_000;
  await env.DB.prepare("delete from hits where at < ?").bind(hour).run();
  const { n } = await env.DB.prepare("select count(*) n from hits where ip = ? and action = ? and at >= ?").bind(ip, action, hour).first();
  if (n >= LIMITS[action]!) return true;
  await env.DB.prepare("insert into hits (ip, action, at) values (?, ?, ?)").bind(ip, action, Date.now()).run();
  return false;
}

/** A world's owner, by the token handed out when it was first published. */
async function owned(env: Env, req: Request, id: string) {
  const row = await env.DB.prepare("select * from worlds where id = ?").bind(id).first();
  if (!row) return { error: fail("There is no such world.", 404) };
  const token = req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "";
  if ((await sha256(token)) !== row.owner_token_hash) return { error: fail("Only whoever shared this world can change it.", 403) };
  return { row };
}

const magic = async (file: File, bytes: number[]) => {
  const head = new Uint8Array(await file.slice(0, bytes.length).arrayBuffer());
  return bytes.every((b, i) => head[i] === b);
};

/** What a publish or update says about the world, checked; files are checked for their kind and size. */
async function details(form: FormData, update: boolean) {
  const text = (name: string, max: number) => String(form.get(name) ?? "").trim().slice(0, max);
  const meta = {
    title: text("title", 60),
    description: text("description", 200),
    author: text("author", 24),
    visibility: text("visibility", 10),
    remix_of: text("remix_of", 12) || null,
    engine_version: text("engine_version", 40),
    mods: Math.max(0, Math.floor(Number(form.get("mods")) || 0)),
  };
  if (!meta.title) throw new Error("A world needs a title.");
  if (!meta.author) throw new Error("A world needs its author's name.");
  if (meta.visibility !== "link" && meta.visibility !== "public") throw new Error("Visibility is link or public.");
  if (meta.remix_of && !ID.test(meta.remix_of)) throw new Error("remix_of is a world id.");
  const cover = form.get("cover");
  const clip = form.get("clip");
  if (cover instanceof File) {
    if (cover.size > COVER_LIMIT || !(await magic(cover, [0xff, 0xd8]))) throw new Error("A cover is a JPEG under 2 MB.");
  } else if (!update) throw new Error("A world needs a cover.");
  if (clip instanceof File && (clip.size > CLIP_LIMIT || !(await magic(clip, [0x1a, 0x45, 0xdf, 0xa3])))) throw new Error("A clip is a WebM under 6 MB.");
  return { meta, cover: cover instanceof File ? cover : null, clip: clip instanceof File ? clip : null };
}

const keys = (id: string) => ({ zip: `worlds/${id}/world.zip`, cover: `worlds/${id}/cover.jpg`, clip: `worlds/${id}/clip.webm` });

async function publish(env: Env, req: Request) {
  if (await limited(env, req, "publish")) return fail("Too many worlds shared from here this hour. Try again later.", 429);
  const { meta, cover, clip } = await details(await req.formData(), false);
  const id = randomId(12);
  const ownerToken = hex(crypto.getRandomValues(new Uint8Array(24)).buffer);
  const k = keys(id);
  await env.FILES.put(k.cover, cover, { httpMetadata: { contentType: "image/jpeg" } });
  if (clip) await env.FILES.put(k.clip, clip, { httpMetadata: { contentType: "video/webm" } });
  const now = Date.now();
  await env.DB.prepare(
    "insert into worlds (id, title, description, author, visibility, owner_token_hash, remix_of, engine_version, mods, cover_key, clip_key, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, meta.title, meta.description, meta.author, meta.visibility, await sha256(ownerToken), meta.remix_of, meta.engine_version, meta.mods, k.cover, clip ? k.clip : null, now, now)
    .run();
  return json({ id, link: `${env.SITE}/w/${id}`, ownerToken }, 201);
}

async function update(env: Env, req: Request, id: string) {
  const { row, error } = await owned(env, req, id);
  if (error) return error;
  if (await limited(env, req, "upload")) return fail("Too many updates from here this hour. Try again later.", 429);
  const { meta, cover, clip } = await details(await req.formData(), true);
  const k = keys(id);
  if (cover) await env.FILES.put(k.cover, cover, { httpMetadata: { contentType: "image/jpeg" } });
  if (clip) await env.FILES.put(k.clip, clip, { httpMetadata: { contentType: "video/webm" } });
  await env.DB.prepare("update worlds set title = ?, description = ?, author = ?, visibility = ?, remix_of = ?, engine_version = ?, mods = ?, clip_key = ?, updated_at = ? where id = ?")
    .bind(meta.title, meta.description, meta.author, meta.visibility, meta.remix_of ?? row.remix_of, meta.engine_version, meta.mods, clip ? k.clip : row.clip_key, Date.now(), id)
    .run();
  return json({ id, link: `${env.SITE}/w/${id}` });
}

/** The world itself, streamed straight into R2; a world without one isn't listed or served. */
async function upload(env: Env, req: Request, id: string) {
  const { error } = await owned(env, req, id);
  if (error) return error;
  const size = Number(req.headers.get("content-length"));
  if (!size || !req.body) return fail("Send the zip with its length.", 411);
  if (size > ZIP_LIMIT) return fail("That world is over 95 MB zipped.", 413);
  if (await limited(env, req, "upload")) return fail("Too many updates from here this hour. Try again later.", 429);
  const k = keys(id);
  await env.FILES.put(k.zip, req.body, { httpMetadata: { contentType: "application/zip" } });
  await env.DB.prepare("update worlds set zip_key = ?, size = ?, updated_at = ? where id = ?").bind(k.zip, size, Date.now(), id).run();
  return json({ id, link: `${env.SITE}/w/${id}` });
}

async function remove(env: Env, req: Request, id: string) {
  const { error } = await owned(env, req, id);
  if (error) return error;
  const k = keys(id);
  await env.FILES.delete([k.zip, k.cover, k.clip]);
  await env.DB.prepare("delete from worlds where id = ?").bind(id).run();
  return new Response(null, { status: 204, headers: cors });
}

/** A world as anyone sees it: no owner token, and links to its files that change when it does. */
function shown(env: Env, row: any, base: string) {
  const v = `?v=${row.updated_at}`;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    author: row.author,
    visibility: row.visibility,
    remixOf: row.remix_of,
    engineVersion: row.engine_version,
    mods: row.mods,
    size: row.size,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    link: `${env.SITE}/w/${row.id}`,
    zip: `${base}/worlds/${row.id}/zip${v}`,
    cover: `${base}/worlds/${row.id}/cover${v}`,
    clip: row.clip_key ? `${base}/worlds/${row.id}/clip${v}` : null,
  };
}

async function file(env: Env, id: string, kind: "zip" | "cover" | "clip") {
  const row = await env.DB.prepare("select zip_key from worlds where id = ? and zip_key is not null").bind(id).first();
  const object = row && (await env.FILES.get(keys(id)[kind]));
  if (!object) return fail("There is no such world.", 404);
  const headers = new Headers(cors);
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-length", String(object.size));
  headers.set("cache-control", "public, max-age=300");
  if (kind === "zip") headers.set("content-disposition", `attachment; filename="${id}.zip"`);
  return new Response(object.body, { headers });
}

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    const base = url.origin;
    const parts = url.pathname.split("/").filter(Boolean);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (parts[0] !== "worlds") return fail("Not found.", 404);
    const [, id, sub] = parts;
    if (id && !ID.test(id)) return fail("There is no such world.", 404);
    try {
      if (!id && req.method === "GET") {
        const { results } = await env.DB.prepare(`select ${PUBLIC_FIELDS} from worlds where visibility = 'public' and zip_key is not null order by created_at desc limit 200`).all();
        return json(results.map((row: any) => shown(env, row, base)));
      }
      if (!id && req.method === "POST") return await publish(env, req);
      if (id && !sub && req.method === "GET") {
        const row = await env.DB.prepare(`select ${PUBLIC_FIELDS} from worlds where id = ? and zip_key is not null`).bind(id).first();
        return row ? json(shown(env, row, base)) : fail("There is no such world.", 404);
      }
      if (id && !sub && req.method === "PUT") return await update(env, req, id);
      if (id && !sub && req.method === "DELETE") return await remove(env, req, id);
      if (id && sub === "zip" && req.method === "PUT") return await upload(env, req, id);
      if (id && (sub === "zip" || sub === "cover" || sub === "clip") && req.method === "GET") return await file(env, id, sub);
      if (id && sub === "report" && req.method === "POST") {
        if (await limited(env, req, "report")) return fail("Thanks, we have your reports.", 429);
        const { meta } = await env.DB.prepare("update worlds set reports = reports + 1 where id = ?").bind(id).run();
        return meta.changes ? json({ reported: true }) : fail("There is no such world.", 404);
      }
      return fail("Not found.", 404);
    } catch (e: any) {
      return fail(e.message);
    }
  },
};
