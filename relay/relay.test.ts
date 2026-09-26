// A throwaway relay with stand-in hosts: what players send and get through it, whatever the host's version, however slow the player.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const dir = mkdtempSync(join(tmpdir(), "sandbox-relay-"));
const PORT = 21000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let relay: Subprocess;

beforeAll(async () => {
  relay = Bun.spawn(["bun", join(import.meta.dir, "relay.ts")], { env: { ...process.env, PORT: String(PORT), RELAY_CLAIMS: join(dir, "claims.json") }, stdout: "ignore" });
  for (let i = 0; i < 100 && !(await fetch(BASE).then(() => true, () => false)); i++) await Bun.sleep(100);
});

afterAll(() => {
  relay.kill();
  rmSync(dir, { recursive: true, force: true });
});

async function until<T>(what: string, check: () => T | undefined, ms = 10_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) {
    const got = check();
    if (got) return got;
  }
  throw new Error(`never: ${what}`);
}

const [TEXT, BINARY, CHUNK, REQUEST] = [1, 2, 3, 4];
const frame = (kind: number, id: number, bytes: Uint8Array) => {
  const out = Buffer.alloc(5 + bytes.length);
  out[0] = kind;
  out.writeUInt32BE(id, 1);
  out.set(bytes, 5);
  return out;
};

/** A host as the launcher is one: v2 speaks binary frames, v1 only JSON. */
async function host(room: string, v2: boolean) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/_host?room=${room}&token=${room}-token-0123456789${v2 ? "&v=2" : ""}`);
  ws.binaryType = "arraybuffer";
  const json: any[] = [];
  const frames: { kind: number; id: number; bytes: Buffer }[] = [];
  ws.onmessage = ({ data }) => {
    if (typeof data === "string") return void json.push(JSON.parse(data));
    const b = Buffer.from(data as ArrayBuffer);
    frames.push({ kind: b[0]!, id: b.readUInt32BE(1), bytes: b.subarray(5) });
  };
  await new Promise((resolve) => (ws.onopen = resolve));
  return { ws, json, frames, opened: () => until("a player", () => json.findLast((m) => m.t === "open")?.id as number | undefined) };
}

async function player(room: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/r/${room}/ws`);
  ws.binaryType = "arraybuffer";
  const got: (string | ArrayBuffer)[] = [];
  ws.onmessage = ({ data }) => got.push(data);
  await new Promise((resolve) => (ws.onopen = resolve));
  return { ws, got };
}

test("a v2 host gets players' frames and request bodies as bytes, and a v1 host still gets them in JSON", async () => {
  const bytes = new Uint8Array(300_000).map((_, i) => i % 256);

  const v2 = await host("bin-room", true);
  const p = await player("bin-room");
  const id = await v2.opened();
  p.ws.send("hello");
  expect((await until("hello", () => v2.frames.find((f) => f.kind === TEXT && f.id === id))).bytes.toString()).toBe("hello");
  v2.ws.send(frame(TEXT, id, Buffer.from('{"t":"hi"}')));
  v2.ws.send(frame(BINARY, id, bytes.subarray(0, 10)));
  await until("both", () => p.got.length === 2 || undefined);
  expect(p.got[0]).toBe('{"t":"hi"}');
  expect(new Uint8Array(p.got[1] as ArrayBuffer)).toEqual(bytes.subarray(0, 10));

  const upload = fetch(`${BASE}/r/bin-room/up`, { method: "POST", body: bytes });
  const req = await until("the request", () => v2.frames.find((f) => f.kind === REQUEST));
  const size = req.bytes.readUInt32BE(0);
  expect(JSON.parse(req.bytes.subarray(4, 4 + size).toString())).toMatchObject({ method: "POST", path: "/up" });
  expect(new Uint8Array(req.bytes.subarray(4 + size))).toEqual(bytes);
  v2.ws.send(JSON.stringify({ t: "res", id: req.id, status: 200, headers: { "content-type": "application/octet-stream" } }));
  v2.ws.send(frame(CHUNK, req.id, bytes.subarray(0, 100_000)));
  v2.ws.send(frame(CHUNK, req.id, bytes.subarray(100_000)));
  v2.ws.send(JSON.stringify({ t: "end", id: req.id }));
  expect(new Uint8Array(await (await upload).arrayBuffer())).toEqual(bytes);

  const v1 = await host("json-room", false);
  const q = await player("json-room");
  const qid = await v1.opened();
  q.ws.send("hello");
  expect(await until("hello", () => v1.json.find((m) => m.t === "msg"))).toEqual({ t: "msg", id: qid, data: "hello" });
  v1.ws.send(JSON.stringify({ t: "msg", id: qid, data: '{"t":"hi"}' }));
  expect(await until("hi", () => q.got[0])).toBe('{"t":"hi"}');
  const get = fetch(`${BASE}/r/json-room/up`, { method: "POST", body: bytes.subarray(0, 1000) });
  const r = await until("the request", () => v1.json.find((m) => m.t === "req"));
  expect(Buffer.from(r.body, "base64")).toEqual(Buffer.from(bytes.subarray(0, 1000)));
  v1.ws.send(JSON.stringify({ t: "res", id: r.id, status: 200, headers: {} }));
  v1.ws.send(JSON.stringify({ t: "chunk", id: r.id, data: Buffer.from("done").toString("base64") }));
  v1.ws.send(JSON.stringify({ t: "end", id: r.id }));
  expect(await (await get).text()).toBe("done");
  for (const ws of [v2.ws, v1.ws, p.ws, q.ws]) ws.close();
});

test("a player whose connection can't keep up skips ticks and then gets the whole world again, while the others get every tick", async () => {
  const h = await host("lag-room", true);
  const fast = await player("lag-room");
  const fastId = await h.opened();

  // The slow player's game reads nothing until told to, and asks for no compression, so its bytes can be searched.
  let slowBytes = 0;
  const slowChunks: Buffer[] = [];
  const slow = net.connect(PORT, "127.0.0.1");
  slow.on("data", (b: Buffer) => ((slowBytes += b.length), slowChunks.push(b)));
  slow.write("GET /r/lag-room/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
  const slowId = await until("the slow player", () => h.json.findLast((m) => m.t === "open" && m.id !== fastId)?.id as number | undefined);
  slow.pause();

  const filler = Buffer.from(crypto.getRandomValues(new Uint8Array(150_000))).toString("base64");
  const tick = (n: number | string, reset = false) => Buffer.from(JSON.stringify({ t: "tick", set: { 1: { filler } }, unset: {}, removed: [], ...(reset ? { reset } : {}), n }));
  let sentToSlow = 0;
  const ticks = 150;
  for (let n = 0; n < ticks; n++) {
    const t = tick(n);
    h.ws.send(frame(TEXT, fastId, t));
    h.ws.send(frame(TEXT, slowId, t));
    sentToSlow += t.length;
    await Bun.sleep(20);
  }
  await until("every tick to the fast player", () => fast.got.length === ticks || undefined);

  slow.resume();
  const resync = () => h.frames.find((f) => f.id === slowId && f.kind === TEXT && f.bytes.toString() === '{"t":"resync"}');
  for (let n = 0; !resync() && n < 200; n++) {
    h.ws.send(frame(TEXT, slowId, tick(`catching up ${n}`)));
    await Bun.sleep(50);
  }
  expect(resync()).toBeTruthy();
  h.ws.send(frame(TEXT, slowId, tick("everything", true)));
  h.ws.send(frame(TEXT, slowId, tick("after")));
  await until("the world again", () => Buffer.concat(slowChunks).includes('"n":"after"') || undefined);
  const seen = Buffer.concat(slowChunks);
  expect(seen.indexOf('"n":"everything"')).toBeLessThan(seen.indexOf('"n":"after"'));
  expect(slowBytes).toBeLessThan(sentToSlow / 2);
  expect(fast.got.length).toBe(ticks);
  slow.destroy();
  fast.ws.close();
  h.ws.close();
}, 60_000);

test("players stay while their host reconnects, and play on through the new connection", async () => {
  const first = await host("back-room", true);
  const p = await player("back-room");
  let closed = false;
  p.ws.onclose = () => (closed = true);
  const id = await first.opened();
  first.ws.close();
  await Bun.sleep(1000);
  expect((await fetch(`${BASE}/r/back-room/`)).status).toBe(503);

  const again = await host("back-room", true);
  expect(await again.opened()).toBe(id);
  again.ws.send(frame(TEXT, id, Buffer.from('{"t":"welcome"}')));
  expect(await until("the welcome", () => p.got[0])).toBe('{"t":"welcome"}');
  p.ws.send("still here");
  expect((await until("its message", () => again.frames.find((f) => f.id === id))).bytes.toString()).toBe("still here");
  expect(closed).toBe(false);
  p.ws.close();
  again.ws.close();
});
