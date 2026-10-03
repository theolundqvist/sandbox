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
    select substr(md5(i::text), 1, 12), 'Tied', '', '', 'public', ${lister.account.id}, 'x', 0, 'k', 'k', now() - interval '1 day' from generate_series(1, 120) i`;
  const seen: string[] = [];
  for (let after = "", pages = 0; pages < 10; pages++) {
    const page = await (await call(`/worlds${after && `?after=${after}`}`)).json();
    seen.push(...page.map((w: any) => w.id));
    if (page.length < 50) break;
    after = page.at(-1).id;
  }
  expect(new Set(seen).size).toBe(seen.length);
  const tied = (await kit.db`select id from worlds where title = 'Tied' order by id desc`).map((r: { id: string }) => r.id);
  expect(seen.filter((id) => tied.includes(id))).toEqual(tied);
  expect(seen).toContain(first.id);
});

const install = async () => (await (await call("/installs", { method: "POST" })).json()).token as string;
const startPlay = async (installToken: string, world: string, session?: string) => {
  const res = await call("/plays", { body: { world }, token: installToken, headers: session ? { "x-session": session } : {} });
  return { status: res.status, ...(await res.json()) };
};
const beat = async (installToken: string, play: string, seconds: number) => {
  const res = await call(`/plays/${play}`, { method: "PUT", body: { seconds }, token: installToken });
  return { status: res.status, ...(await res.json()) };
};
/** As if the play started that long ago on the server. */
const age = (play: string, seconds: number) => kit.db`update plays set started_at = now() - ${`${seconds} seconds`}::interval where id = ${play}`;

test("a play counts only the time since it started on the server, never goes down, and only an install's newest play counts up", async () => {
  const owner = await signUp("play_owner");
  const world = await publish(owner.token);
  const other = await publish(owner.token, { title: "Other" });
  const pc = await install();
  expect((await call("/plays", { body: { world: world.id } })).status).toBe(401);
  expect((await startPlay(pc, "aaaaaaaaaaaa")).status).toBe(404);
  const { play } = await startPlay(pc, world.id, owner.token);
  expect((await kit.db`select account from plays where id = ${play}`)[0].account).toBe(owner.account.id);
  // Claiming an hour right away gets what has passed, a few seconds at most.
  expect((await beat(pc, play, 3600)).seconds).toBeLessThan(5);
  await age(play, 90);
  expect((await beat(pc, play, 3600)).seconds).toBeGreaterThanOrEqual(90);
  expect((await beat(pc, play, 3600)).seconds).toBeLessThan(100);
  expect((await beat(pc, play, 10)).seconds).toBeGreaterThanOrEqual(90);
  // Another install's key can't move this play, and a newer play stops the older one counting.
  expect((await beat(await install(), play, 3600)).status).toBe(409);
  const next = await startPlay(pc, other.id);
  await age(play, 600);
  expect((await beat(pc, play, 600)).status).toBe(409);
  expect((await beat(pc, next.play, 30)).status).toBe(200);
});

test("plays of a minute or more count, and each install counts once as a player; the list goes by players unless it asks for the newest", async () => {
  const owner = await signUp("count_owner");
  const quiet = await publish(owner.token, { title: "Quiet" });
  const loud = await publish(owner.token, { title: "Loud" });
  const fan = await install();
  for (let i = 0; i < 3; i++) {
    const { play } = await startPlay(fan, loud.id);
    await age(play, 61);
    await beat(fan, play, 61);
  }
  const brief = await install();
  const short = await startPlay(brief, loud.id);
  await age(short.play, 59);
  await beat(brief, short.play, 59);
  const second = await install();
  const p = await startPlay(second, loud.id);
  await age(p.play, 120);
  await beat(second, p.play, 120);
  expect(await (await call(`/worlds/${loud.id}`)).json()).toMatchObject({ plays: 4, players: 2 });
  expect(await (await call(`/worlds/${quiet.id}`)).json()).toMatchObject({ plays: 0, players: 0 });
  const top = await (await call("/worlds")).json();
  expect(top[0].id).toBe(loud.id);
  const newest = (await (await call("/worlds?sort=new")).json()).map((w: any) => w.id);
  expect(newest.slice(0, 2)).toEqual([loud.id, quiet.id]);
  // The most-played order pages on too: a page after Loud never repeats it.
  const after = await (await call(`/worlds?after=${loud.id}`)).json();
  expect(after.map((w: any) => w.id)).not.toContain(loud.id);
  expect(after.every((w: any) => w.players <= 2)).toBe(true);
});

test("comments are plain text from accounts that may still act, one every 20 seconds, removed by their author or the world's owner, and reported once each", async () => {
  const owner = await signUp("talk_owner");
  const ana = await signUp("talk_ana");
  const world = await publish(owner.token);
  const post = (token: string | undefined, body: unknown) => call(`/worlds/${world.id}/comments`, { body: { body }, token });
  expect((await post(undefined, "hi")).status).toBe(401);
  expect((await post(ana.token, " ")).status).toBe(400);
  expect((await post(ana.token, "x".repeat(1001))).status).toBe(400);
  const first = await post(ana.token, "<b>nice</b> keep");
  expect(first.status).toBe(201);
  const c = await first.json();
  expect(c).toMatchObject({ author: "talk_ana", body: "<b>nice</b> keep", mine: true, canRemove: true });
  expect((await post(ana.token, "again")).status).toBe(429);
  const fromOwner = await (await post(owner.token, "thanks")).json();
  const listed = await (await call(`/worlds/${world.id}/comments`, { token: owner.token })).json();
  expect(listed.map((x: any) => [x.author, x.body, x.canRemove])).toEqual([["talk_ana", "<b>nice</b> keep", true], ["talk_owner", "thanks", true]]);
  // Someone else can neither remove Ana's comment nor the owner's; reports count once per reporter.
  const bo = await signUp("talk_bo");
  expect((await call(`/comments/${c.id}`, { method: "DELETE", token: bo.token })).status).toBe(403);
  const ip = "10.9.9.9";
  for (let i = 0; i < 2; i++) expect((await call(`/comments/${c.id}/report`, { method: "POST", token: bo.token })).status).toBe(200);
  expect((await call(`/comments/${c.id}/report`, { method: "POST", ip })).status).toBe(200);
  expect((await kit.db`select count(*)::int as n from reports where kind = 'comment' and target = ${c.id}`)[0].n).toBe(2);
  // The world's owner removes Ana's; its words are gone from the database too.
  expect((await call(`/comments/${c.id}`, { method: "DELETE", token: owner.token })).status).toBe(204);
  expect((await kit.db`select body from comments where id = ${c.id}`)[0].body).toBe("");
  expect((await (await call(`/worlds/${world.id}/comments`)).json())[0]).toMatchObject({ removed: true, body: "", canRemove: false });
  expect((await call(`/comments/${fromOwner.id}`, { method: "DELETE", token: ana.token })).status).toBe(403);
  // A banned account can't comment and its comments leave the thread; a deleted account takes its comments with it.
  await kit.db`update accounts set banned_at = now() where id = ${bo.account.id}`;
  expect((await post(bo.token, "spam")).status).toBe(403);
  expect((await call("/account", { method: "DELETE", body: { password: "correct horse battery" }, token: ana.token })).status).toBe(204);
  expect((await kit.db`select count(*)::int as n from comments where account = ${ana.account.id}`)[0].n).toBe(0);
  expect((await kit.db`select count(*)::int as n from reports where reporter = ${bo.account.id}`)[0].n).toBe(1);
});
