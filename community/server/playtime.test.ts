// Playtime in every game and agent usage against real Postgres: what one install can claim, and what an account's deletion leaves.
import { expect, test } from "bun:test";
import { useStack, call, kit, signUp } from "./testkit";

useStack();

const install = async () => (await (await call("/installs", { method: "POST" })).json()) as { id: string; token: string };
const beat = async (token: string, world: string, seconds: number, session?: string) => {
  const res = await call("/playtime", { body: { world, seconds }, token, headers: session ? { "x-session": session } : {} });
  return { status: res.status, ...(await res.json()) };
};
/** As if this install's last heartbeat was that long ago, which also lets its per-minute limit run out. */
async function idle(id: string, seconds: number) {
  await kit.db`update installs set playtime_at = now() - ${`${seconds} seconds`}::interval where id = ${id}`;
  await kit.db`delete from limits where who = ${id}`;
}
const today = (id: string) => kit.db`select world_key, seconds, account from playtime where install = ${id} order by world_key`;

test("playtime adds up per world and day, never more than the time since the install's last heartbeat, so two worlds at once or a replay add nothing", async () => {
  const pc = await install();
  const local = crypto.randomUUID();
  expect((await call("/playtime", { body: { world: local, seconds: 60 } })).status).toBe(401);
  expect((await beat(pc.token, "Lava Keep", 60)).status).toBe(400);
  expect((await beat(pc.token, local, -5)).status).toBe(400);
  await idle(pc.id, 0);
  await kit.db`update installs set playtime_at = null where id = ${pc.id}`;
  // A first heartbeat counts at most a minute; one straight after counts what passed since.
  expect((await beat(pc.token, local, 600)).credited).toBe(60);
  expect((await beat(pc.token, local, 60)).credited).toBeLessThan(2);
  await idle(pc.id, 90);
  expect((await beat(pc.token, local, 60)).credited).toBe(60);
  await idle(pc.id, 90);
  expect((await beat(pc.token, "abcdefabcdef", 600)).credited).toBeGreaterThanOrEqual(90);
  await idle(pc.id, 3600);
  expect((await beat(pc.token, "abcdefabcdef", 3600)).credited).toBe(120);
  // The same minute claimed from two worlds at once is credited once.
  await idle(pc.id, 60);
  const both = await Promise.all([beat(pc.token, local, 60), beat(pc.token, "abcdefabcdef", 60)]);
  expect(both[0].credited + both[1].credited).toBeLessThanOrEqual(62);
  await kit.db`delete from limits where who = ${pc.id}`;
  for (let i = 0; i < 5; i++) await beat(pc.token, local, 0);
  expect((await beat(pc.token, local, 0)).status).toBe(429);
  const rows = await today(pc.id);
  expect(rows.map((r: any) => r.world_key).sort()).toEqual(["abcdefabcdef", local].sort());
});

test("playtime and usage keep counting after the account behind them is deleted, without it", async () => {
  const pc = await install();
  const ana = await signUp("time_ana");
  await beat(pc.token, "abcdefabcdef", 60, ana.token);
  const usage = { world: "abcdefabcdef", provider: "anthropic", model: "claude-opus-5-5", subscription: true, inputTokens: 1200, outputTokens: 300, cacheRead: 5000, cacheWrite: 100, costUsd: 0.25, requests: 3 };
  for (let i = 0; i < 2; i++) expect((await call("/agent-usage", { body: usage, token: pc.token, headers: { "x-session": ana.token } })).status).toBe(204);
  expect((await call("/agent-usage", { body: { ...usage, subscription: false }, token: pc.token })).status).toBe(204);
  const [summed] = await kit.db`select account, input_tokens::int, output_tokens::int, cache_read::int, cache_write::int, cost_usd::float as cost, requests from agent_usage where install = ${pc.id} and subscription`;
  expect(summed).toEqual({ account: ana.account.id, input_tokens: 2400, output_tokens: 600, cache_read: 10000, cache_write: 200, cost: 0.5, requests: 6 });
  expect((await kit.db`select count(*)::int as n from agent_usage where install = ${pc.id}`)[0].n).toBe(2);
  expect((await call("/agent-usage", { body: usage })).status).toBe(401);
  expect((await call("/agent-usage", { body: { ...usage, inputTokens: -1 }, token: pc.token })).status).toBe(400);
  expect((await call("/agent-usage", { body: { ...usage, model: "" }, token: pc.token })).status).toBe(400);
  expect((await call("/agent-usage", { body: { ...usage, world: "My Secret World" }, token: pc.token })).status).toBe(400);

  expect((await call("/account", { method: "DELETE", body: { password: "correct horse battery" }, token: ana.token })).status).toBe(204);
  expect((await today(pc.id))[0]).toMatchObject({ seconds: 60, account: null });
  expect((await kit.db`select count(*)::int as n from agent_usage where account is not null and install = ${pc.id}`)[0].n).toBe(0);
});
