// Accounts against real Postgres: sign-up, sign-in and out, the site's cookie, claiming worlds shared before accounts, deletion, bans and the limits on guessing.
import { expect, test } from "bun:test";
import { useStack, SITE, call, freshIp, jpeg, kit, publish, sha256, share, signUp, zip } from "./testkit";

useStack();

/** A world as one shared before accounts: an owner token, no account. */
async function legacyWorld(token: string) {
  const id = Math.random().toString(36).slice(2, 14).padEnd(12, "a");
  await kit.db`insert into worlds (id, title, description, author, visibility, owner_token_hash, engine_version, mods, zip_key, cover_key)
    values (${id}, 'Old Keep', '', 'old', 'public', ${sha256(token)}, 'x', 0, ${`worlds/${id}/z/world.zip`}, ${`worlds/${id}/z/cover.jpg`})`;
  return id;
}

test("an account keeps only a hash of its password and of each session, and signs in and out", async () => {
  const { token, account } = await signUp("ana_b");
  expect(account).toMatchObject({ username: "ana_b", email: "ana_b@example.com" });
  const [row] = await kit.db`select password_hash from accounts where id = ${account.id}`;
  expect(row.password_hash).toStartWith("$argon2id$");
  expect(JSON.stringify(await kit.db`select * from sessions`)).not.toContain(token);
  expect(await (await call("/account", { token })).json()).toMatchObject({ account: { username: "ana_b" } });

  const wrong = await call("/sessions", { body: { email: "ana_b@example.com", password: "not it at all" } });
  const nobody = await call("/sessions", { body: { email: "nobody@example.com", password: "correct horse battery" } });
  expect([wrong.status, nobody.status]).toEqual([401, 401]);
  expect(await wrong.json()).toEqual(await nobody.json());

  const signedIn = await (await call("/sessions", { body: { email: "ANA_B@example.com ", password: "correct horse battery" } })).json();
  expect(signedIn.account.id).toBe(account.id);
  expect((await call("/sessions", { method: "DELETE", token: signedIn.token })).status).toBe(204);
  expect((await call("/account", { token: signedIn.token })).status).toBe(401);
  expect((await call("/account", { token })).status).toBe(200);
});

test("sessions idle for 90 days stop working", async () => {
  const { token } = await signUp("idle");
  await kit.db`update sessions set last_seen = now() - interval '91 days' where token_hash = ${sha256(token)}`;
  expect((await call("/account", { token })).status).toBe(401);
});

test("usernames are unique whatever their case, 3 to 20 of a-z 0-9 _, never reserved, and change once in 30 days", async () => {
  const { token } = await signUp("ben");
  const refusal = async (username: string) => (await (await call("/accounts", { body: { email: `${Math.random()}@example.com`, password: "long enough", username } })).json()).error;
  expect(await refusal("BEN")).toBe("That username is taken.");
  expect(await refusal("admin")).toBe("That username is taken.");
  expect(await refusal("al")).toBe("A username is 3 to 20 letters, digits or _.");
  expect(await refusal("ben-z")).toBe("A username is 3 to 20 letters, digits or _.");
  expect(await (await call("/accounts", { body: { email: "BEN@example.com", password: "long enough", username: "other" } })).json()).toEqual({ error: "That email already has an account. Sign in instead." });
  expect(await (await call("/accounts", { body: { email: "x@example.com", password: "short", username: "other" } })).json()).toEqual({ error: "A password is 8 to 128 characters." });

  expect((await call("/account", { method: "PATCH", token, body: { username: "ana_b" } })).status).toBe(409);
  expect(await (await call("/account", { method: "PATCH", token, body: { username: "Benny" } })).json()).toMatchObject({ account: { username: "benny" } });
  expect((await call("/account", { method: "PATCH", token, body: { username: "benjamin" } })).status).toBe(429);
});

test("only an account publishes, and its username is the author", async () => {
  expect((await share("")).status).toBe(401);
  const { token } = await signUp("cara");
  const world = await publish(token);
  expect(await (await call(`/worlds/${world.id}`)).json()).toMatchObject({ author: "cara", mine: false });
  expect(await (await call(`/worlds/${world.id}`, { token })).json()).toMatchObject({ mine: true });
  const other = await signUp("dan");
  expect((await call(`/worlds/${world.id}`, { method: "DELETE", token: other.token })).status).toBe(403);
});

test("a world shared before accounts moves to the account that shows its owner token, once, and the token then does nothing", async () => {
  const ownerToken = "legacy-owner-token-1";
  const id = await legacyWorld(ownerToken);
  const ed = await signUp("eddie");
  const fay = await signUp("fay");
  expect((await call(`/worlds/${id}/claim`, { token: ed.token, body: { ownerToken: "wrong" } })).status).toBe(403);
  expect((await call(`/worlds/${id}/claim`, { body: { ownerToken } })).status).toBe(401);
  expect((await call(`/worlds/${id}/claim`, { token: ed.token, body: { ownerToken } })).status).toBe(200);
  expect((await call(`/worlds/${id}/claim`, { token: ed.token, body: { ownerToken } })).status).toBe(200);
  expect((await call(`/worlds/${id}/claim`, { token: fay.token, body: { ownerToken } })).status).toBe(409);
  expect(await (await call(`/worlds/${id}`)).json()).toMatchObject({ author: "eddie" });
  expect((await call(`/worlds/${id}`, { method: "DELETE", token: ownerToken })).status).toBe(403);
  expect((await call(`/worlds/${id}`, { method: "PUT", token: ownerToken, body: { title: "x", visibility: "public", files: { zip: 9 } } })).status).toBe(403);
  expect((await call(`/worlds/${id}`, { method: "DELETE", token: ed.token })).status).toBe(204);
});

test("an unclaimed world's owner token can still take it down, and nothing else", async () => {
  const ownerToken = "legacy-owner-token-2";
  const id = await legacyWorld(ownerToken);
  expect((await call(`/worlds/${id}`, { method: "PUT", token: ownerToken, body: { title: "x", visibility: "public", files: { zip: 9 } } })).status).toBe(403);
  expect((await call(`/worlds/${id}`, { method: "DELETE", token: ownerToken })).status).toBe(204);
  expect((await call(`/worlds/${id}`)).status).toBe(410);
});

test("the site's session is a cookie it can't read, and it changes nothing without the site's origin and header", async () => {
  const res = await call("/accounts", { body: { email: "gus@example.com", password: "long enough", username: "gus" }, headers: { origin: SITE } });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.token).toBeUndefined();
  const set = res.headers.get("set-cookie")!;
  expect(set).toContain("HttpOnly");
  expect(set).toContain("Secure");
  expect(set).toContain("SameSite=Lax");
  const cookie = set.split(";")[0]!;
  expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  expect((await call("/account", { headers: { cookie } })).status).toBe(200);
  const rename = (headers: Record<string, string>) => call("/account", { method: "PATCH", body: { username: "gus_two" }, headers: { cookie, ...headers } });
  expect((await rename({ origin: "https://evil.example", "x-sandbox": "1" })).status).toBe(401);
  expect((await rename({ origin: SITE })).status).toBe(401);
  expect((await rename({ origin: SITE, "x-sandbox": "1" })).status).toBe(200);
  const preflight = await fetch(`${kit.stack.api}/account`, { method: "OPTIONS" });
  expect(preflight.headers.get("access-control-allow-headers")).toContain("x-sandbox");
  expect(preflight.headers.get("access-control-allow-methods")).toContain("DELETE");
});

test("deleting an account asks for its password, ends its sessions and takes its worlds down, and only it", async () => {
  const hal = await signUp("hal");
  const kept = await signUp("ivy");
  const world = await publish(hal.token);
  const others = await publish(kept.token);
  expect((await call("/account", { method: "DELETE", token: hal.token, body: { password: "wrong password" } })).status).toBe(403);
  expect((await call("/account", { method: "DELETE", token: hal.token, body: { password: "correct horse battery" } })).status).toBe(204);
  expect((await call("/account", { token: hal.token })).status).toBe(401);
  expect(await kit.db`select 1 from accounts where id = ${hal.account.id}`).toHaveLength(0);
  expect(await kit.db`select 1 from sessions where account = ${hal.account.id}`).toHaveLength(0);
  expect((await call(`/worlds/${world.id}`)).status).toBe(410);
  const [tomb] = await kit.db`select title, account, zip_key, removed_by from worlds where id = ${world.id}`;
  expect(tomb).toEqual({ title: "", account: null, zip_key: null, removed_by: "account" });
  expect((await call(`/worlds/${others.id}`)).status).toBe(200);
  // Logged, so a restored backup can have it done again.
  const r2 = new Bun.S3Client({ endpoint: kit.stack.env.R2_ENDPOINT, bucket: kit.stack.env.R2_BUCKET, region: kit.stack.env.R2_REGION, accessKeyId: kit.stack.env.R2_ACCESS_KEY_ID, secretAccessKey: kit.stack.env.R2_SECRET_ACCESS_KEY });
  const log = ((await r2.list({ prefix: "deletions/" })).contents ?? []).map((o) => o.key).join("\n");
  expect(log).toContain(`-account-${hal.account.id}`);
  // Its username is free again.
  await signUp("hal");
});

test("a banned account can't publish and its worlds leave the list; a world a moderator took down can't come back from the same computer", async () => {
  const jo = await signUp("jojo");
  const world = await publish(jo.token, { origin: "local-world-1" });
  expect((await (await call("/worlds")).json()).map((w: any) => w.id)).toContain(world.id);
  await kit.db`update accounts set banned_at = now() where id = ${jo.account.id}`;
  expect((await (await call("/worlds")).json()).map((w: any) => w.id)).not.toContain(world.id);
  expect((await share(jo.token)).status).toBe(403);

  const kim = await signUp("kim");
  const removed = await publish(kim.token, { origin: "local-world-2" });
  await kit.db`update worlds set removed_at = now(), removed_by = 'moderator' where id = ${removed.id}`;
  expect((await share(kim.token, { origin: "local-world-2" })).status).toBe(403);
  expect((await call(`/worlds/${removed.id}`, { method: "PUT", token: kim.token, body: { title: "x", visibility: "public", files: { zip: 9 } } })).status).toBe(410);
});

test("sign-in tries: 5 a minute per IP, counted at once, and 5 a minute per email except from an IP that signed in to it before", async () => {
  const ip = freshIp();
  await signUp("lou", "correct horse battery", ip);
  const tries = await Promise.all(Array.from({ length: 9 }, () => call("/sessions", { ip: "10.250.0.1", body: { email: "lou@example.com", password: "guess guess" } })));
  expect(tries.map((r) => r.status).sort()).toEqual([...new Array(4).fill(401), ...new Array(5).fill(429)]);
  // Its sign-up counted for the email too. Other IPs, same email: the per-email limit is spent.
  expect((await call("/sessions", { ip: "10.250.0.2", body: { email: "lou@example.com", password: "correct horse battery" } })).status).toBe(429);
  // The owner's own IP still gets in; it signed up from there. Its per-IP limit still counts every try.
  expect((await call("/sessions", { ip, body: { email: "lou@example.com", password: "correct horse battery" } })).status).toBe(200);
  for (let i = 0; i < 3; i++) await call("/sessions", { ip, body: { email: "lou@example.com", password: "guess guess" } });
  expect((await call("/sessions", { ip, body: { email: "lou@example.com", password: "correct horse battery" } })).status).toBe(429);
  // Sign-ups count against the same per-IP limit.
  expect((await call("/accounts", { ip, body: { email: "new@example.com", password: "long enough", username: "newbie" } })).status).toBe(429);
});
