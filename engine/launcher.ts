import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket, Subprocess } from "bun";
import { frontFile } from "./front";
import { latencies, openRecord, route, type Recorder } from "./record";
import type { Config } from "./server";

const ENGINE = import.meta.dir;
const DATA = process.env.SANDBOX_DATA ?? join(ENGINE, "../data");
const WORLDS = join(DATA, "worlds");
const PORT = Number(process.env.PORT ?? 7777);
const STATE = join(DATA, "launcher.json");

const token = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
mkdirSync(WORLDS, { recursive: true });
const state: { hostKey: string; hosting: string | null; sharing?: boolean; room?: string; relayToken?: string } = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { hostKey: token(), hosting: null };
const saveState = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
saveState();

type Pipe = { target: string; upstream?: WebSocket; queue: string[] };
let running: { id: string; proc: Subprocess; port: number; record: Recorder; recorded: Promise<void> } | null = null;
const stopping = new WeakSet<Subprocess>();
/** How long requests take through this launcher, and through the relay end to end; the running world's record keeps it. */
const proxy = latencies();
const sampleProxy = (record: Recorder) => {
  const sample = proxy.take();
  if (Object.keys(sample).length) record.add("proxy", null, sample);
};
setInterval(() => running && sampleProxy(running.record), 10_000);
let tunnel: { ws: WebSocket; url: string | null } | null = null;
let tunnelError: string | null = null;
const players = new Set<ServerWebSocket<Pipe>>();

const readJson = (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
const config = (id: string): Config => readJson(join(WORLDS, id, "config.json"));

function worlds() {
  return readdirSync(WORLDS)
    .filter((id) => existsSync(join(WORLDS, id, "config.json")))
    .map((id) => {
      const dir = join(WORLDS, id);
      const { name, rules, start } = config(id);
      const saved = [join(dir, "world.sqlite"), join(dir, "config.json")].find(existsSync)!;
      return {
        id,
        name,
        rules,
        start,
        mods: Object.keys(readJson(join(dir, "mods.json"))).length,
        players: Object.keys(readJson(join(dir, "keys.json"))).length,
        played: statSync(saved).mtimeMs,
      };
    })
    .sort((a, b) => b.played - a.played);
}

async function stop() {
  const current = running;
  if (!current) return;
  running = null;
  for (const ws of players) ws.close(4001, "The host switched worlds");
  stopping.add(current.proc);
  current.proc.kill("SIGTERM");
  await current.recorded;
}

async function host(id: string) {
  if (running?.id === id) return;
  if (!existsSync(join(WORLDS, id, "config.json"))) throw new Error("That world doesn't exist.");
  await stop();
  let reportPort!: (port: number) => void;
  const started = Date.now();
  const record = openRecord(join(WORLDS, id, "record.sqlite"));
  const proc = Bun.spawn([process.execPath, join(ENGINE, "server.ts")], {
    env: { ...process.env, SANDBOX_DATA: join(WORLDS, id), PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
    ipc: (msg) => reportPort(msg.port),
  });
  const lastLines: string[] = [];
  const forward = async (from: ReadableStream<Uint8Array>, to: NodeJS.WriteStream) => {
    const decoder = new TextDecoder();
    for await (const chunk of from) {
      to.write(chunk);
      lastLines.push(...decoder.decode(chunk, { stream: true }).split("\n").filter(Boolean));
      lastLines.splice(0, lastLines.length - 40);
    }
  };
  const output = [forward(proc.stdout, process.stdout), forward(proc.stderr, process.stderr)];
  const recorded = proc.exited.then(async () => {
    const stopped = stopping.has(proc);
    await Promise.allSettled(output);
    const how = proc.signalCode ?? `code ${proc.exitCode}`;
    console.log(`[launcher] world ${id} exited with ${how} after ${Math.round((Date.now() - started) / 1000)} s${stopped ? "" : " without being stopped"}`);
    sampleProxy(record);
    const lastSample = record.rows({ kind: "server", since: started, limit: 1 })[0];
    record.add("exit", null, { code: proc.exitCode, signal: proc.signalCode, stopped, seconds: Math.round((Date.now() - started) / 1000), lastSample, lastLines });
    record.close();
  });
  const port = await new Promise<number>((resolve, reject) => {
    reportPort = resolve;
    proc.exited.then(() => reject(new Error("The world crashed while starting; the terminal shows why.")));
  });
  running = { id, proc, port, record, recorded };
  state.hosting = id;
  saveState();
  await publish();
  proc.exited.then(() => {
    if (running?.proc !== proc) return;
    running = null;
    for (const ws of players) ws.close(4001, "The world stopped");
  });
}

function create(body: any) {
  const name = String(body.name || "Sandbox").trim().slice(0, 40);
  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "world"}-${token().slice(0, 4)}`;
  const world: Config = { name, rules: body.rules === "additive" ? "additive" : "open", start: ["hills", "blank"].includes(body.start) ? body.start : "basics", invite: token(), hostKey: token() };
  mkdirSync(join(WORLDS, id));
  writeFileSync(join(WORLDS, id, "config.json"), JSON.stringify(world, null, 2));
  return id;
}

const RELAY = process.env.SANDBOX_RELAY ?? "https://sandbox-relay.lundqvistliss.com";

/** Makes this machine reachable through the public relay, which forwards players' requests and sockets over one outbound connection. */
function share(on: boolean) {
  if (!on) {
    const current = tunnel;
    tunnel = null;
    current?.ws.close();
    void publish();
    return;
  }
  if (tunnel) return;
  tunnelError = null;
  state.room ??= `${token().slice(0, 8)}`;
  state.relayToken ??= token() + token();
  saveState();
  const ws = new WebSocket(`${RELAY.replace(/^http/, "ws")}/_host?room=${state.room}&token=${state.relayToken}`);
  const current = (tunnel = { ws, url: null as string | null });
  const local = new Map<number, { ws: WebSocket; queue: string[] }>();
  const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "ping" })), 20_000);
  const reply = (msg: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
  ws.onopen = () => {
    current.url = `${RELAY}/r/${state.room}`;
    void publish();
  };
  ws.onmessage = async ({ data }) => {
    const msg = JSON.parse(String(data));
    if (msg.t === "req") {
      const started = performance.now();
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}${msg.path}`, { method: msg.method, headers: msg.headers, body: msg.body && Buffer.from(msg.body, "base64"), redirect: "manual", decompress: false });
        const headers = Object.fromEntries([...res.headers].filter(([k]) => !["content-length", "transfer-encoding", "connection"].includes(k)));
        reply({ t: "res", id: msg.id, status: res.status, headers });
        if (res.body) for await (const chunk of res.body) reply({ t: "chunk", id: msg.id, data: Buffer.from(chunk).toString("base64") });
      } catch (e: any) {
        reply({ t: "res", id: msg.id, status: 502, headers: { "content-type": "text/plain" } });
        reply({ t: "chunk", id: msg.id, data: Buffer.from(String(e?.message ?? e)).toString("base64") });
      }
      reply({ t: "end", id: msg.id });
      proxy.add(`relay ${msg.method} ${route(msg.path.split("?")[0])}`, performance.now() - started);
    } else if (msg.t === "open") {
      const upstream = new WebSocket(`ws://127.0.0.1:${PORT}${msg.path}`, { headers: msg.headers } as any);
      const pipe = { ws: upstream, queue: [] as string[] };
      local.set(msg.id, pipe);
      upstream.onopen = () => {
        for (const m of pipe.queue) upstream.send(m);
        pipe.queue = [];
      };
      upstream.onmessage = (e) => reply({ t: "msg", id: msg.id, data: String(e.data) });
      upstream.onclose = (e) => {
        if (local.delete(msg.id)) reply({ t: "close", id: msg.id, code: e.code, reason: e.reason });
      };
    } else if (msg.t === "msg") {
      const pipe = local.get(msg.id);
      if (pipe?.ws.readyState === WebSocket.OPEN) pipe.ws.send(msg.data);
      else pipe?.queue.push(msg.data);
    } else if (msg.t === "close") {
      const pipe = local.get(msg.id);
      local.delete(msg.id);
      pipe?.ws.close();
    }
  };
  ws.onclose = (e) => {
    clearInterval(ping);
    for (const pipe of local.values()) pipe.ws.close();
    if (tunnel !== current) return;
    tunnel = null;
    void publish();
    tunnelError = `Lost the connection to ${RELAY}${e.reason ? `: ${e.reason}` : ""}. Retrying in 5 seconds.`;
    console.error(tunnelError);
    setTimeout(() => state.sharing && !tunnel && share(true), 5_000);
  };
}

const lan = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && a.family === "IPv4" && !a.internal)?.address;

/** Host-only controls the running world serves itself. */
async function world(action: string, body?: object) {
  if (!running) throw new Error("No world is running.");
  const res = await fetch(`http://127.0.0.1:${running.port}/api/host/${action}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${config(running.id).hostKey}` },
    body: body && JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

/** The running world's public address, so its invite links point at the relay rather than wherever the host opened the game. */
async function publish() {
  if (running) await world("public", { url: tunnel?.url ?? null });
}

async function menuState() {
  const live = running && config(running.id);
  return {
    worlds: worlds(),
    running:
      running && live
        ? { id: running.id, name: live.name, invite: live.invite, hostKey: live.hostKey, players: await world("players"), snapshots: await world("snapshots") }
        : null,
    lan: lan ? `http://${lan}:${PORT}` : null,
    tunnel: tunnel ? { url: tunnel.url } : null,
    tunnelError,
  };
}

async function menuApi(req: Request, action: string) {
  if (req.headers.get("authorization") !== `Bearer ${state.hostKey}`) return Response.json({ error: "Only the host can use the main menu. Open the link printed in the host's terminal." }, { status: 401 });
  const body = req.method === "POST" ? await req.json() : {};
  try {
    if (action === "create") await host(create(body));
    else if (action === "host") await host(String(body.id));
    else if (action === "stop") {
      await stop();
      state.hosting = null;
      saveState();
    } else if (action === "delete") {
      if (running?.id === body.id) throw new Error("Stop the world before deleting it.");
      if (!/^[a-z0-9-]+$/.test(body.id ?? "")) throw new Error("That world doesn't exist.");
      rmSync(join(WORLDS, body.id), { recursive: true, force: true });
    } else if (action === "configure") {
      if (running?.id === body.id) throw new Error("Stop the world before changing it.");
      if (!/^[a-z0-9-]+$/.test(body.id ?? "") || !existsSync(join(WORLDS, body.id, "config.json"))) throw new Error("That world doesn't exist.");
      const current = config(body.id);
      const name = String(body.name ?? current.name).trim().slice(0, 40) || current.name;
      writeFileSync(join(WORLDS, body.id, "config.json"), JSON.stringify({ ...current, name, rules: body.rules === "additive" ? "additive" : body.rules === "open" ? "open" : current.rules }, null, 2));
    } else if (action === "share") {
      share(!!body.on);
      state.sharing = !!body.on;
      saveState();
    }
    else if (["remove", "invite", "rewind"].includes(action)) await world(action, body);
    else if (action !== "state") return Response.json({ error: "Unknown action" }, { status: 404 });
    return Response.json(await menuState());
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 });
  }
}

const page = (file: string) => new Response(Bun.file(join(ENGINE, "client", file)), { headers: { "content-type": "text/html" } });

Bun.serve<Pipe>({
  port: PORT,
  idleTimeout: 255,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/menu") return page("menu.html");
    if (url.pathname.startsWith("/api/menu/")) return menuApi(req, url.pathname.slice("/api/menu/".length));
    const front = await frontFile(url.pathname);
    if (front) return front;
    if (url.pathname.startsWith("/vendor/three/")) {
      const file = Bun.file(join(ENGINE, "../node_modules/three", url.pathname.slice("/vendor/three/".length).replaceAll("..", "")));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    }
    if (!running) return url.pathname === "/" ? page("menu.html") : Response.json({ error: "No world is running right now." }, { status: 503 });
    if (req.headers.get("upgrade") === "websocket")
      return server.upgrade(req, { data: { target: `ws://127.0.0.1:${running.port}${url.pathname}${url.search}`, queue: [] } }) ? undefined : new Response("upgrade failed", { status: 400 });
    // Pass compressed bodies through as they are: decompressing here would leave a gzip header on plain bytes.
    const started = performance.now();
    const res = await fetch(`http://127.0.0.1:${running.port}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: req.body, redirect: "manual", decompress: false });
    proxy.add(`${req.method} ${route(url.pathname)}`, performance.now() - started);
    return res;
  },
  websocket: {
    // Ticks are repetitive JSON: compressed they take about a third of the bandwidth.
    perMessageDeflate: true,
    open(ws) {
      players.add(ws);
      const upstream = new WebSocket(ws.data.target);
      ws.data.upstream = upstream;
      upstream.onopen = () => {
        for (const msg of ws.data.queue) upstream.send(msg);
        ws.data.queue = [];
      };
      upstream.onmessage = (e) => ws.send(e.data, true);
      // Codes 1005/1006 describe a dropped connection and may not be sent, so they become 1011.
      upstream.onclose = (e) => ws.close(e.code === 1000 || e.code >= 3000 ? e.code : 1011, e.reason);
    },
    message(ws, msg) {
      if (ws.data.upstream?.readyState === WebSocket.OPEN) ws.data.upstream.send(String(msg));
      else ws.data.queue.push(String(msg));
    },
    close(ws) {
      players.delete(ws);
      ws.data.upstream?.close();
    },
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    tunnel?.ws.close();
    await stop();
    process.exit(0);
  });

if (state.hosting && existsSync(join(WORLDS, state.hosting))) await host(state.hosting).catch((e) => console.error(e.message));
if (state.sharing)
  try {
    share(true);
  } catch (e: any) {
    console.error(e.message);
  }
const menuLink = `http://localhost:${PORT}/menu#key=${state.hostKey}`;
console.log(`\n  Main menu (keep private): ${menuLink}\n`);
if (process.platform === "darwin" && !process.env.SANDBOX_NO_OPEN) Bun.spawn(["open", menuLink]);
