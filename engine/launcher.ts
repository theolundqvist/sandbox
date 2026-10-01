import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Server, ServerWebSocket, Subprocess } from "bun";
import { frontFile } from "./front";
import { hasGit } from "./mods";
import { latencies, openRecord, route, type Recorder } from "./record";
import type { Config } from "./server";
import { identify, PROVIDERS, type Voice } from "./voice";

const ENGINE = import.meta.dir;
const DATA = process.env.SANDBOX_DATA ?? join(ENGINE, "../data");
const WORLDS = join(DATA, "worlds");
const PORT = Number(process.env.PORT ?? 7777);
const STATE = join(DATA, "launcher.json");
/** Keys for paid services the host adds in the game, outside every world's folder and readable only by this user. */
const SECRETS = join(DATA, "secrets.json");

const token = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
mkdirSync(WORLDS, { recursive: true });
const state: { hostKey: string; hosting: string | null; room?: string; relayToken?: string } = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { hostKey: token(), hosting: null };
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
let tunnel: { ws: WebSocket } | null = null;
let tunnelError: string | null = null;
const players = new Set<ServerWebSocket<Pipe>>();

const readJson = (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
const config = (id: string): Config => readJson(join(WORLDS, id, "config.json"));

function worlds() {
  const shared = sharedWorlds();
  return readdirSync(WORLDS)
    .filter((id) => existsSync(join(WORLDS, id, "config.json")))
    .map((id) => {
      const dir = join(WORLDS, id);
      const { name, rules, start, password, agents } = config(id);
      const saved = [join(dir, "world.sqlite"), join(dir, "config.json")].find(existsSync)!;
      return {
        id,
        name,
        rules,
        start,
        password: password ?? "",
        agents: agents !== false,
        mods: Object.keys(readJson(join(dir, "mods.json"))).length,
        players: Object.keys(readJson(join(dir, "keys.json"))).length,
        played: statSync(saved).mtimeMs,
        cover: existsSync(join(dir, "cover.jpg")) ? statSync(join(dir, "cover.jpg")).mtimeMs : null,
        shared: shared[id]?.link ? { link: shared[id].link, visibility: shared[id].visibility, title: shared[id].title, description: shared[id].description } : null,
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
  current.proc.send({ t: "stop" });
  await current.recorded;
}

/** When each world last crashed; a world that keeps crashing is left stopped instead of restarted forever. */
const crashes = new Map<string, number[]>();
const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = 10 * 60_000;

/** The mod whose reload went live within a minute before the world crashed, which the restart leaves out. */
function crashedAfterReload(id: string) {
  const path = join(WORLDS, id, "mods.json");
  if (!existsSync(path)) return;
  const mods: Record<string, { at?: number }> = JSON.parse(readFileSync(path, "utf8"));
  const [name, last] = Object.entries(mods).sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0))[0] ?? [];
  return last?.at && Date.now() - last.at < 60_000 ? name : undefined;
}

async function host(id: string, notice?: string, revert?: string) {
  if (running?.id === id) return;
  if (!existsSync(join(WORLDS, id, "config.json"))) throw new Error("That world doesn't exist.");
  await stop();
  let reportPort!: (port: number) => void;
  const started = Date.now();
  const record = openRecord(join(WORLDS, id, "record.sqlite"));
  // Everything the world prints, including Bun's report if it crashes, kept next to its record.
  const logPath = join(WORLDS, id, "world.log");
  if (existsSync(logPath) && statSync(logPath).size > 5 << 20) renameSync(logPath, `${logPath}.1`);
  const log = createWriteStream(logPath, { flags: "a" });
  const proc = Bun.spawn([process.execPath, join(ENGINE, "server.ts")], {
    env: { ...process.env, SANDBOX_DATA: join(WORLDS, id), SANDBOX_SECRETS: SECRETS, PORT: "0", ...(notice && { SANDBOX_NOTICE: notice }), ...(revert && { SANDBOX_REVERT: revert }) },
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
    // Under whatever the world printed as it died, what the launcher knew about it.
    if (!stopped && proc.exitCode !== 0) {
      const ago = (at: number) => `${Math.round((Date.now() - at) / 1000)} s ago`;
      const reload = record.rows({ kind: "reload", since: started, limit: 1 })[0];
      log.write(
        `[launcher] exited with ${how} after ${Math.round((Date.now() - started) / 1000)} s. ` +
          (lastSample ? `Last sample ${ago(lastSample.at)}: ${lastSample.data.rssMB} MB RSS, ${lastSample.data.heapMB} MB heap. ` : "No sample yet. ") +
          (reload ? `Last reload ${ago(reload.at)}: ${reload.data.mod} by ${reload.who}, ${reload.data.ok ? `v${reload.data.version}` : `failed at ${reload.data.stage}`}.` : "No reload since it started.") +
          "\n",
      );
    }
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
  share(true);
  await publish();
  proc.exited.then(async () => {
    if (running?.proc !== proc) return;
    running = null;
    const recent = [...(crashes.get(id) ?? []).filter((at) => Date.now() - at < CRASH_WINDOW_MS), Date.now()];
    crashes.set(id, recent);
    if (recent.length <= CRASH_LIMIT) {
      const revert = crashedAfterReload(id);
      await recorded;
      // Players' games keep reconnecting and land in the restarted world.
      const notice = `The world crashed and restarted by itself${revert ? ` without the last change to ${revert}` : ""}. Anything from the last few seconds before the crash may be gone.`;
      const restarted = await host(id, notice, revert).then(() => true, (e) => (console.error(e.message), false));
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

/** What the Host screen sets on a world, each left as it was when not given: its house rules, an optional password, and whether agents may connect. */
const settings = (body: any, current?: Config): Pick<Config, "rules" | "password" | "agents"> => ({
  rules: body.rules === "additive" || body.rules === "open" ? body.rules : (current?.rules ?? "open"),
  password: typeof body.password === "string" ? body.password.trim() || undefined : current?.password,
  agents: body.agents === false ? false : body.agents === true ? undefined : current?.agents,
});

/** Saves a world's settings, and says whether they changed. */
function configure(id: string, body: any) {
  const current = config(id);
  const next = { ...current, name: String(body.name ?? current.name).trim().slice(0, 40) || current.name, ...settings(body, current) };
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  writeFileSync(join(WORLDS, id, "config.json"), JSON.stringify(next, null, 2));
  return true;
}

function create(body: any) {
  const name = String(body.name ?? "").trim().slice(0, 40) || freshName();
  const id = newId(name);
  const world: Config = { name, ...settings(body), start: ["hills", "blank"].includes(body.start) ? body.start : "basics", invite: token(), hostKey: token() };
  mkdirSync(join(WORLDS, id));
  writeFileSync(join(WORLDS, id, "config.json"), JSON.stringify(world, null, 2));
  return id;
}

/** Packs or unpacks a world in a worker of its own, so the world this launcher proxies keeps flowing meanwhile. */
function archive(msg: object, transfer: Transferable[] = []): Promise<any> {
  const worker = new Worker(new URL("./archive.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => (data.error ? reject(new Error(data.error)) : resolve(data));
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage(msg, transfer);
  }).finally(() => worker.terminate());
}

/** The whole world as one zip, running or not, without the secrets that let anyone into it here. */
async function packWorld(id: unknown) {
  if (!exists(id)) throw new Error("That world doesn't exist.");
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
    current?.ws.close();
    return;
  }
  if (tunnel) return;
  state.room ??= `${token().slice(0, 8)}`;
  state.relayToken ??= token() + token();
  saveState();
  const ws = new WebSocket(`${RELAY.replace(/^http/, "ws")}/_host?room=${state.room}&token=${state.relayToken}`);
  const current = (tunnel = { ws });
  const local = new Map<number, { ws: WebSocket; queue: string[] }>();
  const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "ping" })), 20_000);
  const reply = (msg: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
  ws.onopen = () => {
    tunnelError = null;
    void publish();
  };
  ws.onmessage = async ({ data }) => {
    const msg = JSON.parse(String(data));
    if (msg.t === "req") {
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
    tunnelError = "Can't reach the Sandbox relay, so only people on your Wi-Fi can join. Trying again…";
    void publish();
    console.error(`Lost the connection to ${RELAY}${e.reason ? `: ${e.reason}` : ""}. Retrying in 5 seconds.`);
    setTimeout(() => running && !tunnel && share(true), 5_000);
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

/** A world's one invite: through the relay, which keeps the same room across restarts, or on this Wi-Fi alone while the relay can't be reached. */
const invite = (id: string) => ({ link: `${tunnelError ? `http://${lan ?? "localhost"}:${PORT}` : `${RELAY}/r/${state.room}`}/#invite=${config(id).invite}`, wifiOnly: !!tunnelError });

/** Tells the running world its invite, so its Invite page shows the link that works rather than wherever the host opened the world. */
async function publish() {
  if (running) await world("public", invite(running.id));
}

type Secrets = { voice?: Voice; elevenlabs?: { key: string; host: string } };
const secrets = (): Secrets => readJson(SECRETS);
function saveSecrets(next: Secrets) {
  writeFileSync(SECRETS, JSON.stringify(next, null, 2), { mode: 0o600 });
  chmodSync(SECRETS, 0o600);
}
// Voice keys were ElevenLabs' alone before any other provider could be added.
const { elevenlabs, ...migrated } = secrets();
if (elevenlabs) saveSecrets({ voice: { provider: "ElevenLabs", ...elevenlabs }, ...migrated });

async function setVoiceKey(raw: unknown) {
  const key = String(raw ?? "").trim();
  const next = secrets();
  if (key) next.voice = await identify(key);
  else delete next.voice;
  saveSecrets(next);
  if (running) await world("voice", {});
}

async function menuState() {
  const { voice } = secrets();
  const live = running && config(running.id);
  return {
    worlds: worlds(),
    running:
      running && live
        ? { id: running.id, name: live.name, invite: live.invite, ...invite(running.id), hostKey: live.hostKey, players: await world("players"), snapshots: await world("snapshots") }
        : null,
    relay: RELAY,
    voiceKey: voice ? `${voice.provider} ••••${voice.key.slice(-4)}` : null,
    voiceProviders: PROVIDERS.map(({ name, keys, free }) => ({ name, keys, free: !!free })),
  };
}

/** A world's picture: its host's game sends a frame of their own view, and Worlds shows it. */
async function cover(req: Request, id: string) {
  const path = join(WORLDS, id, "cover.jpg");
  if (!/^[a-z0-9-]+$/.test(id) || !existsSync(join(WORLDS, id, "config.json"))) return Response.json({ error: "That world doesn't exist." }, { status: 404 });
  if (req.method !== "POST") return existsSync(path) ? new Response(Bun.file(path), { headers: { "content-type": "image/jpeg", "cache-control": "no-cache" } }) : new Response(null, { status: 404 });
  const jpeg = new Uint8Array(await req.arrayBuffer());
  if (jpeg.length > 2 << 20 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return Response.json({ error: "A cover is a JPEG under 2 MB." }, { status: 400 });
  writeFileSync(`${path}.tmp`, jpeg);
  renameSync(`${path}.tmp`, path);
  return new Response(null, { status: 204 });
}

async function menuApi(req: Request, action: string) {
  if (req.headers.get("authorization") !== `Bearer ${state.hostKey}`) return Response.json({ error: "Only the host can open this menu, on their own computer." }, { status: 401 });
  if (action === "cover") return cover(req, new URL(req.url).searchParams.get("id") ?? "");
  const body = req.method === "POST" && action !== "import" ? await req.json() : {};
  try {
    if (action === "community") return Response.json(await communityList());
    if (action === "community-world") return Response.json(await communityWorld(body.link));
    if (action === "create") await host(create(body));
    else if (action === "community-get") {
      const id = await download(body.id, body.trust === true, body.host === true);
      if (body.host === true) await host(id);
      return Response.json({ ...(await menuState()), world: id });
    } else if (action === "share") return Response.json(await shareWorld(body));
    else if (action === "unshare") await unshareWorld(body.id);
    else if (action === "export") return await packWorld(body.id);
    else if (action === "import") await unpackWorld(await req.bytes());
    else if (action === "host") {
      // A world hosted with new settings starts again under them.
      if (exists(body.id) && configure(body.id, body) && running?.id === body.id) await stop();
      await host(String(body.id));
    }
    else if (action === "stop") {
      await stop();
      share(false);
      state.hosting = null;
      saveState();
    } else if (action === "delete") {
      if (running?.id === body.id) throw new Error("Stop the world before deleting it.");
      if (!/^[a-z0-9-]+$/.test(body.id ?? "")) throw new Error("That world doesn't exist.");
      rmSync(join(WORLDS, body.id), { recursive: true, force: true });
    } else if (action === "configure") {
      if (running?.id === body.id) throw new Error("Stop the world before changing it.");
      if (!exists(body.id)) throw new Error("That world doesn't exist.");
      configure(body.id, body);
    } else if (["remove", "rewind"].includes(action)) await world(action, body);
    else if (action === "voice") await setVoiceKey(body.key);
    else if (action !== "state") return Response.json({ error: "Unknown action" }, { status: 404 });
    return Response.json(await menuState());
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 });
  }
}

/** Community worlds: a server anyone can share a world to, with no sign-in; this launcher keeps each world's owner token, so only this computer changes what it shared. */
const COMMUNITY = process.env.SANDBOX_COMMUNITY ?? "https://sandbox.api.lundqvistliss.com";
/** Per world here: where it is shared and the token that changes it, and the community world it was downloaded from. Never in a world's folder, so no export carries it. */
const SHARED = join(DATA, "community.json");
type Shared = { id?: string; ownerToken?: string; link?: string; visibility?: "link" | "public"; title?: string; description?: string; from?: string };
const sharedWorlds = (): Record<string, Shared> => readJson(SHARED);
function saveShared(id: string, next: Shared | null) {
  const all = sharedWorlds();
  if (next) all[id] = next;
  else delete all[id];
  writeFileSync(SHARED, JSON.stringify(all, null, 2), { mode: 0o600 });
  chmodSync(SHARED, 0o600);
}
const COMMUNITY_ID = /^[a-z0-9]{12}$/;
const ENGINE_VERSION =
  process.env.SANDBOX_VERSION ?? ((hasGit && Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: ENGINE, stdout: "pipe", stderr: "ignore" }).stdout.toString().trim()) || "dev");

async function community(path: string, init?: RequestInit) {
  const res = await fetch(`${COMMUNITY}${path}`, { ...init, signal: AbortSignal.timeout(init?.body ? 300_000 : 15_000) }).catch(() => null);
  if (!res) throw new Error("Can't reach Community. Check your connection.");
  return res;
}
async function communityJson(path: string, init?: RequestInit) {
  const res = await community(path, init);
  const data = await res.json().catch(() => ({ error: `Community answered ${res.status}. Try again.` }));
  if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status });
  return data;
}
/** Which of these this computer shared, so it can say Shared rather than ask to trust its own world. */
const mine = (id: string) => Object.values(sharedWorlds()).some((s) => s.id === id && s.ownerToken);

async function communityList() {
  const list: { id: string }[] = await communityJson("/worlds");
  return list.map((w) => ({ ...w, mine: mine(w.id) }));
}

/** A community world from its link, however it was pasted: the page's address or the id alone. */
async function communityWorld(link: unknown) {
  const id = String(link ?? "").trim().match(/(?:^|\/w\/)([a-z0-9]{12})(?:[/?#].*)?$/)?.[1];
  if (!id) throw new Error("Paste a Community link, like sandbox.lundqvistliss.com/w/….");
  const world = await communityJson(`/worlds/${id}`);
  return { ...world, mine: mine(id) };
}

/** A community world as a world here. Hosting one again reuses the copy made last time; a remix is always a new world of this computer's, credited to the one it came from. */
async function download(id: unknown, trust: boolean, hosting: boolean) {
  if (typeof id !== "string" || !COMMUNITY_ID.test(id)) throw new Error("That world isn't in Community.");
  const world = await communityJson(`/worlds/${id}`);
  if (!trust && !mine(id)) throw new Error(`This world runs code from ${world.author}. Only play worlds from people you trust.`);
  const copy = hosting && Object.entries(sharedWorlds()).find(([local, s]) => s.from === id && !s.ownerToken && exists(local))?.[0];
  if (copy) return copy;
  const res = await fetch(world.zip, { signal: AbortSignal.timeout(300_000) }).catch(() => null);
  if (!res) throw new Error("Can't reach Community. Check your connection.");
  if (!res.ok) throw new Error(res.status === 404 ? "That world isn't in Community any more." : `Community answered ${res.status}. Try again.`);
  const local = await unpackWorld(await res.bytes());
  saveShared(local, { from: id });
  return local;
}

/** Shares a world of this computer's: its export without what its players did and said, with a cover and the timelapse's clip. Sharing it again updates the same community world. */
async function shareWorld(body: any) {
  if (!exists(body.id)) throw new Error("That world doesn't exist.");
  const visibility = body.visibility === "public" ? "public" : "link";
  const coverPath = join(WORLDS, body.id, "cover.jpg");
  const cover = body.cover ? Buffer.from(String(body.cover), "base64") : existsSync(coverPath) ? readFileSync(coverPath) : null;
  const before = sharedWorlds()[body.id] ?? {};
  // An update without a new picture keeps the one Community has.
  if (!cover && !before.ownerToken) throw new Error("This world has no picture yet. Pick Current view.");
  const { zip } = await archive({ t: "pack", dir: join(WORLDS, body.id), community: true });
  const files: Record<string, { bytes: Uint8Array<ArrayBuffer>; type: string }> = { zip: { bytes: zip, type: "application/zip" } };
  if (cover) files.cover = { bytes: cover, type: "image/jpeg" };
  if (body.clip) files.clip = { bytes: Buffer.from(String(body.clip), "base64"), type: "video/webm" };
  const details = { title: String(body.title ?? "").trim() || config(body.id).name, description: String(body.description ?? "").trim(), author: String(body.author ?? "").trim(), visibility, remixOf: before.from, engineVersion: ENGINE_VERSION, mods: Object.keys(readJson(join(WORLDS, body.id, "mods.json"))).length };
  const request = (method: string, path: string, token?: string) => communityJson(path, { method, body: JSON.stringify({ ...details, files: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, f.bytes.length])) }), headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) } });
  // A world taken down from Community is shared again as a new one.
  const updated = before.id && before.ownerToken && (await request("PUT", `/worlds/${before.id}`, before.ownerToken).catch((e) => (e.status === 404 ? null : Promise.reject(e))));
  const started = updated ? { ...updated, ownerToken: before.ownerToken } : await request("POST", "/worlds");
  await Promise.all(
    Object.entries(files).map(async ([kind, f]) => {
      const res = await fetch(started.uploads[kind], { method: "PUT", body: f.bytes, headers: { "content-type": f.type }, signal: AbortSignal.timeout(600_000) }).catch(() => null);
      if (!res?.ok) throw new Error("The world didn't finish uploading. Check your connection and share it again.");
    }),
  );
  const { link } = await communityJson(`/worlds/${started.id}/done`, { method: "POST", headers: { authorization: `Bearer ${started.ownerToken}` } });
  saveShared(body.id, { ...before, id: started.id, ownerToken: started.ownerToken, link, visibility, title: details.title, description: details.description });
  return { link, visibility };
}

async function unshareWorld(id: unknown) {
  const shared = typeof id === "string" ? sharedWorlds()[id] : undefined;
  if (!shared?.id || !shared.ownerToken) throw new Error("That world isn't shared.");
  const res = await community(`/worlds/${shared.id}`, { method: "DELETE", headers: { authorization: `Bearer ${shared.ownerToken}` } });
  if (!res.ok && res.status !== 404) throw new Error(`Community answered ${res.status}. Try again.`);
  saveShared(id as string, shared.from ? { from: shared.from } : null);
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
    // A world that dies mid-request is hosted again by itself; whoever asked, often a player's Claude in wait_for_chat, gets a plain answer rather than Bun's error page.
    const res = await fetch(`http://127.0.0.1:${running.port}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: req.body, redirect: "manual", decompress: false }).catch(
      () => new Response("The game stopped before it answered. It starts again by itself: try again in a few seconds.\n", { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } }),
    );
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
const menuLink = `http://localhost:${PORT}/menu#key=${state.hostKey}`;
// The link carries the host key, so it goes only to a terminal, never into a log file; on this computer the menu finds the key by itself.
console.log(process.stdout.isTTY ? `\n  Main menu (keep private): ${menuLink}\n` : `Main menu: http://localhost:${PORT}/menu`);
/** How a desktop opens a link in the browser; a Linux launcher is usually a server, so it only prints the link. */
const BROWSER: Partial<Record<NodeJS.Platform, string[]>> = { darwin: ["open"], win32: ["rundll32", "url.dll,FileProtocolHandler"] };
const opener = BROWSER[process.platform];
if (opener && !process.env.SANDBOX_NO_OPEN) Bun.spawn([...opener, menuLink]);
