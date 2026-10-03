// What agents used building a world, against real Postgres: summed by model and by whether a subscription paid, shown only to the world's builders.
import { expect, test } from "bun:test";
import { useStack, call, kit, publish, signUp } from "./testkit";

useStack();

test("a world's builders see its agent usage by model, everyone else is refused", async () => {
  const ana = await signUp("uana");
  const bo = await signUp("ubo");
  const cy = await signUp("ucy");
  const world = await publish(ana.token, { origin: "lava-keep-1a2b3c4d" });
  const other = await publish(cy.token);
  await kit.db`insert into installs (id, token_hash) values ('usage-install', 'usage-install-hash')`;
  const row = (world_key: string, day: string, model: string, subscription: boolean, input: number, output: number, cost: number) =>
    kit.db`insert into agent_usage (install, world_key, day, provider, model, subscription, input_tokens, output_tokens, cache_read, cache_write, cost_usd, requests)
      values ('usage-install', ${world_key}, ${day}, 'anthropic', ${model}, ${subscription}, ${input}, ${output}, 100, 10, ${cost}, 3)`;
  // Usage counts under the world's Community id and under the id its host's computer keeps for it, on any day; another world's never.
  await row(world.id, "2026-10-01", "claude-opus", false, 1000, 200, 1.5);
  await row("lava-keep-1a2b3c4d", "2026-10-02", "claude-opus", false, 3000, 800, 2.25);
  await row("lava-keep-1a2b3c4d", "2026-10-02", "claude-opus", true, 50, 5, 0.1);
  await row(other.id, "2026-10-02", "gpt", false, 9, 9, 9);

  const usage = async (token?: string) => call(`/worlds/${world.id}/usage`, { token });
  expect((await usage()).status).toBe(401);
  expect((await usage(bo.token)).status).toBe(403);
  expect((await (await call(`/worlds/${world.id}`, { token: bo.token })).json()).builder).toBe(false);

  const res = await usage(ana.token);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([
    { provider: "anthropic", model: "claude-opus", subscription: false, inputTokens: 4000, outputTokens: 1000, cacheRead: 200, cacheWrite: 20, costUsd: 3.75, requests: 6 },
    { provider: "anthropic", model: "claude-opus", subscription: true, inputTokens: 50, outputTokens: 5, cacheRead: 100, cacheWrite: 10, costUsd: 0.1, requests: 3 },
  ]);
  expect((await (await call(`/worlds/${world.id}`, { token: ana.token })).json()).builder).toBe(true);

  // A credited builder sees it once they accept.
  await kit.db`insert into credits (world, name, checks, account, state, accepted_at) values (${world.id}, 'bo', '{}', ${bo.account.id}, 'accepted', now())`;
  expect((await usage(bo.token)).status).toBe(200);
  expect((await (await call(`/worlds/${world.id}`, { token: bo.token })).json()).builder).toBe(true);
});
