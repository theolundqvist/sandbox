// Worlds hosted right now against real Postgres: who sees which, what a password world keeps back, and that a room stays with the computer that listed it.
import { expect, test } from "bun:test";
import { useStack, call, kit, signUp } from "./testkit";

useStack();

const RELAY = "https://sandbox-relay.lundqvistliss.com";
const install = async () => (await (await call("/installs", { method: "POST" })).json()) as { id: string; token: string };
const host = (pc: string, session: string, body: object) => call("/live", { method: "PUT", body: { players: 2, ...body }, token: pc, headers: { "x-session": session } });
const seen = async (session?: string) => ((await (await call("/live", { headers: session ? { authorization: `Bearer ${session}` } : {} })).json()) as any[]).map((w) => [w.title, w.access, w.link]);

test("anyone sees Anyone and Password worlds, only friends see Friends worlds, and a password world's invite stays with the relay", async () => {
  const ana = await signUp("lana");
  const bo = await signUp("lbo");
  const cy = await signUp("lcy");
  const pc = await install();
  const link = (room: string) => `${RELAY}/r/${room}/#invite=abcdefgh12345678`;
  expect((await host(pc.token, ana.token, { title: "Open", access: "anyone", link: link("room-open"), players: 5 })).status).toBe(200);
  expect((await host(pc.token, ana.token, { title: "Close", access: "friends", link: link("room-friends") })).status).toBe(200);
  expect((await host(pc.token, ana.token, { title: "Locked", access: "password", link: link("room-lock") })).status).toBe(200);
  const everyone = [
    ["Open", "anyone", link("room-open")],
    ["Locked", "password", `${RELAY}/r/room-lock/`],
  ];
  expect(await seen()).toEqual(everyone);
  expect(await seen(cy.token)).toEqual(everyone);
  expect((await call("/friends/lana", { method: "PUT", token: bo.token })).status).toBe(200);
  expect(await seen(bo.token)).toEqual(everyone);
  expect((await call("/friends/lbo", { method: "PUT", token: ana.token })).status).toBe(200);
  expect(await seen(bo.token)).toEqual([everyone[0], ["Close", "friends", link("room-friends")], everyone[1]]);

  // Another computer can't take over a listed room; a stale listing drops out; going offline removes them all.
  const other = await install();
  expect((await host(other.token, cy.token, { title: "Mine", access: "anyone", link: link("room-open") })).status).toBe(409);
  expect((await host(pc.token, ana.token, { title: "Bad", access: "anyone", link: "https://evil.example/r/room-x/#invite=abcdefgh12345678" })).status).toBe(400);
  expect((await call("/live", { method: "PUT", body: { title: "No one", access: "anyone", link: link("room-anon") }, token: pc.token })).status).toBe(401);
  await kit.db`update live set seen_at = now() - interval '2 minutes' where room = 'room-open'`;
  expect(await seen()).toEqual([everyone[1]]);
  expect((await call("/live", { method: "DELETE", token: pc.token })).status).toBe(204);
  expect(await seen(bo.token)).toEqual([]);
}, 30_000);
