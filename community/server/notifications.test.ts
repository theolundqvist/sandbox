// Notifications against real Postgres: each thing that concerns an account becomes one notice, a block silences its sender, and reading clears the count.
import { expect, test } from "bun:test";
import { useStack, call, kit, publish, sha256, signUp } from "./testkit";

useStack();

const notices = async (token: string) => ((await (await call("/notifications", { token })).json()) as any[]).map((n) => [n.kind, n.actor, n.world?.title ?? null, n.read]);
const count = async (token: string) => (await (await call("/account/unread", { token })).json()).notifications;

test("forks, comments, messages, credits and friendship reach whoever they concern, once while unread, and never from someone they blocked", async () => {
  const ana = await signUp("nana");
  const bo = await signUp("nbo");
  const cy = await signUp("ncy");
  const world = await publish(ana.token, { title: "Keep" });

  await publish(bo.token, { title: "Keep, colder", forkOf: world.id });
  await publish(bo.token, { title: "Hidden fork", forkOf: world.id, visibility: "link" });
  for (const body of ["Love it", "Again"]) {
    expect((await call(`/worlds/${world.id}/comments`, { body: { body }, token: bo.token })).status).toBe(201);
    await kit.db`delete from limits where who = ${bo.account.id} and action = 'comment'`;
  }
  expect((await call(`/worlds/${world.id}/comments`, { body: { body: "Mine" }, token: ana.token })).status).toBe(201);
  expect((await call("/messages", { body: { to: "nana", body: "Hi" }, token: bo.token })).status).toBe(201);
  expect((await call("/friends/nana", { method: "PUT", token: bo.token })).status).toBe(200);

  // Cy is blocked first, so nothing of Cy's reaches Ana.
  expect((await call("/blocks/ncy", { method: "PUT", token: ana.token })).status).toBe(200);
  expect((await call(`/worlds/${world.id}/comments`, { body: { body: "Spam" }, token: cy.token })).status).toBe(201);

  expect(await count(ana.token)).toBe(4);
  expect(await notices(ana.token)).toEqual([
    ["friend-request", "nbo", null, false],
    ["message", "nbo", null, false],
    ["comment", "nbo", "Keep", false],
    ["fork", "nbo", "Keep, colder", false],
  ]);
  expect((await call("/notifications/read", { method: "POST", token: ana.token })).status).toBe(204);
  expect(await count(ana.token)).toBe(0);
  expect((await notices(ana.token)).every((n) => n[3])).toBe(true);

  // Accepting tells the one who asked.
  expect((await call("/friends/nbo", { method: "PUT", token: ana.token })).status).toBe(200);
  expect((await notices(bo.token))[0]).toEqual(["friend-accepted", "nana", null, false]);

  // A credit waiting is told once, even when the app asks again after it was read.
  const token = "c".repeat(43);
  expect((await call(`/worlds/${world.id}/credits`, { method: "PUT", body: { credits: [{ name: "cy", checks: [sha256(token)] }] }, token: ana.token })).status).toBe(200);
  const waiting = () => call("/credits/waiting", { body: { tokens: [token] }, token: cy.token });
  expect((await (await waiting()).json()).length).toBe(1);
  expect(await notices(cy.token)).toEqual([["credit", "nana", "Keep", false]]);
  expect((await call("/notifications/read", { method: "POST", token: cy.token })).status).toBe(204);
  await waiting();
  expect(await count(cy.token)).toBe(0);
  expect((await call("/notifications")).status).toBe(401);
}, 30_000);
