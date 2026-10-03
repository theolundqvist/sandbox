// Finding worlds against real Postgres: votes, an account's own worlds, and the list a page at a time.
import { expect, test } from "bun:test";
import { useStack, call, kit, publish, signUp } from "./testkit";

useStack();

test("a vote is the state the voter wants: sending it twice counts once, and only accounts that may still act vote", async () => {
  const owner = await signUp("vote_owner");
  const fan = await signUp("vote_fan");
  const world = await publish(owner.token);
  const up = () => call(`/worlds/${world.id}/vote`, { method: "PUT", body: { up: true }, token: fan.token });
  expect((await call(`/worlds/${world.id}/vote`, { method: "PUT", body: { up: true } })).status).toBe(401);
  const [a, b] = await Promise.all([up(), up()]);
  expect([a.status, b.status]).toEqual([200, 200]);
  expect(await b.json()).toEqual({ votes: 1, voted: true });
  expect(await (await call(`/worlds/${world.id}`, { token: fan.token })).json()).toMatchObject({ votes: 1, voted: true });
  expect(await (await call(`/worlds/${world.id}`, { token: owner.token })).json()).toMatchObject({ votes: 1, voted: false });
  expect(await (await call(`/worlds/${world.id}`)).json()).toMatchObject({ votes: 1, voted: false });
  for (let i = 0; i < 2; i++) expect(await (await call(`/worlds/${world.id}/vote`, { method: "PUT", body: { up: false }, token: fan.token })).json()).toEqual({ votes: 0, voted: false });

  await kit.db`update accounts set banned_at = now() where id = ${fan.account.id}`;
  expect((await up()).status).toBe(403);
  // A removed world takes no votes, and deleting an account takes its votes with it.
  const other = await signUp("vote_other");
  expect((await call(`/worlds/${world.id}/vote`, { method: "PUT", body: { up: true }, token: other.token })).status).toBe(200);
  expect((await call("/account", { method: "DELETE", body: { password: "correct horse battery" }, token: other.token })).status).toBe(204);
  expect(await (await call(`/worlds/${world.id}`)).json()).toMatchObject({ votes: 0 });
  expect((await call(`/worlds/${world.id}`, { method: "DELETE", token: owner.token })).status).toBe(204);
  expect((await call(`/worlds/${world.id}/vote`, { method: "PUT", body: { up: true }, token: owner.token })).status).toBe(404);
});

test("my worlds are every live world of the account, link-only included, and nobody else's", async () => {
  const me = await signUp("mine_me");
  const them = await signUp("mine_them");
  const listed = await publish(me.token, { title: "Listed" });
  const hidden = await publish(me.token, { title: "Hidden", visibility: "link" });
  const gone = await publish(me.token, { title: "Gone" });
  await publish(them.token, { title: "Theirs" });
  expect((await call(`/worlds/${gone.id}`, { method: "DELETE", token: me.token })).status).toBe(204);
  expect((await call("/account/worlds")).status).toBe(401);
  const mine = await (await call("/account/worlds", { token: me.token })).json();
  expect(mine.map((w: any) => [w.id, w.mine])).toEqual([[hidden.id, true], [listed.id, true]]);
  // Link-only worlds never show in the list.
  const all = await (await call("/worlds")).json();
  expect(all.map((w: any) => w.id)).not.toContain(hidden.id);
});

test("the list comes 50 at a time, newest first, and each page goes on from the last world of the one before, even through ties", async () => {
  const lister = await signUp("pager");
  const first = await publish(lister.token);
  // 120 worlds published in the same instant: the order falls back to their ids.
  await kit.db`insert into worlds (id, title, description, author, visibility, account, engine_version, mods, zip_key, cover_key, created_at)
    select substr(md5(i::text), 1, 12), 'Tied', '', '', 'public', ${lister.account.id}, 'x', 0, 'k', 'k', now() + interval '1 hour' from generate_series(1, 120) i`;
  const seen: string[] = [];
  for (let after = "", pages = 0; pages < 10; pages++) {
    const page = await (await call(`/worlds${after && `?after=${after}`}`)).json();
    seen.push(...page.map((w: any) => w.id));
    if (page.length < 50) break;
    after = page.at(-1).id;
  }
  expect(new Set(seen).size).toBe(seen.length);
  const tied = (await kit.db`select id from worlds where title = 'Tied' order by id desc`).map((r: { id: string }) => r.id);
  expect(seen.slice(0, 120)).toEqual(tied);
  expect(seen).toContain(first.id);
});
