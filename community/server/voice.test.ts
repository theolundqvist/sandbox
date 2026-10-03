// Free voice against real Postgres and a stand-in ElevenLabs: who may use it, and that no install and no day goes over its money, even all at once.
import { SQL } from "bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startStack, type CommunityStack } from "./stack";

const calls: string[] = [];
let failing = false;
const elevenLabs = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    calls.push(path);
    if (req.headers.get("xi-api-key") !== "test-key" || failing) return new Response("no", { status: 500 });
    if (path.startsWith("/v1/text-to-speech/")) return new Response(new Uint8Array([0xff, 0xfb, 1, 2]), { headers: { "content-type": "audio/mpeg" } });
    if (path === "/v1/speech-to-text") {
      const file = (await req.formData()).get("file") as File;
      return Response.json({ text: `heard ${file.size} bytes`, words: [{ text: "heard", end: 0.4 }, { text: "bytes", end: 3.2 }] });
    }
    return new Response("not found", { status: 404 });
  },
});

let stack: CommunityStack;
let sql: SQL;
beforeAll(async () => {
  stack = await startStack("https://sandbox.example", { ELEVENLABS_URL: elevenLabs.url.origin, ELEVENLABS_API_KEY: "test-key" });
  sql = new SQL(stack.env.DATABASE_URL);
}, 120_000);
afterAll(async () => {
  await sql?.close();
  await stack?.stop();
  elevenLabs.stop(true);
}, 30_000);

let ip = 0;
async function install() {
  const res = await fetch(`${stack.api}/installs`, { method: "POST", headers: { "x-real-ip": `10.1.0.${++ip}` } });
  expect(res.status).toBe(201);
  return (await res.json()).token as string;
}
const tts = (token: string, text: string) =>
  fetch(`${stack.api}/ai/tts`, { method: "POST", body: JSON.stringify({ text }), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
const stt = (token: string, audio: Uint8Array<ArrayBuffer>) => fetch(`${stack.api}/ai/stt`, { method: "POST", body: audio, headers: { authorization: `Bearer ${token}`, "content-type": "audio/webm" } });
const used = async (token: string) => (await (await fetch(`${stack.api}/ai/usage`, { headers: { authorization: `Bearer ${token}` } })).json()).used;
const line = "a".repeat(2000); // $0.08 at $0.04 per 1,000 characters

test("speech and transcripts are counted against the install at list price, and a failed call costs nothing", async () => {
  const token = await install();
  const spoken = await tts(token, "Welcome to the arena.");
  expect(spoken.status).toBe(200);
  expect(spoken.headers.get("content-type")).toBe("audio/mpeg");
  expect(new Uint8Array(await spoken.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xfb, 1, 2]));
  expect(await used(token)).toBeCloseTo(21 * 0.00004, 8);

  // Counted by how long the speech ran, 4 s here, not by the minute held while it was transcribed.
  expect(await (await stt(token, new Uint8Array(1000))).json()).toEqual({ text: "heard 1000 bytes" });
  expect(await used(token)).toBeCloseTo(21 * 0.00004 + Math.ceil((4 * 220_000) / 3600) / 1e6, 8);

  const before = await used(token);
  failing = true;
  expect((await tts(token, "Nobody hears this.")).status).toBe(502);
  expect((await stt(token, new Uint8Array(10))).status).toBe(502);
  failing = false;
  expect(await used(token)).toBe(before);
});

test("a burst of calls at once never takes an install past $1", async () => {
  const token = await install();
  const results = await Promise.all(Array.from({ length: 20 }, () => tts(token, line)));
  const statuses = results.map((r) => r.status).sort();
  // 12 lines of $0.08 fit in $1; the 13th would not.
  expect(statuses).toEqual([...Array(12).fill(200), ...Array(8).fill(402)]);
  expect((await results.find((r) => r.status === 402)!.json()).error).toBe("Free voice is used up on this computer.");
  expect(await used(token)).toBeCloseTo(0.96, 8);
  const [{ spent }] = await sql`select spent from installs where token_hash = encode(sha256(${token}::bytea), 'hex')`;
  expect(Number(spent)).toBe(960_000);
});

test("past $20 a day everyone is paused until the next UTC day, without charging the install", async () => {
  const token = await install();
  await sql`insert into voice_days (day, spent) values ((now() at time zone 'utc')::date, 19_950_000) on conflict (day) do update set spent = 19_950_000`;
  const paused = await tts(token, line);
  expect(paused.status).toBe(429);
  expect((await paused.json()).error).toBe("Free voice is paused for today.");
  expect(await used(token)).toBe(0);
  const providerCalls = calls.length;

  // The cap counted today only: tomorrow is a new day.
  await sql`update voice_days set day = day - 1`;
  expect((await tts(token, line)).status).toBe(200);
  expect(calls.length).toBe(providerCalls + 1);
  const days = await sql`select spent from voice_days order by day`;
  expect(days.map((d: { spent: string }) => Number(d.spent))).toEqual([19_950_000, 80_000]);
});

test("only a registered install's token gets free voice, and too much at once is refused before ElevenLabs hears of it", async () => {
  const token = await install();
  const providerCalls = calls.length;
  for (const forged of ["", "made-up", token.slice(0, -1) + (token.endsWith("a") ? "b" : "a")]) {
    expect((await tts(forged, "hello")).status).toBe(401);
    expect((await stt(forged, new Uint8Array(10))).status).toBe(401);
    expect((await fetch(`${stack.api}/ai/usage`, { headers: { authorization: `Bearer ${forged}` } })).status).toBe(401);
  }
  expect((await tts(token, line + "a")).status).toBe(413);
  expect((await stt(token, new Uint8Array(512 * 1024 + 1))).status).toBe(413);
  expect(calls.length).toBe(providerCalls);
  expect(await used(token)).toBe(0);

  // Postgres keeps only the token's hash.
  const rows = await sql`select * from installs`;
  expect(JSON.stringify(rows)).not.toContain(token);
});

test("an install may make 30 voice calls a minute, and a computer may sign up 5 installs an hour", async () => {
  const token = await install();
  const statuses = [];
  for (let i = 0; i < 31; i++) statuses.push((await tts(token, "hi")).status);
  expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
  expect(statuses[30]).toBe(429);

  const signups = [];
  for (let i = 0; i < 6; i++) signups.push((await fetch(`${stack.api}/installs`, { method: "POST", headers: { "x-real-ip": "10.2.0.1" } })).status);
  expect(signups).toEqual([201, 201, 201, 201, 201, 429]);
});
