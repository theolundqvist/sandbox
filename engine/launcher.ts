import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket, Subprocess } from "bun";
import type { Config } from "./server";

const ENGINE = import.meta.dir;
const DATA = process.env.SANDBOX_DATA ?? join(ENGINE, "../data");
const WORLDS = join(DATA, "worlds");
const PORT = Number(process.env.PORT ?? 7777);
const STATE = join(DATA, "launcher.json");

const token = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
mkdirSync(WORLDS, { recursive: true });
const state: { hostKey: string; hosting: string | null; sharing?: boolean } = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { hostKey: token(), hosting: null };
const saveState = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
saveState();

type Pipe = { target: string; upstream?: WebSocket; queue: string[] };
let running: { id: string; proc: Subprocess; port: number } | null = null;
let tunnel: { proc: Subprocess; url: string | null } | null = null;
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
  current.proc.kill("SIGTERM");
  await current.proc.exited;
}

async function host(id: string) {
  if (running?.id === id) return;
  if (!existsSync(join(WORLDS, id, "config.json"))) throw new Error("That world doesn't exist.");
  await stop();
  let reportPort!: (port: number) => void;
  const proc = Bun.spawn([process.execPath, join(ENGINE, "server.ts")], {
    env: { ...process.env, SANDBOX_DATA: join(WORLDS, id), PORT: "0" },
    stdout: "inherit",
    stderr: "inherit",
    ipc: (msg) => reportPort(msg.port),
  });
  const port = await new Promise<number>((resolve, reject) => {
    reportPort = resolve;
    proc.exited.then(() => reject(new Error("The world crashed while starting; the terminal shows why.")));
  });
  running = { id, proc, port };
  state.hosting = id;
  saveState();
  proc.exited.then(() => {
    if (running?.proc !== proc) return;
    running = null;
    for (const ws of players) ws.close(4001, "The world stopped");
  });
}

function create(body: any) {
  const name = String(body.name || "Sandbox").trim().slice(0, 40);
  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "world"}-${token().slice(0, 4)}`;
  const world: Config = { name, rules: body.rules === "additive" ? "additive" : "open", start: body.start === "blank" ? "blank" : "basics", invite: token(), hostKey: token() };
  mkdirSync(join(WORLDS, id));
  writeFileSync(join(WORLDS, id, "config.json"), JSON.stringify(world, null, 2));
  return id;
}

function share(on: boolean) {
  if (!on) {
    tunnel?.proc.kill();
    tunnel = null;
    return;
  }
  if (tunnel) return;
  if (!Bun.which("cloudflared")) throw new Error("Sharing over the internet needs cloudflared: brew install cloudflared (or see developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads).");
  const proc = Bun.spawn(["cloudflared", "tunnel", "--no-autoupdate", "--protocol", "http2", "--url", `http://localhost:${PORT}`], { stdout: "ignore", stderr: "pipe" });
  const current = (tunnel = { proc, url: null as string | null });
  (async () => {
    let url: string | undefined;
    for await (const chunk of proc.stderr) {
      const text = new TextDecoder().decode(chunk);
      url ??= text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
      if (url && text.includes("Registered tunnel connection")) current.url = url;
    }
  })();
  proc.exited.then(() => tunnel === current && (tunnel = null));
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
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/menu") return page("menu.html");
    if (url.pathname.startsWith("/api/menu/")) return menuApi(req, url.pathname.slice("/api/menu/".length));
    if (!running) return url.pathname === "/" ? page("menu.html") : Response.json({ error: "No world is running right now." }, { status: 503 });
    if (req.headers.get("upgrade") === "websocket")
      return server.upgrade(req, { data: { target: `ws://127.0.0.1:${running.port}${url.pathname}${url.search}`, queue: [] } }) ? undefined : new Response("upgrade failed", { status: 400 });
    return fetch(`http://127.0.0.1:${running.port}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: req.body, redirect: "manual" });
  },
  websocket: {
    open(ws) {
      players.add(ws);
      const upstream = new WebSocket(ws.data.target);
      ws.data.upstream = upstream;
      upstream.onopen = () => {
        for (const msg of ws.data.queue) upstream.send(msg);
        ws.data.queue = [];
      };
      upstream.onmessage = (e) => ws.send(e.data);
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
    tunnel?.proc.kill();
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
