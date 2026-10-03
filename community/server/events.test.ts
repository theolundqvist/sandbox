// Usage stats against real Postgres: batches from installs and from the site's visitors, the rate limit, and that no token ever lands in the table.
import { SQL } from "bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startStack } from "./stack";

let stack: Awaited<ReturnType<typeof startStack>>;
let sql: SQL;
beforeAll(async () => {
  stack = await startStack();
  sql = new SQL(stack.env.DATABASE_URL);
}, 120_000);
afterAll(async () => {
  await sql?.close();
  await stack?.stop();
}, 30_000);

let ip = 0;
async function install() {
  const res = await fetch(`${stack.api}/installs`, { method: "POST", headers: { "x-real-ip": `10.2.0.${++ip}` } });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; token: string };
}
const post = (body: object, token?: string) =>
  fetch(`${stack.api}/events`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) } });
const session = crypto.randomUUID();
const clicks = (n: number, surface = "app") => Array.from({ length: n }, (_, i) => ({ session, surface, screen: "title", action: i ? `button-${i}` : "screen" }));

test("an install's batch lands as rows under the install's id, with the app's version and OS, and never its token", async () => {
  const { id, token } = await install();
  const res = await post({ events: clicks(50), app: { version: "0.1.0", os: "darwin" } }, token);
  expect(res.status).toBe(204);
  const rows = await sql`select * from events where install = ${id} order by id`;
  expect(rows.length).toBe(50);
  expect(rows[0]).toMatchObject({ install: id, account: null, session, surface: "app", screen: "title", action: "screen", props: { version: "0.1.0", os: "darwin" } });
  expect(rows.map((r: any) => r.action).slice(0, 3)).toEqual(["screen", "button-1", "button-2"]);
  // Nowhere in the table, in any column, as it was sent or hashed.
  const [{ found }] = await sql`select count(*)::int found from events e where e::text like ${`%${token}%`} or e::text like ${`%${new Bun.CryptoHasher("sha256").update(token).digest("hex")}%`}`;
  expect(found).toBe(0);
});

test("a batch is 50 events at most, each 4 KB at most, and a bad token is turned away", async () => {
  const { id, token } = await install();
  expect((await post({ events: clicks(51) }, token)).status).toBe(400);
  expect((await post({ events: [] }, token)).status).toBe(400);
  expect((await post({ events: [{ ...clicks(1)[0], props: { note: "x".repeat(4096) } }] }, token)).status).toBe(413);
  expect((await post({ events: [{ ...clicks(1)[0], action: "Typed Name!" }] }, token)).status).toBe(400);
  expect((await post({ events: clicks(1) }, "not-a-token")).status).toBe(401);
  const [{ n }] = await sql`select count(*)::int n from events where install = ${id}`;
  expect(n).toBe(0);
});

test("the site's visitors are an anonymous id, with no install", async () => {
  const anon = crypto.randomUUID();
  expect((await post({ anon, events: clicks(2, "site"), app: { os: "linux" } })).status).toBe(204);
  const rows = await sql`select install, surface, props from events where props->>'anon' = ${anon}`;
  expect(rows).toEqual([
    { install: null, surface: "site", props: { anon, os: "linux" } },
    { install: null, surface: "site", props: { anon, os: "linux" } },
  ]);
  expect((await post({ anon: "me", events: clicks(1, "site") })).status).toBe(401);
  expect((await post({ events: clicks(1, "site") })).status).toBe(401);
});

test("each install and each anonymous visitor sends 20 batches a minute at most, without holding up anyone else", async () => {
  const a = await install();
  const statuses = [];
  for (let i = 0; i < 21; i++) statuses.push((await post({ events: clicks(1) }, a.token)).status);
  expect(statuses).toEqual([...Array(20).fill(204), 429]);
  const [{ n }] = await sql`select count(*)::int n from events where install = ${a.id}`;
  expect(n).toBe(20);
  expect((await post({ events: clicks(1) }, (await install()).token)).status).toBe(204);

  const anon = crypto.randomUUID();
  const anonStatuses = [];
  for (let i = 0; i < 21; i++) anonStatuses.push((await post({ anon, events: clicks(1, "site") })).status);
  expect(anonStatuses.at(-1)).toBe(429);
  expect((await post({ anon: crypto.randomUUID(), events: clicks(1, "site") })).status).toBe(204);
});
