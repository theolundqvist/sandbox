// The admin panel at /admin: no script, its own session (cookie `admin`, Path=/admin, SameSite=Strict), and every action a same-origin POST with a CSRF token.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { client, limit, NOBODY, Refusal, sql, takeDown, verifyPassword } from "./server";

const ORIGIN = process.env.ADMIN_ORIGIN ?? "https://sandbox.api.lundqvistliss.com";
const SITE = process.env.SITE!;
/** An admin session ends after this long idle, and after the longer time in any case. */
const IDLE = "2 hours";
const MOST = "12 hours";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const csrfOf = (token: string) => sha256(`sandbox-admin-csrf:${token}`);
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Admin = { id: string; username: string; csrf: string };
const tokenOf = (req: Request) => req.headers.get("cookie")?.match(/(?:^|;\s*)admin=([^;]+)/)?.[1] ?? "";
async function adminOf(req: Request): Promise<Admin | null> {
  const token = tokenOf(req);
  if (!token) return null;
  // The flag is checked on every request, so taking it away ends every admin session at once.
  const [a] = await sql`with s as (
      update admin_sessions set last_seen = now() where token_hash = ${sha256(token)} and last_seen > now() - ${IDLE}::interval and created_at > now() - ${MOST}::interval returning account
    ) select a.id, a.username from accounts a join s on s.account = a.id where a.admin and a.banned_at is null`;
  return a ? { id: a.id, username: a.username, csrf: csrfOf(token) } : null;
}

/** Only this page may act: a POST names this origin, and the browser says it came from the same origin. Any page may link here, but nothing elsewhere can embed or load it. */
function fromHere(req: Request) {
  const site = req.headers.get("sec-fetch-site");
  if (req.method === "GET") return !site || site === "none" || site === "same-origin" || req.headers.get("sec-fetch-mode") === "navigate";
  return req.headers.get("origin") === ORIGIN && (!site || site === "same-origin");
}

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; font-src ${SITE}; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  // With no-referrer, Chrome sends Origin: null on the panel's own form posts, which the origin check then refuses.
  "referrer-policy": "same-origin",
};
const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { ...HEADERS, ...headers } });
const back = (to: string, headers: Record<string, string> = {}) => new Response(null, { status: 303, headers: { ...HEADERS, location: to, ...headers } });

const NAV = [
  ["/admin", "Counts"],
  ["/admin/worlds", "Worlds"],
  ["/admin/comments", "Comments"],
  ["/admin/messages", "Messages"],
  ["/admin/accounts", "Accounts"],
] as const;
const STYLE = `
@font-face { font-family: "Archivo Expanded"; src: url(${SITE}/fonts/archivo-expanded.woff2) format("woff2"); font-weight: 600 900; }
:root { --text: #f3f1ec; --dim: #8f8c86; --line: rgba(255,255,255,.12); --accent: #ffb547; --err: #ff6b5b; --display: "Archivo Expanded", "Helvetica Neue", Arial, system-ui, sans-serif; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #1b1b1d; color: var(--text); font: 15px/1.45 system-ui, sans-serif; }
main { padding: 48px 96px 72px; max-width: 1400px; }
h1 { margin: 0 0 28px; font: 900 48px/1 var(--display); letter-spacing: .02em; text-transform: uppercase; }
nav { display: flex; flex-wrap: wrap; gap: 8px 28px; align-items: center; margin-bottom: 40px; font: 700 13px/1 var(--display); letter-spacing: .14em; text-transform: uppercase; }
nav a { color: var(--dim); text-decoration: none; padding: 6px 0; border-bottom: 2px solid transparent; }
nav a:hover, nav a.on { color: var(--text); border-color: var(--accent); }
nav form { margin-left: auto; }
table { border-collapse: collapse; width: 100%; }
th { text-align: left; font: 700 12px/1 var(--display); letter-spacing: .12em; text-transform: uppercase; color: var(--dim); padding: 0 16px 12px 0; white-space: nowrap; }
th a { color: inherit; text-decoration: none; }
th a:hover, th a.on { color: var(--text); }
td { padding: 10px 16px 10px 0; border-top: 1px solid var(--line); vertical-align: top; }
td.date { white-space: nowrap; }
tr.total td { color: var(--accent); font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.body { max-width: 520px; white-space: pre-wrap; overflow-wrap: anywhere; }
td a { color: var(--text); }
td .dim, .dim { color: var(--dim); }
td form { display: inline; }
button { padding: 6px 10px; background: none; border: 1px solid rgba(255,255,255,.35); color: var(--text); font: 700 11px/1 var(--display); letter-spacing: .12em; text-transform: uppercase; cursor: pointer; }
button:hover, button:focus-visible { background: var(--accent); border-color: var(--accent); color: #0b0b0c; outline: none; }
button.danger:hover, button.danger:focus-visible { background: var(--err); border-color: var(--err); }
td.actions { white-space: nowrap; text-align: right; }
td.actions form + form { margin-left: 8px; }
h2 { margin: 48px 0 16px; font: 700 14px/1.2 var(--display); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
.empty { color: var(--dim); }
.login { display: flex; flex-direction: column; gap: 16px; max-width: 400px; }
.login label { display: flex; flex-direction: column; gap: 6px; color: var(--dim); font: 700 12px/1 var(--display); letter-spacing: .12em; text-transform: uppercase; }
input { padding: 10px 12px; background: #111113; border: 1px solid var(--line); color: var(--text); font: 16px system-ui, sans-serif; }
input:focus { outline: none; border-color: var(--accent); }
.login button { align-self: flex-start; padding: 10px 16px; }
.error { color: var(--err); margin: 0 0 20px; }
@media (max-width: 760px) { main { padding: 28px 16px 48px; } h1 { font-size: 32px; } .scroll { overflow-x: auto; } }
`;
function page(title: string, body: string, admin: Admin | null, path = "") {
  const nav = admin
    ? `<nav>${NAV.map(([href, name]) => `<a href="${href}"${href === path ? ' class="on"' : ""}>${name}</a>`).join("")}${action("/admin/logout", admin, "Sign out")}</nav>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · Sandbox admin</title><style>${STYLE}</style></head><body><main>${nav}<h1>${esc(title)}</h1>${body}</main></body></html>`;
}
/** A button that POSTs to this page with the session's CSRF token, and where to come back to. */
const action = (to: string, admin: Admin, label: string, danger = false, from = "") =>
  `<form method="post" action="${esc(to)}"><input type="hidden" name="csrf" value="${admin.csrf}">${from ? `<input type="hidden" name="back" value="${esc(from)}">` : ""}<button${danger ? ' class="danger"' : ""}>${esc(label)}</button></form>`;

type Column = { key: string; label: string; kind: "text" | "num" | "date"; show?: (row: any) => string };
/** A table whose every column sorts, by links that carry the sort in the address. */
function table(rows: any[], columns: Column[], url: URL, fallback: string, actions?: (row: any) => string, pinned: any[] = []) {
  if (!rows.length) return `<p class="empty">Nothing here.</p>`;
  const sortKey = columns.some((c) => c.key === url.searchParams.get("sort")) ? url.searchParams.get("sort")! : fallback;
  const column = columns.find((c) => c.key === sortKey)!;
  const up = url.searchParams.get("dir") === "asc";
  const value = (row: any) => (column.kind === "num" ? Number(row[sortKey] ?? 0) : column.kind === "date" ? new Date(row[sortKey] ?? 0).getTime() : String(row[sortKey] ?? "").toLowerCase());
  const sorted = [...rows].sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    return (x < y ? -1 : x > y ? 1 : 0) * (up ? 1 : -1);
  });
  const link = (c: Column) => {
    const next = new URLSearchParams(url.searchParams);
    next.set("sort", c.key);
    next.set("dir", c.key === sortKey && !up ? "asc" : "desc");
    return `<a href="?${esc(next.toString())}"${c.key === sortKey ? ' class="on"' : ""}>${esc(c.label)}${c.key === sortKey ? (up ? " ↑" : " ↓") : ""}</a>`;
  };
  const cell = (c: Column, row: any) => {
    const v = row[c.key];
    const shown = c.show ? c.show(row) : c.kind === "date" ? (v ? new Date(v).toISOString().slice(0, 16).replace("T", " ") : "") : esc(v);
    return `<td class="${c.kind === "text" && c.key === "body" ? "body" : c.kind}">${shown}</td>`;
  };
  return `<div class="scroll"><table><thead><tr>${columns.map((c) => `<th class="${c.kind === "num" ? "num" : ""}">${link(c)}</th>`).join("")}${actions ? "<th></th>" : ""}</tr></thead><tbody>${[...pinned, ...sorted]
    .map((row) => `<tr${row.total ? ' class="total"' : ""}>${columns.map((c) => cell(c, row)).join("")}${actions ? `<td class="actions">${actions(row)}</td>` : ""}</tr>`)
    .join("")}</tbody></table></div>`;
}

const loginPage = (error = "", status = 200) =>
  html(
    page(
      "Admin",
      `${error ? `<p class="error">${esc(error)}</p>` : ""}<form class="login" method="post" action="/admin/login"><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form>`,
      null,
    ),
    status,
  );

async function login(req: Request, ip: string) {
  const form = await req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  try {
    await limit(client(req, ip), "auth", "Too many tries. Wait a minute and try again.");
    await limit(sha256(`sandbox-admin:${email}`), "auth", "Too many tries. Wait a minute and try again.");
  } catch (e) {
    if (e instanceof Refusal) return loginPage(e.message, 429);
    throw e;
  }
  const [a] = email ? await sql`select id, password_hash, admin, banned_at from accounts where email = ${email}` : [];
  const ok = await verifyPassword(password, a?.password_hash ?? NOBODY);
  if (!a || !ok) return loginPage("Wrong email or password.", 401);
  if (!a.admin || a.banned_at) return loginPage("This account isn't an admin.", 403);
  const token = randomBytes(32).toString("base64url");
  await sql`delete from admin_sessions where created_at < now() - ${MOST}::interval`;
  await sql`insert into admin_sessions (token_hash, account) values (${sha256(token)}, ${a.id})`;
  return back("/admin", { "set-cookie": `admin=${token}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=43200` });
}

async function counts(url: URL, admin: Admin) {
  const days = await sql`with days as (select generate_series((now() at time zone 'utc')::date - 29, (now() at time zone 'utc')::date, interval '1 day')::date as day),
      i as (select (created_at at time zone 'utc')::date as day, count(*) as n from installs where created_at > now() - interval '31 days' group by 1),
      a as (select (created_at at time zone 'utc')::date as day, count(*) as n from accounts where created_at > now() - interval '31 days' group by 1),
      w as (select (created_at at time zone 'utc')::date as day, count(*) filter (where kind = 'world') as n, count(*) filter (where kind = 'mod') as mods from worlds where created_at > now() - interval '31 days' and (zip_key is not null or removed_at is not null) group by 1),
      p as (select (started_at at time zone 'utc')::date as day, count(*) as n, count(distinct install) as players from plays where started_at > now() - interval '31 days' and seconds >= 60 group by 1),
      e as (select (at at time zone 'utc')::date as day, count(*) as n from events where at > now() - interval '31 days' group by 1)
    select d.day, coalesce(i.n, 0)::int as installs, coalesce(a.n, 0)::int as accounts, coalesce(w.n, 0)::int as worlds, coalesce(w.mods, 0)::int as mods, coalesce(p.n, 0)::int as plays, coalesce(p.players, 0)::int as players, coalesce(e.n, 0)::int as events
    from days d left join i using (day) left join a using (day) left join w using (day) left join p using (day) left join e using (day)`;
  const [all] = await sql`select (select count(*) from installs)::int as installs, (select count(*) from accounts)::int as accounts,
      (select count(*) from worlds where kind = 'world' and zip_key is not null and removed_at is null)::int as worlds,
      (select count(*) from worlds where kind = 'mod' and zip_key is not null and removed_at is null)::int as mods, (select count(*) from plays where seconds >= 60)::int as plays,
      (select count(distinct install) from plays where seconds >= 60)::int as players, (select count(*) from events)::int as events`;
  const columns: Column[] = [
    { key: "installs", label: "Installs", kind: "num" },
    { key: "accounts", label: "Accounts", kind: "num" },
    { key: "worlds", label: "Worlds", kind: "num" },
    { key: "mods", label: "Mods", kind: "num" },
    { key: "plays", label: "Plays", kind: "num" },
    { key: "players", label: "Players", kind: "num" },
    { key: "events", label: "Events", kind: "num" },
  ];
  const perDay = table(days, [{ key: "day", label: "Day (UTC)", kind: "date", show: (d) => (d.total ? "All time" : new Date(d.day).toISOString().slice(0, 10)) }, ...columns], url, "day", undefined, [{ ...all, total: true }]);
  return page("Counts", `${perDay}<p class="dim">Worlds and mods are those published, plays last at least a minute, and players are installs with such a play.</p>`, admin, "/admin");
}

/** A world's page on the site, or a mod's. */
const pageOf = (kind: string, id: string) => `${SITE}/${kind === "mod" ? "m" : "w"}/${esc(id)}`;
const stateOf = (w: any) => (w.removed_at ? "Taken down" : w.banned_at ? "Owner banned" : w.visibility === "public" ? "Listed" : "Link only");
async function worldsPage(url: URL, admin: Admin) {
  const rows = await sql`select w.id, w.kind, w.title, coalesce(a.username, w.author) as author, w.reports, w.uses, w.players, w.plays, w.created_at, w.visibility, w.removed_at, a.banned_at
    from worlds w left join accounts a on a.id = w.account where w.zip_key is not null order by w.reports desc, w.created_at desc limit 500`;
  for (const r of rows) r.state = stateOf(r);
  const here = url.pathname + url.search;
  return page(
    "Worlds",
    table(
      rows,
      [
        { key: "title", label: "World", kind: "text", show: (w) => (w.removed_at ? esc(w.title) : `<a href="${pageOf(w.kind, w.id)}">${esc(w.title)}</a>`) },
        { key: "kind", label: "Kind", kind: "text" },
        { key: "author", label: "By", kind: "text" },
        { key: "reports", label: "Reports", kind: "num" },
        { key: "players", label: "Players", kind: "num" },
        { key: "plays", label: "Plays", kind: "num" },
        { key: "uses", label: "Uses", kind: "num" },
        { key: "created_at", label: "Published", kind: "date" },
        { key: "state", label: "State", kind: "text" },
      ],
      url,
      "reports",
      (w) =>
        w.removed_at
          ? action(`/admin/worlds/${w.id}/restore`, admin, "Restore", false, here) + action(`/admin/worlds/${w.id}/delete`, admin, "Delete for good", true, here)
          : action(`/admin/worlds/${w.id}/takedown`, admin, "Take down", true, here),
    ) + `<p class="dim">A world taken down here leaves Community and its link, and keeps its files until it is restored or deleted for good.</p>`,
    admin,
    "/admin/worlds",
  );
}

async function commentsPage(url: URL, admin: Admin) {
  const rows = await sql`select c.id, c.body, a.username, c.world, w.kind, w.title, c.at, count(r.*)::int as reports
    from comments c join accounts a on a.id = c.account join worlds w on w.id = c.world join reports r on r.kind = 'comment' and r.target = c.id::text
    where c.removed_at is null group by c.id, a.username, w.kind, w.title limit 500`;
  const here = url.pathname + url.search;
  return page(
    "Reported comments",
    table(
      rows,
      [
        { key: "body", label: "Comment", kind: "text" },
        { key: "username", label: "By", kind: "text" },
        { key: "title", label: "On", kind: "text", show: (c) => `<a href="${pageOf(c.kind, c.world)}">${esc(c.title) || '<span class="dim">removed world</span>'}</a>` },
        { key: "reports", label: "Reports", kind: "num" },
        { key: "at", label: "Posted", kind: "date" },
      ],
      url,
      "reports",
      (c) => action(`/admin/comments/${c.id}/remove`, admin, "Remove", true, here),
    ),
    admin,
    "/admin/comments",
  );
}

async function messagesPage(url: URL, admin: Admin) {
  // Moderators see a message only once one of its two parties reported it.
  const rows = await sql`select m.id, m.body, s.id as sender_id, s.username as sender, s.banned_at, t.username as recipient, m.at, count(r.*)::int as reports
    from messages m join accounts s on s.id = m.sender join accounts t on t.id = m.recipient join reports r on r.kind = 'message' and r.target = m.id::text
    group by m.id, s.id, t.username limit 500`;
  const here = url.pathname + url.search;
  return page(
    "Reported messages",
    table(
      rows,
      [
        { key: "body", label: "Message", kind: "text" },
        { key: "sender", label: "From", kind: "text" },
        { key: "recipient", label: "To", kind: "text" },
        { key: "reports", label: "Reports", kind: "num" },
        { key: "at", label: "Sent", kind: "date" },
      ],
      url,
      "at",
      (m) => (m.banned_at ? `<span class="dim">Sender banned</span>` : action(`/admin/accounts/${m.sender_id}/ban`, admin, "Ban sender", true, here)),
    ),
    admin,
    "/admin/messages",
  );
}

async function accountsPage(url: URL, admin: Admin) {
  const rows = await sql`select a.id, a.username, a.email, a.created_at, a.banned_at, a.admin,
      (select count(*) from worlds w where w.account = a.id and w.zip_key is not null and w.removed_at is null)::int as worlds,
      (select count(*) from comments c where c.account = a.id and c.removed_at is null)::int as comments,
      ((select coalesce(sum(w.reports), 0) from worlds w where w.account = a.id)
        + (select count(*) from reports r join comments c on r.kind = 'comment' and r.target = c.id::text where c.account = a.id)
        + (select count(*) from reports r join messages m on r.kind = 'message' and r.target = m.id::text where m.sender = a.id))::int as reports
    from accounts a order by a.created_at desc limit 1000`;
  for (const r of rows) r.state = r.banned_at ? "Banned" : r.admin ? "Admin" : "";
  const here = url.pathname + url.search;
  return page(
    "Accounts",
    table(
      rows,
      [
        { key: "username", label: "Username", kind: "text", show: (a) => `<a href="${SITE}/u/${esc(a.username)}">${esc(a.username)}</a>` },
        { key: "email", label: "Email", kind: "text" },
        { key: "created_at", label: "Joined", kind: "date" },
        { key: "worlds", label: "Worlds", kind: "num" },
        { key: "comments", label: "Comments", kind: "num" },
        { key: "reports", label: "Reports", kind: "num" },
        { key: "state", label: "State", kind: "text" },
      ],
      url,
      "reports",
      (a) =>
        a.id === admin.id ? "" : a.banned_at ? action(`/admin/accounts/${a.id}/unban`, admin, "Unban", false, here) : action(`/admin/accounts/${a.id}/ban`, admin, "Ban", true, here),
    ) + `<p class="dim">A banned account can't publish, comment or message, and its worlds leave Community.</p>`,
    admin,
    "/admin/accounts",
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORLD = /^[a-z0-9]{12}$/;
/** The admin actions, each by its path; each says what it changed, or refuses. */
async function act(path: string, admin: Admin) {
  const [, , kind, id, verb] = path.split("/");
  if (kind === "worlds" && WORLD.test(id ?? "")) {
    // Taken down here, a world is hidden as a moderator's takedown but keeps its files and words, so it can come back.
    if (verb === "takedown") return (await sql`update worlds set removed_at = now(), removed_by = 'moderator' where id = ${id} and removed_at is null and zip_key is not null returning id`).length;
    if (verb === "restore") return (await sql`update worlds set removed_at = null, removed_by = null where id = ${id} and removed_by = 'moderator' and zip_key is not null returning id`).length;
    if (verb === "delete") {
      const [row] = await sql`select * from worlds where id = ${id} and removed_by = 'moderator' and zip_key is not null`;
      if (row) await takeDown(row, "moderator");
      return row ? 1 : 0;
    }
  }
  if (kind === "comments" && /^\d{1,18}$/.test(id ?? "") && verb === "remove")
    return (await sql`update comments set removed_at = now(), removed_by = 'moderator', body = '' where id = ${id} and removed_at is null returning id`).length;
  if (kind === "accounts" && UUID.test(id ?? "") && id !== admin.id) {
    if (verb === "ban") return (await sql`update accounts set banned_at = now() where id = ${id} and banned_at is null returning id`).length;
    if (verb === "unban") return (await sql`update accounts set banned_at = null where id = ${id} and banned_at is not null returning id`).length;
  }
  return null;
}

export async function admin(req: Request, ip: string) {
  const url = new URL(req.url);
  if (!fromHere(req)) return html(page("Refused", `<p>Admin pages work only from ${esc(ORIGIN)}/admin itself.</p>`, null), 403);
  if (req.method === "POST" && url.pathname === "/admin/login") return login(req, ip);
  const who = await adminOf(req);
  if (req.method === "GET") {
    if (!who) return loginPage();
    if (url.pathname === "/admin") return html(await counts(url, who));
    if (url.pathname === "/admin/worlds") return html(await worldsPage(url, who));
    if (url.pathname === "/admin/comments") return html(await commentsPage(url, who));
    if (url.pathname === "/admin/messages") return html(await messagesPage(url, who));
    if (url.pathname === "/admin/accounts") return html(await accountsPage(url, who));
    return html(page("Not found", "", who), 404);
  }
  if (req.method !== "POST") return html(page("Not found", "", who), 404);
  if (!who) return html(page("Refused", `<p>Sign in as an admin first.</p>`, null), 403);
  const form = await req.formData();
  if (!same(String(form.get("csrf") ?? ""), who.csrf)) return html(page("Refused", `<p>That form is out of date. Go back and try again.</p>`, who), 403);
  if (url.pathname === "/admin/logout") {
    await sql`delete from admin_sessions where token_hash = ${sha256(tokenOf(req))}`;
    return back("/admin", { "set-cookie": "admin=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0" });
  }
  const changed = await act(url.pathname, who);
  if (changed === null) return html(page("Not found", "", who), 404);
  const to = String(form.get("back") ?? "");
  return back(/^\/admin(\/[a-z]+)?(\?[^\s]*)?$/.test(to) ? to : "/admin");
}
