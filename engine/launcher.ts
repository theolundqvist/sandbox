import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Server, ServerWebSocket, Subprocess } from "bun";
import { frontFile } from "./front";
import { latencies, openRecord, route, type Recorder } from "./record";
import type { Config } from "./server";
import { importWorld, readTarball } from "./share";

const ENGINE = import.meta.dir;
const DATA = process.env.SANDBOX_DATA ?? join(ENGINE, "../data");
const WORLDS = join(DATA, "worlds");
const PORT = Number(process.env.PORT ?? 7777);
const STATE = join(DATA, "launcher.json");
/** Keys for paid services the host adds in the game, outside every world's folder and readable only by this user. */
const SECRETS = join(DATA, "secrets.json");

const token = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
mkdirSync(WORLDS, { recursive: true });
const state: { hostKey: string; hosting: string | null; sharing?: boolean; room?: string; relayToken?: string; code?: string } = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { hostKey: token(), hosting: null };
const saveState = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const CODE_LETTERS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => CODE_LETTERS[b % CODE_LETTERS.length]).join("");
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

/** When each world last crashed; a world that keeps crashing is left stopped instead of restarted forever. */
const crashes = new Map<string, number[]>();
const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = 10 * 60_000;

async function host(id: string, notice?: string) {
  if (running?.id === id) return;
  if (!existsSync(join(WORLDS, id, "config.json"))) throw new Error("That game doesn't exist.");
  await stop();
  let reportPort!: (port: number) => void;
  const started = Date.now();
  const record = openRecord(join(WORLDS, id, "record.sqlite"));
  // Everything the world prints, including Bun's report if it crashes, kept next to its record.
  const logPath = join(WORLDS, id, "world.log");
  if (existsSync(logPath) && statSync(logPath).size > 5 << 20) renameSync(logPath, `${logPath}.1`);
  const log = createWriteStream(logPath, { flags: "a" });
  const proc = Bun.spawn([process.execPath, join(ENGINE, "server.ts")], {
    env: { ...process.env, SANDBOX_DATA: join(WORLDS, id), SANDBOX_SECRETS: SECRETS, PORT: "0", ...(notice && { SANDBOX_NOTICE: notice }) },
    stdout: "pipe",
    stderr: "pipe",
    ipc: (msg) => reportPort(msg.port),
  });
  const lastLines: string[] = [];
  const forward = async (from: ReadableStream<Uint8Array>, to: NodeJS.WriteStream) => {
    const decoder = new TextDecoder();
    for await (const chunk of from) {
      to.write(chunk);
      log.write(chunk);
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
    log.end();
  });
  const port = await new Promise<number>((resolve, reject) => {
    reportPort = resolve;
    proc.exited.then(() => reject(new Error("The world crashed while starting. Try again.")));
  });
  running = { id, proc, port, record, recorded };
  state.hosting = id;
  saveState();
  await publish();
  proc.exited.then(async () => {
    if (running?.proc !== proc) return;
    running = null;
    const recent = [...(crashes.get(id) ?? []).filter((at) => Date.now() - at < CRASH_WINDOW_MS), Date.now()];
    crashes.set(id, recent);
    if (recent.length <= CRASH_LIMIT) {
      await recorded;
      // Players' games keep reconnecting and land in the restarted world.
      const restarted = await host(id, "The game crashed and restarted by itself. Anything from the last few seconds before the crash may be gone.").then(() => true, (e) => (console.error(e.message), false));
      if (restarted) return;
    }
    for (const ws of players) ws.close(4001, "The world stopped");
  });
}

const NAMES = ["Amber Hollow", "Cinder Flats", "Frost Reach", "Copper Bay", "Ember Ridge", "Moss Harbor", "Salt Mesa", "Iron Grove", "Dune Sea", "Glass Lake", "Thorn Vale", "Echo Point", "Pine Barrens", "Stone Garden", "Lantern Isle", "Fog Basin"];

/** A name no other world here has, for a world created without one. */
function freshName() {
  const taken = new Set(worlds().map((w) => w.name));
  const free = NAMES.filter((n) => !taken.has(n));
  return free.length ? free[Math.floor(Math.random() * free.length)]! : `World ${taken.size + 1}`;
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "world";
const newId = (name: string) => `${slug(name)}-${token().slice(0, 4)}`;
const exists = (id: unknown): id is string => typeof id === "string" && /^[a-z0-9-]+$/.test(id) && existsSync(join(WORLDS, id, "config.json"));

function create(body: any) {
  const name = String(body.name ?? "").trim().slice(0, 40) || freshName();
  const id = newId(name);
  const world: Config = { name, rules: body.rules === "additive" ? "additive" : "open", start: ["hills", "blank"].includes(body.start) ? body.start : "basics", invite: token(), hostKey: token() };
  mkdirSync(join(WORLDS, id));
  writeFileSync(join(WORLDS, id, "config.json"), JSON.stringify(world, null, 2));
  return id;
}

/** Packs or unpacks a world in a worker of its own, so the game this launcher proxies keeps flowing meanwhile. */
function archive(msg: object, transfer: Transferable[] = []): Promise<any> {
  const worker = new Worker(new URL("./archive.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => (data.error ? reject(new Error(data.error)) : resolve(data));
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage(msg, transfer);
  }).finally(() => worker.terminate());
}

/** The whole game as one zip, running or not, without the secrets that let anyone into it here. */
async function packWorld(id: unknown) {
  if (!exists(id)) throw new Error("That game doesn't exist.");
  const { zip } = await archive({ t: "pack", dir: join(WORLDS, id) });
  return new Response(zip, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${slug(config(id).name)}.zip"` } });
}

/** A world exported elsewhere, as a new world here with its own id, invite and host key. */
async function unpackWorld(zip: Uint8Array) {
  const staging = join(DATA, `importing-${token()}`);
  try {
    const { world } = await archive({ t: "unpack", zip, into: staging }, [zip.buffer]);
    const id = create(world);
    for (const part of readdirSync(staging)) if (part !== "config.json") renameSync(join(staging, part), join(WORLDS, id, part));
    return id;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Set by this launcher on everything it forwards from the relay, whatever the player sent, so relayed requests never pass as local. */
const RELAYED = "x-sandbox-relayed";
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Whoever sits at this machine is the host, including through an SSH port forward, which also arrives on loopback.
 * Proxies on this machine (the relay tunnel, cloudflared, nginx) arrive on loopback too, so any forwarding header disqualifies,
 * and the Host header must name localhost so a page rebound to 127.0.0.1 by DNS can't read the key.
 */
function local(req: Request, server: Server<Pipe>) {
  if (!LOOPBACK.has(server.requestIP(req)?.address ?? "")) return false;
  if ([RELAYED, "forwarded", "x-forwarded-for", "x-real-ip", "cf-connecting-ip", "via"].some((h) => req.headers.has(h))) return false;
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.get("host") ?? "");
}

const RELAY = process.env.SANDBOX_RELAY ?? "https://sandbox-relay.lundqvistliss.com";

/** Makes this machine reachable through the public relay, which forwards players' requests and sockets over one outbound connection. */
function share(on: boolean) {
  if (!on) {
    const current = tunnel;
    tunnel = null;
    if (current?.ws.readyState === WebSocket.OPEN) current.ws.send(JSON.stringify({ t: "code", code: null }));
    current?.ws.close();
    delete state.code;
    saveState();
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
    state.code ??= newCode();
    saveState();
    void publish();
  };
  ws.onmessage = async ({ data }) => {
    const msg = JSON.parse(String(data));
    if (msg.t === "code" && msg.taken === state.code) {
      state.code = newCode();
      saveState();
      void publish();
    } else if (msg.t === "req") {
      const started = performance.now();
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}${msg.path}`, { method: msg.method, headers: { ...msg.headers, [RELAYED]: "1" }, body: msg.body && Buffer.from(msg.body, "base64"), redirect: "manual", decompress: false });
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
      const upstream = new WebSocket(`ws://127.0.0.1:${PORT}${msg.path}`, { headers: { ...msg.headers, [RELAYED]: "1" } } as any);
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
    tunnelError = "Can't reach the Sandbox relay, so only people on your Wi-Fi can join. Trying again…";
    console.error(`Lost the connection to ${RELAY}${e.reason ? `: ${e.reason}` : ""}. Retrying in 5 seconds.`);
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

/** The running world's public address and join code, so its invites point at the relay rather than wherever the host opened the game. */
async function publish() {
  const code = tunnel?.url ? state.code : null;
  if (code && tunnel?.ws.readyState === WebSocket.OPEN) tunnel.ws.send(JSON.stringify({ t: "code", code, invite: running ? config(running.id).invite : null }));
  if (running) await world("public", { url: tunnel?.url ?? null, code, lan: lan ? `http://${lan}:${PORT}` : null });
}

type Secrets = { elevenlabs?: { key: string; host: string } };
const secrets = (): Secrets => readJson(SECRETS);
/** ElevenLabs serves each key from one region; the world transcribes through whichever accepted it. */
const ELEVENLABS = process.env.SANDBOX_ELEVENLABS ? [process.env.SANDBOX_ELEVENLABS] : ["https://api.elevenlabs.io", "https://api.eu.residency.elevenlabs.io"];

/** Checks a voice key with an empty clip, which ElevenLabs rejects as audio only after accepting the key. */
async function setVoiceKey(raw: unknown) {
  const key = String(raw ?? "").trim();
  const next = secrets();
  if (!key) delete next.elevenlabs;
  else {
    let reached = false;
    for (const host of ELEVENLABS) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(0)], { type: "audio/webm" }), "check.webm");
      form.append("model_id", "scribe_v2");
      const res = await fetch(`${host}/v1/speech-to-text`, { method: "POST", headers: { "xi-api-key": key }, body: form, signal: AbortSignal.timeout(10_000) }).catch(() => null);
      if (!res) continue;
      reached = true;
      if (res.status !== 401 && res.status !== 403) {
        next.elevenlabs = { key, host };
        break;
      }
    }
    if (!next.elevenlabs) throw new Error(reached ? "That key didn't work. Copy it again from elevenlabs.io." : "Can't reach ElevenLabs. Check your connection.");
  }
  writeFileSync(SECRETS, JSON.stringify(next, null, 2), { mode: 0o600 });
  chmodSync(SECRETS, 0o600);
  if (running) await world("voice", {});
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
    tunnel: tunnel ? { url: tunnel.url, code: tunnel.url ? state.code : null } : null,
    relay: RELAY,
    tunnelError,
    voiceKey: secrets().elevenlabs ? `••••${secrets().elevenlabs!.key.slice(-4)}` : null,
  };
}

async function menuApi(req: Request, action: string) {
  if (req.headers.get("authorization") !== `Bearer ${state.hostKey}`) return Response.json({ error: "Only the host can open this menu, on their own computer." }, { status: 401 });
  const body = req.method === "POST" && action !== "import" ? await req.json() : {};
  try {
    if (action === "browse") return Response.json(await market());
    if (action === "check") {
      const repo = repoOf(body.repo);
      const listed = (await market().catch(() => [])).some((w) => w.repo.toLowerCase() === repo.toLowerCase());
      return Response.json({ repo, owner: repo.split("/")[0], listed });
    }
    if (action === "create") await host(create(body));
    else if (action === "install") await host(await install(body.repo, body.trust === true));
    else if (action === "export") return await packWorld(body.id);
    else if (action === "import") await unpackWorld(await req.bytes());
    else if (action === "host") await host(String(body.id));
    else if (action === "stop") {
      await stop();
      state.hosting = null;
      saveState();
      await publish();
    } else if (action === "delete") {
      if (running?.id === body.id) throw new Error("Stop the game before deleting it.");
      if (!/^[a-z0-9-]+$/.test(body.id ?? "")) throw new Error("That game doesn't exist.");
      rmSync(join(WORLDS, body.id), { recursive: true, force: true });
    } else if (action === "configure") {
      if (running?.id === body.id) throw new Error("Stop the game before changing it.");
      if (!exists(body.id)) throw new Error("That game doesn't exist.");
      const current = config(body.id);
      const name = String(body.name ?? current.name).trim().slice(0, 40) || current.name;
      writeFileSync(join(WORLDS, body.id, "config.json"), JSON.stringify({ ...current, name, rules: body.rules === "additive" ? "additive" : body.rules === "open" ? "open" : current.rules }, null, 2));
    } else if (action === "code") {
      if (!tunnel?.url) throw new Error("Share the game first.");
      state.code = newCode();
      saveState();
      await publish();
    } else if (action === "share") {
      share(!!body.on);
      state.sharing = !!body.on;
      saveState();
    }
    else if (action === "invite") {
      await world(action, body);
      await publish();
    } else if (["remove", "rewind"].includes(action)) await world(action, body);
    else if (action === "voice") await setVoiceKey(body.key);
    else if (action !== "state") return Response.json({ error: "Unknown action" }, { status: 404 });
    return Response.json(await menuState());
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 });
  }
}

/** The worlds anyone can play from Browse: a list in the main repository, which only its maintainers change. */
const MARKET = process.env.SANDBOX_MARKET ?? "https://raw.githubusercontent.com/theolundqvist/sandbox/master/worlds.json";
const RAW = process.env.SANDBOX_RAW ?? "https://raw.githubusercontent.com";
const CODELOAD = process.env.SANDBOX_CODELOAD ?? "https://codeload.github.com";

/** owner/name from a GitHub link however it was pasted: github.com/o/r, a URL into the repo, or o/r. */
function repoOf(link: unknown) {
  const m = String(link ?? "").trim().match(/^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?([A-Za-z0-9-]{1,39})\/([\w.-]{1,100}?)(?:\.git)?\/?(?:[/?#].*)?$/i);
  if (!m) throw new Error("Paste a GitHub link, like github.com/someone/their-world.");
  return `${m[1]}/${m[2]}`;
}

async function market() {
  const res = await fetch(MARKET, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res?.ok) throw new Error("Can't reach GitHub. Check your connection.");
  const list: { repo: string; name: string; description: string }[] = await res.json();
  return list.flatMap((w) => {
    try {
      const repo = repoOf(w.repo);
      return [{ repo, name: String(w.name), description: String(w.description ?? ""), cover: `${RAW}/${repo}/HEAD/cover.jpg` }];
    } catch {
      return [];
    }
  });
}

/** Downloads a world from GitHub as a tarball, so hosting one needs no git, and makes it a new world here. */
async function install(link: unknown, trust: boolean) {
  const repo = repoOf(link);
  const listed = (await market().catch(() => [])).some((w) => w.repo.toLowerCase() === repo.toLowerCase());
  if (!listed && !trust) throw new Error(`This world runs code from ${repo.split("/")[0]}. Only play worlds from people you trust.`);
  const res = await fetch(`${CODELOAD}/${repo}/tar.gz/HEAD`).catch(() => null);
  if (!res) throw new Error("Can't reach GitHub. Check your connection.");
  if (!res.ok) throw new Error(res.status === 404 ? `There is no public world at github.com/${repo}.` : `GitHub answered ${res.status}. Try again.`);
  const files = await readTarball(await res.bytes());
  const name = String((await files.get("world.json")?.json().catch(() => null))?.name ?? "");
  const id = newId(name);
  try {
    await importWorld(files, join(WORLDS, id), token);
  } catch (e) {
    rmSync(join(WORLDS, id), { recursive: true, force: true });
    throw e;
  }
  return id;
}

const page = (file: string) => new Response(Bun.file(join(ENGINE, "client", file)), { headers: { "content-type": "text/html" } });

Bun.serve<Pipe>({
  port: PORT,
  idleTimeout: 255,
  // Bun's default of 128 MB is less than a long-played world's zip.
  maxRequestBodySize: 2 ** 30,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/menu") return page("menu.html");
    if (url.pathname === "/api/local-key") return local(req, server) ? Response.json({ key: state.hostKey }) : Response.json({ error: "Only on the host's own computer." }, { status: 401 });
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

async function shutdown() {
  tunnel?.ws.close();
  await stop();
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown);
// The desktop app hosts through this launcher; if the app dies without stopping it, its end of stdin closes.
if (process.env.SANDBOX_EXIT_WITH_STDIN) void Bun.stdin.stream().pipeTo(new WritableStream()).then(shutdown);

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
