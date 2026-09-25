// Public front door for worlds hosted on home machines: a host keeps one outbound WebSocket here and players reach it at /r/<room>/.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.PORT ?? 9100);
const CLAIMS = process.env.RELAY_CLAIMS ?? "claims.json";
const ROOM = /^[a-z0-9-]{3,32}$/;
const MAX_BODY = 25 * 1024 * 1024;

type HostData = { kind: "host"; room: string };
type PlayerData = { kind: "player"; room: string; id: number; path: string; headers: Record<string, string> };
type Data = HostData | PlayerData;
type Pending = { resolve(res: Response): void; stream?: ReadableStreamDefaultController<Uint8Array> };
type Host = { ws: ServerWebSocket<Data>; pending: Map<number, Pending>; players: Map<number, ServerWebSocket<Data>> };

const claims: Record<string, { token: string; seen: number }> = existsSync(CLAIMS) ? JSON.parse(readFileSync(CLAIMS, "utf8")) : {};
const saveClaims = () => writeFileSync(CLAIMS, JSON.stringify(claims));
const hosts = new Map<string, Host>();
let nextId = 1;

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
    if (url.pathname === "/_host") {
      const room = url.searchParams.get("room") ?? "";
      const token = url.searchParams.get("token") ?? "";
      if (!ROOM.test(room) || token.length < 16) return text("Pick a room of 3-32 lowercase letters, digits or dashes, and a token of 16+ characters.", 400);
      const claim = claims[room];
      if (claim && claim.token !== token) return text("That room belongs to another host.", 403);
      claims[room] = { token, seen: Date.now() };
      saveClaims();
      return server.upgrade(req, { data: { kind: "host", room } }) ? undefined : text("upgrade failed", 400);
    }
    const target = route(url, req.headers.get("cookie"));
    if (!target) return text("Nothing here. Open the link your host shared.", 404);
    const host = hosts.get(target.room);
    if (!host) return text("This world is offline right now. Ask the host to open their game.", 503);

    if (req.headers.get("upgrade") === "websocket") {
      const data: PlayerData = { kind: "player", room: target.room, id: nextId++, path: target.path, headers: forwarded(req.headers) };
      return server.upgrade(req, { data }) ? undefined : text("upgrade failed", 400);
    }

    const body = req.method === "GET" || req.method === "HEAD" ? null : new Uint8Array(await req.arrayBuffer());
    if (body && body.length > MAX_BODY) return text("Too large.", 413);
    const id = nextId++;
    const res = await new Promise<Response>((resolve) => {
      host.pending.set(id, { resolve });
      host.ws.send(JSON.stringify({ t: "req", id, method: req.method, path: target.path, headers: forwarded(req.headers), body: body && b64(body) }));
      setTimeout(() => {
        if (host.pending.has(id) && !host.pending.get(id)!.stream && host.pending.delete(id)) resolve(text("The host didn't answer in time.", 504));
      }, 30_000);
    });
    if (target.fromPath) res.headers.append("set-cookie", `sandbox_room=${target.room}; Path=/; Max-Age=2592000; SameSite=Lax; Secure`);
    return res;
  },
  websocket: {
    perMessageDeflate: true,
    open(ws) {
      const d = ws.data;
      if (d.kind === "host") {
        const old = hosts.get(d.room);
        old?.ws.close(4000, "The host connected again from somewhere else");
        hosts.set(d.room, { ws, pending: new Map(), players: new Map() });
        return;
      }
      const host = hosts.get(d.room);
      if (!host) return ws.close(1011, "The world went offline");
      host.players.set(d.id, ws);
      host.ws.send(JSON.stringify({ t: "open", id: d.id, path: d.path, headers: d.headers }));
    },
    message(ws, raw) {
      const d = ws.data;
      const host = hosts.get(d.room);
      if (d.kind === "player") {
        host?.ws.send(JSON.stringify({ t: "msg", id: d.id, data: String(raw) }));
        return;
      }
      if (host?.ws !== ws) return;
      const msg = JSON.parse(String(raw));
      if (msg.t === "res") {
        const p = host.pending.get(msg.id);
        if (!p) return;
        const stream = new ReadableStream<Uint8Array>({ start: (c) => void (p.stream = c), cancel: () => void host.pending.delete(msg.id) });
        p.resolve(new Response(msg.status === 204 || msg.status === 304 ? null : stream, { status: msg.status, headers: { ...msg.headers, "x-accel-buffering": "no" } }));
      } else if (msg.t === "chunk") host.pending.get(msg.id)?.stream?.enqueue(Buffer.from(msg.data, "base64"));
      else if (msg.t === "end") {
        host.pending.get(msg.id)?.stream?.close();
        host.pending.delete(msg.id);
      } else if (msg.t === "msg") host.players.get(msg.id)?.send(msg.data, true);
      else if (msg.t === "close") host.players.get(msg.id)?.close(msg.code >= 3000 || msg.code === 1000 ? msg.code : 1011, msg.reason);
      else if (msg.t === "ping") ws.send(JSON.stringify({ t: "pong" }));
    },
    close(ws) {
      const d = ws.data;
      const host = hosts.get(d.room);
      if (d.kind === "player") {
        if (host?.players.delete(d.id)) host.ws.send(JSON.stringify({ t: "close", id: d.id }));
        return;
      }
      if (host?.ws !== ws) return;
      hosts.delete(d.room);
      for (const p of host.pending.values()) p.stream ? p.stream.error(new Error("host left")) : p.resolve(text("The world went offline.", 503));
      for (const player of host.players.values()) player.close(1011, "The world went offline");
      claims[d.room]!.seen = Date.now();
      saveClaims();
    },
  },
});
console.log(`relay listening on :${PORT}`);
