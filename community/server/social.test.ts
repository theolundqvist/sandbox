// Builders, profiles and personal messages against real Postgres: credit only with the builder's key and consent, and messages only between their two parties.
import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { useStack, call, kit, publish, sha256, signUp } from "./testkit";

useStack();

/** What a builder's app holds for a world they played in: made from their player key, which never leaves their computer. */
const tokenOf = (playerKey: string, localWorld: string) => createHmac("sha256", playerKey).update(`sandbox-credit:${localWorld}`).digest("base64url");

test("a builder is credited only after showing the token from their player key while signed in, and can take the credit back", async () => {
  const owner = await signUp("crowner");
  const maja = await signUp("cmaja");
  const nosy = await signUp("cnosy");
  const world = await publish(owner.token, { title: "Built Together" });
  const majaToken = tokenOf("maja-player-key", "local-keep");
  const credits = { credits: [{ name: "maja", checks: [sha256(majaToken)] }, { name: "ludde", checks: [sha256(tokenOf("ludde-key", "local-keep"))] }] };
  expect((await call(`/worlds/${world.id}/credits`, { method: "PUT", body: credits, token: nosy.token })).status).toBe(403);
  expect((await call(`/worlds/${world.id}/credits`, { method: "PUT", body: { credits: [{ name: "maja", checks: ["nothex"] }] }, token: owner.token })).status).toBe(400);
  expect((await call(`/worlds/${world.id}/credits`, { method: "PUT", body: credits, token: owner.token })).status).toBe(200);
  const builders = async () => (await (await call(`/worlds/${world.id}`)).json()).builders;
  expect(await builders()).toEqual(["crowner"]);

  // Only the holder of Maja's key sees and takes Maja's credit.
  const waiting = async (token: string, tokens: string[]) => (await call("/credits/waiting", { body: { tokens }, token })).json();
  expect(await waiting(nosy.token, [tokenOf("guess", "local-keep")])).toEqual([]);
  expect(await waiting(maja.token, [majaToken, "junk"])).toEqual([{ world: { id: world.id, title: "Built Together", author: "crowner" }, name: "maja", token: majaToken }]);
  expect((await call("/credits/accept", { body: { token: majaToken } })).status).toBe(401);
  expect((await call("/credits/accept", { body: { token: majaToken }, token: maja.token })).status).toBe(200);
  expect(await builders()).toEqual(["crowner", "cmaja"]);
  expect((await call("/credits/accept", { body: { token: majaToken }, token: nosy.token })).status).toBe(404);
  expect(await waiting(maja.token, [majaToken])).toEqual([]);

  // Sending the list again replaces what waits and keeps what was accepted.
  expect((await call(`/worlds/${world.id}/credits`, { method: "PUT", body: { credits: [] }, token: owner.token })).status).toBe(200);
  expect(await builders()).toEqual(["crowner", "cmaja"]);
  expect((await kit.db`select count(*)::int as n from credits where world = ${world.id}`)[0].n).toBe(1);

  // On Maja's profile the world counts as hers too, until she takes the credit back.
  const profile = async (name: string) => (await call(`/users/${name}`)).json();
  expect((await profile("CMAJA")).worlds.map((w: any) => w.id)).toEqual([world.id]);
  expect((await call(`/worlds/${world.id}/credits`, { method: "DELETE", token: maja.token })).status).toBe(204);
  expect(await builders()).toEqual(["crowner"]);
  expect((await profile("cmaja")).worlds).toEqual([]);
}, 30_000);

test("a profile shows the username, join date and listed worlds with their players and votes, never the email, and not for a banned account", async () => {
  const ana = await signUp("prof_ana");
  const fan = await signUp("prof_fan");
  const shown = await publish(ana.token, { title: "Shown" });
  await publish(ana.token, { title: "Hidden", visibility: "link" });
  await call(`/worlds/${shown.id}/vote`, { method: "PUT", body: { up: true }, token: fan.token });
  await kit.db`update worlds set players = 7 where id = ${shown.id}`;
  const res = await call("/users/prof_ana");
  const text = await res.clone().text();
  expect(text).not.toContain("@example.com");
  expect(await res.json()).toMatchObject({ username: "prof_ana", players: 7, votes: 1, worlds: [{ id: shown.id }], me: false });
  expect(typeof (await (await call("/users/prof_ana")).json()).joined).toBe("number");
  expect((await call("/users/nobody_here")).status).toBe(404);
  await kit.db`update accounts set banned_at = now() where id = ${ana.account.id}`;
  expect((await call("/users/prof_ana")).status).toBe(404);
}, 30_000);

test("messages reach only their two parties, wait 3 s apart, stop at a block, count unread until opened, and go with a deleted account", async () => {
  const ana = await signUp("msg_ana");
  const ben = await signUp("msg_ben");
  const cy = await signUp("msg_cy");
  const send = (token: string | undefined, to: string, body: string) => call("/messages", { body: { to, body }, token });
  const settle = (who: string) => kit.db`delete from limits where who = ${who} and action = 'message'`;
  expect((await send(undefined, "msg_ben", "hi")).status).toBe(401);
  expect((await send(ana.token, "msg_ana", "hi")).status).toBe(400);
  expect((await send(ana.token, "nobody_here", "hi")).status).toBe(404);
  expect((await send(ana.token, "msg_ben", "x".repeat(2001))).status).toBe(400);
  const first = await send(ana.token, "msg_ben", "<i>hey</i> want to build?");
  expect(first.status).toBe(201);
  const sent = await first.json();
  expect((await send(ana.token, "msg_ben", "again")).status).toBe(429);

  const unread = async (token: string) => (await (await call("/account/unread", { token })).json()).unread;
  expect(await unread(ben.token)).toBe(1);
  expect(await (await call("/messages", { token: ben.token })).json()).toEqual([{ with: "msg_ana", unread: 1, last: { id: sent.id, body: "<i>hey</i> want to build?", at: sent.at, mine: false, read: false } }]);
  // Cy sees none of it, even asking for that conversation by name.
  expect(await (await call("/messages", { token: cy.token })).json()).toEqual([]);
  expect((await (await call("/messages/msg_ana", { token: cy.token })).json()).messages).toEqual([]);
  expect((await call(`/messages/${sent.id}/report`, { method: "POST", token: cy.token })).status).toBe(404);
  expect((await call(`/messages/${sent.id}/report`, { method: "POST", token: ana.token })).status).toBe(404);
  // Opening it reads it.
  expect((await (await call("/messages/msg_ana", { token: ben.token })).json()).messages.map((m: any) => m.body)).toEqual(["<i>hey</i> want to build?"]);
  expect(await unread(ben.token)).toBe(0);
  expect((await call(`/messages/${sent.id}/report`, { method: "POST", token: ben.token })).status).toBe(200);

  // Ben blocks Ana: nothing more from her gets through, until he unblocks her.
  expect((await call("/blocks/msg_ana", { method: "PUT", token: ben.token })).status).toBe(200);
  await settle(ana.account.id);
  expect((await send(ana.token, "msg_ben", "hello?")).status).toBe(403);
  expect(await (await call("/users/msg_ana", { token: ben.token })).json()).toMatchObject({ blocked: true });
  expect((await call("/blocks/msg_ana", { method: "DELETE", token: ben.token })).status).toBe(200);
  await settle(ana.account.id);
  expect((await send(ana.token, "msg_ben", "hello?")).status).toBe(201);

  // Ten new conversations a day; replies to old ones still go.
  const strangers = await Promise.all(Array.from({ length: 10 }, (_, i) => signUp(`msg_s${i}`)));
  for (const s of strangers.slice(0, 9)) {
    await settle(ana.account.id);
    expect((await send(ana.token, s.account.username, "hi")).status).toBe(201);
  }
  await settle(ana.account.id);
  expect((await send(ana.token, strangers[9]!.account.username, "hi")).status).toBe(429);
  await settle(ana.account.id);
  expect((await send(ana.token, "msg_ben", "still here")).status).toBe(201);

  expect((await call("/account", { method: "DELETE", body: { password: "correct horse battery" }, token: ana.token })).status).toBe(204);
  expect((await kit.db`select count(*)::int as n from messages where sender = ${ana.account.id} or recipient = ${ana.account.id}`)[0].n).toBe(0);
  expect(await (await call("/messages", { token: ben.token })).json()).toEqual([]);
}, 30_000);

test("friends: a request waits for a yes, asking back accepts it, either side ends it, and a block ends it and stops new requests", async () => {
  const ana = await signUp("fr_ana");
  const ben = await signUp("fr_ben");
  const add = (token: string, name: string) => call(`/friends/${name}`, { method: "PUT", token });
  const drop = (token: string, name: string) => call(`/friends/${name}`, { method: "DELETE", token });
  const list = async (token: string) => (await call("/friends", { token })).json();
  const state = async (token: string, name: string) => (await (await call(`/users/${name}`, { token })).json()).friend;

  expect((await add(ana.token, "fr_ana")).status).toBe(400);
  expect((await add(ana.token, "nobody_here")).status).toBe(404);
  expect(await (await add(ana.token, "FR_BEN")).json()).toEqual({ friend: "sent" });
  expect(await (await add(ana.token, "fr_ben")).json()).toEqual({ friend: "sent" });
  expect(await state(ben.token, "fr_ana")).toBe("received");
  expect(await list(ben.token)).toEqual({ friends: [], received: ["fr_ana"], sent: [] });
  expect(await list(ana.token)).toEqual({ friends: [], received: [], sent: ["fr_ben"] });

  // Declining is the same as taking a request back: nothing is left.
  expect((await drop(ben.token, "fr_ana")).status).toBe(200);
  expect(await state(ana.token, "fr_ben")).toBeNull();

  await add(ana.token, "fr_ben");
  expect(await (await add(ben.token, "fr_ana")).json()).toEqual({ friend: "friends" });
  expect(await state(ana.token, "fr_ben")).toBe("friends");
  expect(await list(ana.token)).toEqual({ friends: ["fr_ben"], received: [], sent: [] });
  expect(await (await drop(ana.token, "fr_ben")).json()).toEqual({ friend: null });
  expect((await list(ben.token)).friends).toEqual([]);

  await add(ana.token, "fr_ben");
  await add(ben.token, "fr_ana");
  expect((await call("/blocks/fr_ana", { method: "PUT", token: ben.token })).status).toBe(200);
  expect((await list(ana.token)).friends).toEqual([]);
  expect((await add(ana.token, "fr_ben")).status).toBe(403);
  expect((await add(ben.token, "fr_ana")).status).toBe(403);
  expect((await call("/friends")).status).toBe(401);
}, 30_000);

test("20 friend requests a day, counted only for new ones", async () => {
  const many = await signUp("fr_many");
  await kit.db`insert into limits (who, action, since, n) values (${many.account.id}, 'friend', now(), 20) on conflict (who, action) do update set n = 20, since = now()`;
  const other = await signUp("fr_other");
  expect((await call("/friends/fr_other", { method: "PUT", token: many.token })).status).toBe(429);
  // Saying yes to someone who asked first is never limited.
  await call("/friends/fr_many", { method: "PUT", token: other.token });
  expect(await (await call("/friends/fr_other", { method: "PUT", token: many.token })).json()).toEqual({ friend: "friends" });
}, 30_000);

test("comments and forks of a world that doesn't exist or was taken down are a 404", async () => {
  const ana = await signUp("gone_ana");
  const world = await publish(ana.token);
  expect((await call(`/worlds/${world.id}/comments`)).status).toBe(200);
  expect((await call(`/worlds/${world.id}/forks`)).status).toBe(200);
  await call(`/worlds/${world.id}`, { method: "DELETE", token: ana.token });
  for (const id of [world.id, "zzzzzzzzzzzz"]) {
    expect((await call(`/worlds/${id}/comments`)).status).toBe(404);
    expect((await call(`/worlds/${id}/forks`)).status).toBe(404);
  }
}, 30_000);
