// Community mods: one mod of a world, published on its own so any world's agent can find it, read its API and add it. A mod is a worlds row of kind 'mod', so comments, votes, reports, forks and takedown go through the world routes.
import { allowed, builders, client, installOf, json, limit, listed, owned, parentOf, prepare, randomId, Refusal, sessionOf, shown, signedIn, SITE, sql, STORAGE, worldRows } from "./server";

const MB = 1 << 20;
const ID = /^[a-z0-9]{12}$/;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const PACKAGE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;
const VERSION = /^[\w.^~<>=*|@:/+ -]{1,60}$/;
const WORLD_KEY = /^[a-z0-9-]{12,36}$/;
const PAGE = 50;

const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);

/** What a mod's share says about it, checked: its folder name, README, the API it exports, the npm packages and other mods it needs, and the sizes of its zip and preview picture. */
function details(body: any, update: boolean) {
  const name = text(body.name, 32);
  if (!NAME.test(name)) throw new Refusal("A mod's name is its folder name: lowercase letters, digits and dashes.");
  const packages = body.packages ?? {};
  if (typeof packages !== "object" || Array.isArray(packages) || Object.keys(packages).length > 30 || !Object.entries(packages).every(([k, v]) => PACKAGE.test(k) && VERSION.test(String(v))))
    throw new Refusal("Packages are up to 30 npm names with their versions.");
  const needs = Array.isArray(body.needs) ? body.needs.map(String) : [];
  if (needs.length > 20 || !needs.every((n: string) => NAME.test(n))) throw new Refusal("needs lists the other mods this one uses, by name.");
  const meta = {
    title: text(body.title, 60) || name,
    description: text(body.description, 200),
    visibility: "public",
    remix_of: text(body.forkOf, 12) || null,
    origin: null,
    engine_version: text(body.engineVersion, 40),
    mods: 1,
    mod: { name, readme: text(body.readme, 20_000), api: text(body.api, 20_000), packages, needs },
  };
  if (meta.remix_of && !ID.test(meta.remix_of)) throw new Refusal("forkOf is a mod's id.");
  const zip = body.files?.zip;
  const cover = body.files?.cover;
  if (!Number.isInteger(zip) || zip < 4 || zip > 20 * MB) throw new Refusal("A mod is a zip under 20 MB.");
  if (cover !== undefined && (!Number.isInteger(cover) || cover < 2 || cover > 2 * MB)) throw new Refusal("A preview is a JPEG under 2 MB.");
  if (!update && cover === undefined) throw new Refusal("A mod needs a preview picture.");
  return { meta, sizes: { zip, ...(cover !== undefined && { cover }) } };
}

/** A fork of a mod comes from a mod Community has, or had. */
async function parentMod(id: string | null, parent: string | null) {
  if (!parent) return;
  const [p] = await sql`select kind from worlds where id = ${parent}`;
  if (!p || p.kind !== "mod") throw new Refusal("The mod this was forked from isn't in Community.");
  if (parent === id) throw new Refusal("A mod can't be forked from itself.");
}

async function publish(req: Request, ip: string) {
  if (!STORAGE) throw new Refusal("Publishing isn't available right now.", 503);
  const account = allowed(await signedIn(req));
  await limit(client(req, ip), "publish", "Too many shared from here this hour. Try again later.");
  const { meta, sizes } = details(await req.json(), false);
  await parentMod(null, meta.remix_of);
  const id = randomId(12);
  await sql`insert into worlds (id, kind, title, description, author, visibility, account, remix_of, engine_version, mods)
    values (${id}, 'mod', ${meta.title}, ${meta.description}, ${account.username}, 'public', ${account.id}, ${meta.remix_of}, ${meta.engine_version}, 1)`;
  return json({ id, link: `${SITE}/m/${id}`, uploads: await prepare(id, meta, sizes) }, 201);
}

async function update(req: Request, ip: string, id: string) {
  const { row, account } = await owned(req, id);
  if (row.kind !== "mod") throw new Refusal("There is no such mod.", 404);
  allowed(account!);
  await limit(client(req, ip), "update", "Too many updates from here this hour. Try again later.");
  const { meta, sizes } = details(await req.json(), true);
  if (!row.remix_of) await parentMod(id, meta.remix_of);
  return json({ id, link: `${SITE}/m/${id}`, uploads: await prepare(id, meta, sizes) });
}

/** A mod as a list shows it: a world's fields, its name, a one-line description and how many worlds added it. */
async function shownMod(row: any, account: Awaited<ReturnType<typeof sessionOf>>) {
  const { clip, players, plays, visibility, ...rest } = await shown(row, account);
  return { ...rest, name: row.mod?.name ?? "", uses: row.uses ?? 0 };
}

/** Listed mods, most used first or newest first with ?sort=new; ?q= finds words in a mod's title, name, description or README. 50 at a time from ?after=<id>. */
async function search(req: Request) {
  const url = new URL(req.url);
  const account = await sessionOf(req);
  const q = text(url.searchParams.get("q"), 100);
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const top = url.searchParams.get("sort") !== "new";
  const after = url.searchParams.get("after") ?? "";
  const cursor = !ID.test(after)
    ? sql``
    : top
      ? sql`and (w.uses, w.created_at, w.id) < (select uses, created_at, id from worlds where id = ${after})`
      : sql`and (w.created_at, w.id) < (select created_at, id from worlds where id = ${after})`;
  const matching = q
    ? sql`and (w.title ilike ${like} or w.description ilike ${like} or w.mod->>'name' ilike ${like} or w.mod->>'readme' ilike ${like})`
    : sql``;
  const rows = await sql`${worldRows(account)} where ${listed()} and w.kind = 'mod' ${matching} ${cursor}
    order by ${top ? sql`w.uses desc,` : sql``} w.created_at desc, w.id desc limit ${PAGE}`;
  return json(await Promise.all(rows.map((row: any) => shownMod(row, account))));
}

/** A mod's page: everything a list shows, its README and API, what it needs, where it was forked from, its forks and its builders. */
async function one(req: Request, id: string) {
  const account = await sessionOf(req);
  const [row] = await sql`${worldRows(account)} where w.id = ${id} and w.kind = 'mod' and (w.zip_key is not null or w.removed_at is not null)`;
  if (!row) throw new Refusal("There is no such mod.", 404);
  if (row.removed_at) throw new Refusal("This mod was taken down.", 410);
  const [{ forks }] = await sql`select count(*)::int as forks from worlds w left join accounts a on a.id = w.account where w.remix_of = ${id} and ${listed()}`;
  return json({
    ...(await shownMod(row, account)),
    readme: row.mod?.readme ?? "",
    api: row.mod?.api ?? "",
    packages: row.mod?.packages ?? {},
    needs: row.mod?.needs ?? [],
    parent: await parentOf(row.remix_of),
    forks,
    builders: [row.username ?? row.author, ...(await builders(id))],
  });
}

/** Uses count each world once, by the random id it keeps on its computer, and only from an install of the app. */
async function used(req: Request, id: string) {
  const install = await installOf(req);
  await limit(install.id, "mod-use", "Too many mods added from this computer this hour.");
  const world = String((await req.json()).world ?? "");
  if (!WORLD_KEY.test(world)) throw new Refusal("Send the world's id.");
  const [mod] = await sql`select id from worlds where id = ${id} and kind = 'mod' and zip_key is not null and removed_at is null`;
  if (!mod) throw new Refusal("There is no such mod.", 404);
  const [added] = await sql`insert into mod_uses (mod, world_key, install) values (${id}, ${world}, ${install.id}) on conflict do nothing returning 1`;
  const [{ uses }] = added
    ? await sql`update worlds set uses = (select count(*)::int from mod_uses where mod = ${id}) where id = ${id} returning uses`
    : await sql`select uses from worlds where id = ${id}`;
  return json({ uses });
}

export async function mods(req: Request, ip: string) {
  const [, , id, sub, ...rest] = new URL(req.url).pathname.split("/");
  if (rest.length || (id && !ID.test(id))) throw new Refusal("There is no such mod.", 404);
  const verb = `${req.method} ${id ? ":id" : ""}${sub ? `/${sub}` : ""}`;
  if (verb === "GET ") return search(req);
  if (verb === "POST ") return publish(req, ip);
  if (verb === "GET :id") return one(req, id!);
  if (verb === "PUT :id") return update(req, ip, id!);
  if (verb === "POST :id/uses") return used(req, id!);
  throw new Refusal("Not found.", 404);
}
