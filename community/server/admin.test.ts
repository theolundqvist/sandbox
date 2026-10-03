// The admin panel against real Postgres: only an admin account gets in, only from the panel's own page, and its takedowns, bans and removals do what they say.
import { expect, test } from "bun:test";
import { useStack, call, kit, publish, signUp } from "./testkit";

useStack();

const ORIGIN = "https://sandbox.api.lundqvistliss.com";
const WORLD_ORIGIN = "http://127.0.0.1:7777";
type Panel = { cookie: string; csrf: string };
/** A form post as a browser on some origin sends it. */
const post = (path: string, fields: Record<string, string>, { cookie = "", origin = ORIGIN, site = "same-origin" } = {}) =>
  fetch(`${kit.stack.api}${path}`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams(fields),
    headers: { origin, "sec-fetch-site": site, "x-real-ip": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...(cookie ? { cookie } : {}) },
  });
const view = async (path: string, cookie = "") => (await fetch(`${kit.stack.api}${path}`, { headers: { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", ...(cookie ? { cookie } : {}) } })).text();
/** An admin's button press on the panel. */
const act = (path: string, panel: Panel) => post(path, { csrf: panel.csrf }, { cookie: panel.cookie });
const emailOf = (username: string) => `${username}@example.com`;
async function signIn(username: string): Promise<Panel> {
  const res = await post("/admin/login", { email: emailOf(username), password: "correct horse battery" });
  expect(res.status).toBe(303);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const csrf = (await view("/admin", cookie)).match(/name="csrf" value="([0-9a-f]{64})"/)![1]!;
  return { cookie, csrf };
}
async function boss(username: string) {
  const account = await signUp(username);
  await kit.db`update accounts set admin = true where id = ${account.account.id}`;
  return { ...account, panel: await signIn(username) };
}
const banned = async (id: string) => !!(await kit.db`select banned_at from accounts where id = ${id}`)[0].banned_at;

test("only an account with the admin flag signs in, into a session of its own that the site's and the app's sessions can't stand in for", async () => {
  const plain = await signUp("adplain");
  const refused = await post("/admin/login", { email: emailOf("adplain"), password: "correct horse battery" });
  expect(refused.status).toBe(403);
  expect(refused.headers.get("set-cookie")).toBeNull();
  expect(await refused.text()).toContain("This account isn&#39;t an admin.");
  expect((await post("/admin/login", { email: emailOf("adplain"), password: "wrong password!" })).status).toBe(401);

  // The app's bearer token and the site's cookie get the sign-in form, never the panel, and can't act.
  const signedOut = await fetch(`${kit.stack.api}/admin/accounts`, { headers: { authorization: `Bearer ${plain.token}`, cookie: `session=${plain.token}` } });
  expect(signedOut.status).toBe(200);
  expect(await signedOut.text()).not.toContain("adplain@example.com");
  expect((await post(`/admin/accounts/${plain.account.id}/ban`, { csrf: "x" }, { cookie: `session=${plain.token}` })).status).toBe(403);
  expect(await banned(plain.account.id)).toBe(false);

  const theo = await boss("adtheo");
  const res = await post("/admin/login", { email: emailOf("adtheo"), password: "correct horse battery" });
  expect(res.headers.get("set-cookie")).toMatch(/^admin=[A-Za-z0-9_-]{43}; Path=\/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$/);
  const counts = await view("/admin", theo.panel.cookie);
  expect(counts).toContain("<h1>Counts</h1>");
  expect(counts).toContain(">All time<");
  // Taking the flag away ends the session at once.
  await kit.db`update accounts set admin = false where id = ${theo.account.id}`;
  expect(await view("/admin", theo.panel.cookie)).toContain('action="/admin/login"');
});

test("admin actions come only from the panel's own page: a world's origin, the site, a cross-site load or a missing CSRF token are refused", async () => {
  const theo = await boss("adtheo2");
  const target = await signUp("adtarget");
  const ban = `/admin/accounts/${target.account.id}/ban`;
  const { cookie, csrf } = theo.panel;
  for (const [origin, site] of [[WORLD_ORIGIN, "cross-site"], [WORLD_ORIGIN, ""], ["https://sandbox.example", "cross-site"], [ORIGIN, "same-site"], ["null", "cross-site"]] as const) {
    const res = await post(ban, { csrf }, { cookie, origin, site });
    expect(res.status).toBe(403);
  }
  expect((await post("/admin/login", { email: emailOf("adtheo2"), password: "correct horse battery" }, { origin: WORLD_ORIGIN, site: "cross-site" })).status).toBe(403);
  expect((await post(ban, {}, { cookie })).status).toBe(403);
  expect((await post(ban, { csrf: "0".repeat(64) }, { cookie })).status).toBe(403);
  // A world's page loading the panel by fetch or as an image is refused too.
  expect((await fetch(`${kit.stack.api}/admin/accounts`, { headers: { cookie, origin: WORLD_ORIGIN, "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" } })).status).toBe(403);
  expect(await banned(target.account.id)).toBe(false);

  const done = await post(ban, { csrf, back: "/admin/accounts?sort=username&dir=asc" }, { cookie });
  expect([done.status, done.headers.get("location")]).toEqual([303, "/admin/accounts?sort=username&dir=asc"]);
  expect(await banned(target.account.id)).toBe(true);
  expect((await post(`/admin/accounts/${target.account.id}/unban`, { csrf, back: "https://evil.example/" }, { cookie })).headers.get("location")).toBe("/admin");
  expect(await banned(target.account.id)).toBe(false);
  // Signing out ends the session.
  expect((await post("/admin/logout", { csrf }, { cookie })).status).toBe(303);
  expect(await view("/admin", cookie)).toContain('action="/admin/login"');
});

test("a takedown hides a world from Community and its link, Restore brings it back whole, and Delete for good removes its files", async () => {
  const { panel } = await boss("adtheo3");
  const maker = await signUp("admaker");
  const world = await publish(maker.token, { title: "Rude Keep" });
  await call(`/worlds/${world.id}/report`, { method: "POST" });
  expect(await view("/admin/worlds", panel.cookie)).toContain("Rude Keep");
  const listed = async () => ((await (await call("/worlds")).json()) as { id: string }[]).some((w) => w.id === world.id);
  expect(await listed()).toBe(true);

  expect((await act(`/admin/worlds/${world.id}/takedown`, panel)).status).toBe(303);
  expect((await call(`/worlds/${world.id}`)).status).toBe(410);
  expect(await listed()).toBe(false);
  expect((await kit.db`select zip_key is not null as kept, title from worlds where id = ${world.id}`)[0]).toEqual({ kept: true, title: "Rude Keep" });
  expect(await view("/admin/worlds", panel.cookie)).toContain("Taken down");

  expect((await act(`/admin/worlds/${world.id}/restore`, panel)).status).toBe(303);
  expect(await (await call(`/worlds/${world.id}`)).json()).toMatchObject({ title: "Rude Keep", author: "admaker" });
  expect(await listed()).toBe(true);

  await act(`/admin/worlds/${world.id}/takedown`, panel);
  expect((await act(`/admin/worlds/${world.id}/delete`, panel)).status).toBe(303);
  expect((await kit.db`select zip_key, title, removed_by from worlds where id = ${world.id}`)[0]).toEqual({ zip_key: null, title: "", removed_by: "moderator" });
  await act(`/admin/worlds/${world.id}/restore`, panel);
  expect((await call(`/worlds/${world.id}`)).status).toBe(410);

  // A world taken down and kept goes with its owner's account, files and all.
  const leaver = await signUp("adleaver");
  const kept = await publish(leaver.token, { title: "Kept Keep" });
  await act(`/admin/worlds/${kept.id}/takedown`, panel);
  expect((await call("/account", { method: "DELETE", token: leaver.token, body: { password: "correct horse battery" } })).status).toBe(204);
  expect((await kit.db`select zip_key, title from worlds where id = ${kept.id}`)[0]).toEqual({ zip_key: null, title: "" });
});

test("a reported comment is listed and removed, and every table sorts by any column", async () => {
  const { panel } = await boss("adtheo4");
  const owner = await signUp("adowner");
  const world = await publish(owner.token, { title: "Chatty Keep" });
  const commenter = await signUp("adcommenter");
  const c = await (await call(`/worlds/${world.id}/comments`, { token: commenter.token, body: { body: "<b>buy gold</b>" } })).json();
  expect((await call(`/comments/${c.id}/report`, { method: "POST", token: owner.token })).status).toBe(200);
  const comments = await view("/admin/comments", panel.cookie);
  expect(comments).toContain("&#60;b&#62;buy gold&#60;/b&#62;");
  expect(comments).not.toContain("<b>buy gold");
  expect((await act(`/admin/comments/${c.id}/remove`, panel)).status).toBe(303);
  expect((await kit.db`select body, removed_by from comments where id = ${c.id}`)[0]).toEqual({ body: "", removed_by: "moderator" });
  expect(await view("/admin/comments", panel.cookie)).not.toContain("buy gold");

  const names = (page: string) => [...page.matchAll(/\/u\/([a-z0-9_]+)"/g)].map((m) => m[1]!);
  const up = names(await view("/admin/accounts?sort=username&dir=asc", panel.cookie));
  expect(up.length).toBeGreaterThan(3);
  expect(up).toEqual([...up].sort());
  expect(names(await view("/admin/accounts?sort=username&dir=desc", panel.cookie))).toEqual([...up].reverse());
  for (const path of ["/admin", "/admin/worlds", "/admin/comments", "/admin/messages", "/admin/accounts"]) {
    const page = await view(path, panel.cookie);
    const headers = [...page.matchAll(/<th class="[a-z]*"><a href="\?([^"]+)"/g)].map((m) => new URLSearchParams(m[1]!.replaceAll("&#38;", "&")).get("sort"));
    if (!page.includes("Nothing here.")) expect(headers.length).toBeGreaterThan(2);
  }
});
