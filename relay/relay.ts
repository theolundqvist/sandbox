// Public front door for worlds hosted on home machines: a host keeps one outbound WebSocket here and players reach it at /r/<room>/.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.PORT ?? 9100);
const CLAIMS = process.env.RELAY_CLAIMS ?? "claims.json";
const ROOM = /^[a-z0-9-]{3,32}$/;
const MAX_BODY = 25 * 1024 * 1024;

type HostData = { kind: "host"; room: string; binary: boolean };
type PlayerData = { kind: "player"; room: string; id: number; path: string; headers: Record<string, string>; behind?: boolean; asked?: number };
type Data = HostData | PlayerData;
type Pending = { resolve(res: Response): void; stream?: ReadableStreamDefaultController<Uint8Array> };
/** A room outlives its host's connection by a few seconds, so players stay while the host reconnects. */
type Host = { ws: ServerWebSocket<Data> | null; binary: boolean; pending: Map<number, Pending>; players: Map<number, ServerWebSocket<Data>>; gone?: Timer; lock?: { hash: string; invite: string } };

/** Each room's owner, so only its host can take it again. */
const claims: Record<string, { token: string; seen: number }> = existsSync(CLAIMS) ? JSON.parse(readFileSync(CLAIMS, "utf8")) : {};
const saveClaims = () => writeFileSync(CLAIMS, JSON.stringify(claims));
const hosts = new Map<string, Host>();
let nextId = 1;

/** Hosts that connect with v=2 get players' frames and HTTP bodies as binary frames: a kind byte, the player's or request's id, then the bytes as they are. */
const [TEXT, BINARY, CHUNK, REQUEST] = [1, 2, 3, 4];
function frame(kind: number, id: number, ...parts: Uint8Array[]) {
  const out = Buffer.alloc(5 + parts.reduce((n, p) => n + p.length, 0));
  out[0] = kind;
  out.writeUInt32BE(id, 1);
  let at = 5;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const control = (host: Host, msg: object) => host.ws?.send(JSON.stringify(msg));
function toHost(host: Host, id: number, data: string | Buffer) {
  if (!host.binary) return control(host, { t: "msg", id, data: String(data) });
  host.ws?.sendBinary(typeof data === "string" ? frame(TEXT, id, Buffer.from(data)) : frame(BINARY, id, data));
}

const RESYNC = JSON.stringify({ t: "resync" });
/** A player whose connection can't keep up skips ticks, then gets the whole world again once it has caught up, instead of falling further behind while everyone else plays on. */
function toPlayer(host: Host, id: number, data: string | Buffer) {
  const player = host.players.get(id);
  if (!player) return;
  if (typeof data !== "string") return void player.sendBinary(data, true);
  if (data.startsWith('{"t":"tick"')) {
    const d = player.data as PlayerData;
    if (player.getBufferedAmount() > 2 * data.length) {
      d.behind = true;
      d.asked = 0;
      return;
    }
    if (d.behind) {
      if (!d.asked) {
        d.asked = Date.now();
        return toHost(host, id, RESYNC);
      }
      // The world answers with a tick that resets everything; a spectator's never does, so the wait ends after 3 s.
      if (JSON.parse(data).reset !== true && Date.now() - d.asked < 3000) return;
      d.behind = false;
    }
  }
  player.sendText(data, true);
}

function failPending(host: Host) {
  for (const p of host.pending.values()) p.stream ? p.stream.error(new Error("host left")) : p.resolve(text("The world went offline.", 503));
  host.pending.clear();
}

/** Password tries per IP and room, a minute at a time. */
const tries = new Map<string, { n: number; since: number }>();
const open = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
/** A world listed with a password: its host gave the relay a hash of it and the world's invite, which the right password gets. The password itself is never kept or logged. */
async function unlock(req: Request, ip: string) {
  const body = await req.json().catch(() => ({}));
  const room = String(body.room ?? "");
  const host = ROOM.test(room) ? hosts.get(room) : undefined;
  if (!host?.ws || !host.lock) return Response.json({ error: "This world isn't asking for a password right now." }, { status: 404, headers: open });
  const key = `${ip} ${room}`;
  const t = tries.get(key);
  const now = Date.now();
  if (!t || now - t.since > 60_000) tries.set(key, { n: 1, since: now });
  else if (++t.n > 10) return Response.json({ error: "Too many tries. Wait a minute." }, { status: 429, headers: open });
  if (!(await Bun.password.verify(String(body.password ?? ""), host.lock.hash).catch(() => false))) return Response.json({ error: "That password isn't right." }, { status: 403, headers: open });
  return Response.json({ invite: host.lock.invite }, { headers: open });
}

const text = (body: string, status: number) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const forwarded = (headers: Headers) => Object.fromEntries([...headers].filter(([k]) => !["host", "cookie", "connection", "upgrade", "content-length"].includes(k) && !k.startsWith("sec-websocket") && !k.startsWith("x-forwarded")));

function route(url: URL, cookie: string | null): { room: string; path: string; fromPath: boolean } | null {
  const m = url.pathname.match(/^\/r\/([a-z0-9-]+)(\/.*)?$/);
  if (m) return { room: m[1]!, path: (m[2] || "/") + url.search, fromPath: true };
  const room = cookie?.match(/(?:^|;\s*)sandbox_room=([a-z0-9-]+)/)?.[1];
  return room ? { room, path: url.pathname + url.search, fromPath: false } : null;
}

Bun.serve<Data>({
  port: PORT,
  idleTimeout: 255,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/_unlock") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: open });
      if (req.method === "POST") return unlock(req, req.headers.get("x-real-ip") ?? server.requestIP(req)?.address ?? "");
    }
    if (url.pathname === "/_host") {
      const room = url.searchParams.get("room") ?? "";
      const token = url.searchParams.get("token") ?? "";
      if (!ROOM.test(room) || token.length < 16) return text("Pick a room of 3-32 lowercase letters, digits or dashes, and a token of 16+ characters.", 400);
      const claim = claims[room];
      if (claim && claim.token !== token) return text("That room belongs to another host.", 403);
      claims[room] = { token, seen: Date.now() };
      saveClaims();
      return server.upgrade(req, { data: { kind: "host", room, binary: url.searchParams.get("v") === "2" } }) ? undefined : text("upgrade failed", 400);
    }
    const target = route(url, req.headers.get("cookie"));
    if (!target) return text("Nothing here. Open the link your host shared.", 404);
    const host = hosts.get(target.room);
    if (!host?.ws) return text("This world is offline right now. Ask the host to open their world.", 503);

    if (req.headers.get("upgrade") === "websocket") {
      const data: PlayerData = { kind: "player", room: target.room, id: nextId++, path: target.path, headers: forwarded(req.headers) };
      return server.upgrade(req, { data }) ? undefined : text("upgrade failed", 400);
    }

    const body = req.method === "GET" || req.method === "HEAD" ? null : new Uint8Array(await req.arrayBuffer());
    if (body && body.length > MAX_BODY) return text("Too large.", 413);
    const id = nextId++;
    const res = await new Promise<Response>((resolve) => {
      host.pending.set(id, { resolve });
      const head = { method: req.method, path: target.path, headers: forwarded(req.headers) };
      if (!host.binary) control(host, { t: "req", id, ...head, body: body && b64(body) });
      else {
        const json = Buffer.from(JSON.stringify(head));
        const size = Buffer.alloc(4);
        size.writeUInt32BE(json.length);
        host.ws?.sendBinary(frame(REQUEST, id, size, json, body ?? new Uint8Array(0)));
      }
      // Longer than a Claude's query_world may wait before it answers (60 s).
      setTimeout(() => {
        if (host.pending.has(id) && !host.pending.get(id)!.stream && host.pending.delete(id)) resolve(text("The host didn't answer in time.", 504));
      }, 75_000);
    });
    if (target.fromPath) res.headers.append("set-cookie", `sandbox_room=${target.room}; Path=/; Max-Age=2592000; SameSite=Lax; Secure`);
    return res;
  },
  websocket: {
    perMessageDeflate: true,
    open(ws) {
      const d = ws.data;
      if (d.kind === "host") {
        const host = hosts.get(d.room);
        if (!host) return void hosts.set(d.room, { ws, binary: d.binary, pending: new Map(), players: new Map() });
        // Back within a few seconds, or connected again from somewhere else: the players stay and open again through this connection.
        clearTimeout(host.gone);
        const old = host.ws;
        failPending(host);
        Object.assign(host, { ws, binary: d.binary });
        old?.close(4000, "The host connected again from somewhere else");
        for (const [id, player] of host.players) {
          const p = player.data as PlayerData;
          control(host, { t: "open", id, path: p.path, headers: p.headers });
        }
        return;
      }
      const host = hosts.get(d.room);
      if (!host?.ws) return ws.close(1011, "The world went offline");
      host.players.set(d.id, ws);
      control(host, { t: "open", id: d.id, path: d.path, headers: d.headers });
    },
    message(ws, raw) {
      const d = ws.data;
      const host = hosts.get(d.room);
      if (d.kind === "player") {
        if (host) toHost(host, d.id, raw);
        return;
      }
      if (host?.ws !== ws) return;
      if (typeof raw !== "string") {
        const id = raw.readUInt32BE(1);
        const bytes = raw.subarray(5);
        if (raw[0] === CHUNK) host.pending.get(id)?.stream?.enqueue(new Uint8Array(bytes));
        else toPlayer(host, id, raw[0] === TEXT ? bytes.toString() : bytes);
        return;
      }
      const msg = JSON.parse(raw);
      if (msg.t === "res") {
        const p = host.pending.get(msg.id);
        if (!p) return;
        const stream = new ReadableStream<Uint8Array>({ start: (c) => void (p.stream = c), cancel: () => void host.pending.delete(msg.id) });
        p.resolve(new Response(msg.status === 204 || msg.status === 304 ? null : stream, { status: msg.status, headers: { ...msg.headers, "x-accel-buffering": "no" } }));
      } else if (msg.t === "chunk") host.pending.get(msg.id)?.stream?.enqueue(Buffer.from(msg.data, "base64"));
      else if (msg.t === "end") {
        host.pending.get(msg.id)?.stream?.close();
        host.pending.delete(msg.id);
      } else if (msg.t === "msg") toPlayer(host, msg.id, msg.data);
      else if (msg.t === "close") host.players.get(msg.id)?.close(msg.code >= 3000 || msg.code === 1000 ? msg.code : 1011, msg.reason);
      else if (msg.t === "ping") ws.send(JSON.stringify({ t: "pong" }));
      else if (msg.t === "lock") host.lock = typeof msg.hash === "string" && typeof msg.invite === "string" ? { hash: msg.hash, invite: msg.invite } : undefined;
    },
    close(ws) {
      const d = ws.data;
      const host = hosts.get(d.room);
      if (d.kind === "player") {
        if (host?.players.delete(d.id)) control(host, { t: "close", id: d.id });
        return;
      }
      if (host?.ws !== ws) return;
      host.ws = null;
      failPending(host);
      host.gone = setTimeout(() => {
        if (host.ws) return;
        hosts.delete(d.room);
        for (const player of host.players.values()) player.close(1011, "The world went offline");
      }, 10_000);
      claims[d.room]!.seen = Date.now();
      saveClaims();
    },
  },
});
console.log(`relay listening on :${PORT}`);
