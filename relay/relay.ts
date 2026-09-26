// Public front door for worlds hosted on home machines: a host keeps one outbound WebSocket here and players reach it at /r/<room>/.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.PORT ?? 9100);
const CLAIMS = process.env.RELAY_CLAIMS ?? "claims.json";
const ROOM = /^[a-z0-9-]{3,32}$/;
const MAX_BODY = 25 * 1024 * 1024;
const CODE = /^[2-9A-HJKMNP-Z]{6}$/;

type HostData = { kind: "host"; room: string; binary: boolean };
type PlayerData = { kind: "player"; room: string; id: number; path: string; headers: Record<string, string>; behind?: boolean; asked?: number };
type Data = HostData | PlayerData;
type Pending = { resolve(res: Response): void; stream?: ReadableStreamDefaultController<Uint8Array> };
/** A room outlives its host's connection by a few seconds, so players stay while the host reconnects. */
type Host = { ws: ServerWebSocket<Data> | null; binary: boolean; pending: Map<number, Pending>; players: Map<number, ServerWebSocket<Data>>; gone?: Timer };

/** Each room's owner, and while it shares, the join code players can type instead of its invite link. */
const claims: Record<string, { token: string; seen: number; code?: string; invite?: string }> = existsSync(CLAIMS) ? JSON.parse(readFileSync(CLAIMS, "utf8")) : {};
const saveClaims = () => writeFileSync(CLAIMS, JSON.stringify(claims));
const hosts = new Map<string, Host>();
let nextId = 1;
const lookups = new Map<string, { n: number; until: number }>();

function tooMany(ip: string) {
  const now = Date.now();
  const l = lookups.get(ip);
  if (!l || l.until < now) {
    if (lookups.size > 10_000) for (const [k, v] of lookups) v.until < now && lookups.delete(k);
    lookups.set(ip, { n: 1, until: now + 60_000 });
    return false;
  }
  return ++l.n > 10;
}

function join(code: string, req: Request, ip: string) {
  const headers = { "access-control-allow-origin": "*" };
  if (tooMany(ip)) return Response.json({ error: "Too many tries. Wait a minute." }, { status: 429, headers });
  const room = Object.keys(claims).find((r) => claims[r]!.code === code.replace(/[^a-z0-9]/gi, "").toUpperCase());
  if (!room) return Response.json({ error: "No world with that code" }, { status: 404, headers });
  const origin = `${req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.slice(0, -1)}://${req.headers.get("host")}`;
  const invite = claims[room]!.invite;
  return Response.json({ url: `${origin}/r/${room}/${invite ? `#invite=${invite}` : ""}` }, { headers });
}

const JOIN_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sandbox</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@125,700;125,800&display=swap">
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;flex-direction:column;justify-content:center;gap:28px;padding:16px max(16px,8vw);background:#101113;color:#f3f1ec;font:700 14px/1.4 Archivo,system-ui,sans-serif;font-stretch:125%;text-transform:uppercase;letter-spacing:.16em}
h1{margin:0;font:800 clamp(40px,7vw,72px)/1 Archivo,system-ui,sans-serif;font-stretch:125%;letter-spacing:.02em}
label{display:flex;align-items:center;gap:20px}label::before{content:"";width:12px;height:12px;flex:none;background:#ffb547}
input{all:unset;width:100%;font:800 clamp(40px,8vw,64px)/1.1 Archivo,system-ui,sans-serif;font-stretch:125%;letter-spacing:.2em;text-transform:uppercase;caret-color:#ffb547}input::placeholder{color:#3a3b3e}
p{margin:0;min-height:1.4em;color:#ffb547}</style>
<h1>Join world</h1><label><input id="code" placeholder="K7F-M2Q" autocomplete="off" spellcheck="false" autofocus></label><p id="error"></p>
<script>const input=document.getElementById("code"),error=document.getElementById("error");
input.oninput=()=>{const c=input.value.replace(/[^a-z0-9]/gi,"").toUpperCase().slice(0,6);input.value=c.length>3?c.slice(0,3)+"-"+c.slice(3):c;error.textContent="";if(c.length===6)go(c)};
async function go(c){const res=await fetch("/join/"+c);const body=await res.json();if(res.ok)location.assign(body.url);else error.textContent=body.error}</script></html>`;

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
    // Behind the TLS proxy every peer is loopback; the proxy's own header names the player.
    const ip = req.headers.get("x-real-ip") ?? server.requestIP(req)?.address ?? "";
    if (url.pathname.startsWith("/join/")) return join(decodeURIComponent(url.pathname.slice(6)), req, ip);
    if (url.pathname === "/" && req.method === "GET" && req.headers.get("upgrade") !== "websocket") return new Response(JOIN_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
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
      else if (msg.t === "code") {
        const claim = claims[d.room]!;
        if (msg.code !== null && !CODE.test(msg.code)) return;
        if (msg.code && Object.entries(claims).some(([r, c]) => r !== d.room && c.code === msg.code)) return void ws.send(JSON.stringify({ t: "code", taken: msg.code }));
        claim.code = msg.code ?? undefined;
        claim.invite = /^[a-z0-9]{1,64}$/.test(msg.invite ?? "") ? msg.invite : undefined;
        saveClaims();
      }
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
