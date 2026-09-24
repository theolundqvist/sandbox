import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ServerWebSocket } from "bun";
import { createMcp, GAME_MASTER, type Task } from "./mcp";
import { ENGINE_KEYS, Mods } from "./mods";
import { SimHost } from "./simhost";
import { openStore } from "./world";

const ENGINE = import.meta.dir;
const DATA = process.env.SANDBOX_DATA ?? join(ENGINE, "../data");
const ROOT = join(DATA, "world");
const BUILD = join(DATA, "build");
const DB = join(DATA, "db");
const PORT = Number(process.env.PORT ?? 7777);

export type Config = { name: string; rules: "open" | "additive"; start: "basics" | "hills" | "blank"; invite: string; hostKey: string };
type Conn = { name: string };

const token = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const readJson = <T>(file: string, fallback: T): T => (existsSync(join(DATA, file)) ? JSON.parse(readFileSync(join(DATA, file), "utf8")) : fallback);
const writeJson = (file: string, value: unknown) => writeFileSync(join(DATA, file), JSON.stringify(value, null, 2));

mkdirSync(DB, { recursive: true });
const config = readJson<Config>("config.json", { name: "Sandbox", rules: "open", start: "basics", invite: token(), hostKey: token() });
writeJson("config.json", config);
const keys = readJson<Record<string, string>>("keys.json", {});
const owners = readJson<Record<string, string>>("owners.json", {});
const nameByKey = (key: string | null) => (key ? keys[key] : undefined);

const STARTS: Record<Config["start"], string[]> = { basics: ["basics"], hills: ["basics", "hills"], blank: [] };
if (!existsSync(ROOT)) {
  mkdirSync(join(ROOT, "mods"), { recursive: true });
  for (const mod in owners) delete owners[mod];
  for (const mod of STARTS[config.start]) {
    cpSync(join(ENGINE, "seed/mods", mod), join(ROOT, "mods", mod), { recursive: true });
    owners[mod] = "world";
  }
  writeJson("owners.json", owners);
  Bun.spawnSync(["git", "init", "-q"], { cwd: ROOT });
  Bun.spawnSync(["git", "config", "user.name", "sandbox"], { cwd: ROOT });
  Bun.spawnSync(["git", "config", "user.email", "sandbox@sandbox"], { cwd: ROOT });
}
// Seed mods nobody has edited follow engine updates; edited ones are left alone.
const seeded = readJson<Record<string, string>>("seeded.json", {});
const refreshed = new Set<string>();
const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
for (const file of new Bun.Glob("mods/**/*").scanSync(join(ENGINE, "seed"))) {
  const seed = readFileSync(join(ENGINE, "seed", file), "utf8");
  const target = join(ROOT, file);
  const current = existsSync(target) ? sha(readFileSync(target, "utf8")) : null;
  if (current && current === seeded[file] && current !== sha(seed)) {
    writeFileSync(target, seed);
    refreshed.add(file.split("/")[1]!);
  }
  if (existsSync(target) && sha(readFileSync(target, "utf8")) === sha(seed)) seeded[file] = sha(seed);
}
writeJson("seeded.json", seeded);
cpSync(join(ENGINE, "api.ts"), join(ROOT, "api.ts"));
writeFileSync(join(ROOT, ".gitignore"), "node_modules\n");
if (!existsSync(join(ROOT, "package.json"))) writeFileSync(join(ROOT, "package.json"), JSON.stringify({ private: true }, null, 2));
cpSync(join(ENGINE, "GUIDE.md"), join(ROOT, "GUIDE.md"));
writeFileSync(
  join(ROOT, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        lib: ["ESNext", "DOM"],
        target: "ESNext",
        module: "Preserve",
        moduleResolution: "bundler",
        moduleDetection: "force",
        allowImportingTsExtensions: true,
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        typeRoots: [join(ENGINE, "../node_modules/@types")],
        types: ["bun"],
        paths: { "three": [join(ENGINE, "../node_modules/@types/three")], "three/*": [join(ENGINE, "../node_modules/@types/three/*")] },
      },
      include: ["**/*.ts"],
    },
    null,
    2,
  ),
);
Bun.spawnSync(["git", "add", "-A"], { cwd: ROOT });
Bun.spawnSync(["git", "commit", "-qm", "server start"], { cwd: ROOT });

const logs: { at: number; mod: string; level: string; text: string; player?: string }[] = [];
const clientPerf = new Map<string, { at: number } & Record<string, unknown>>();
const feedLog: { at: number; text: string; kind: string }[] = [];
const chatLog: { seq: number; from: string; text: string; spoken?: boolean; claudes?: boolean }[] = [];
const chatWaiters = new Set<() => void>();
let chatSeq = 0;
/** Lines to "claudes" reach only other Claudes' tool results and the Builders tab, never the players' chat. */
function chat(from: string, text: string, how?: "spoken" | "claudes") {
  const spoken = how === "spoken" || undefined;
  const claudes = how === "claudes" || undefined;
  chatLog.push({ seq: ++chatSeq, from, text, spoken, claudes });
  console.log(`[chat] ${claudes ? "[claudes] " : ""}${from}${spoken ? " (voice)" : ""}: ${text}`);
  if (chatLog.length > 2000) chatLog.shift();
  broadcast(claudes ? { t: "talk", from, text } : { t: "chat", from, text, spoken });
  for (const wake of chatWaiters) wake();
}
const sockets = new Map<string, ServerWebSocket<Conn>>();

/** Players' verdicts on the live version of each mod; more than half of those online voting undo reverts it. */
const votes = new Map<string, { version: number; love: Set<string>; undo: Set<string> }>();
function react(from: string, mod: string, kind: string) {
  const live = mods.running.get(mod);
  if (!live || (kind !== "love" && kind !== "undo")) return;
  let v = votes.get(mod);
  if (v?.version !== live.version) votes.set(mod, (v = { version: live.version, love: new Set(), undo: new Set() }));
  if (v[kind].has(from)) return;
  v[kind].add(from);
  v[kind === "love" ? "undo" : "love"].delete(from);
  const needed = Math.floor(sockets.size / 2) + 1;
  broadcast({ t: "votes", mod, love: v.love.size, undo: v.undo.size, needed });
  chat("game", kind === "love" ? `${from} loves ${mod} by ${live.author}` : `${from} votes to undo ${mod} by ${live.author} (${v.undo.size}/${needed})`);
  if (v.undo.size < needed) return;
  votes.delete(mod);
  mods.revert(mod, `the players voted it out`);
}

/** Whether each player's Claude is waiting on the chat, busy, or gone, so players know if anyone hears them. */
type Presence = "listening" | "working" | "offline";
const claudes = new Map<string, { state: Presence; at: number; task?: Task }>();
const builder = (name: string) => ({ state: claudes.get(name)?.state ?? "offline", task: claudes.get(name)?.task });
function presence(name: string, state: Presence) {
  const changed = claudes.get(name)?.state !== state;
  claudes.set(name, { ...claudes.get(name), state, at: Date.now() });
  if (changed) broadcast({ t: "claude", name, ...builder(name) });
}
function setTask(name: string, task: Task) {
  claudes.set(name, { state: "working", ...claudes.get(name), at: Date.now(), task });
  broadcast({ t: "claude", name, ...builder(name) });
}

/** What each mod is, from the last banner its builder gave it. */
const about = readJson<Record<string, { title: string; text: string; color: string }>>("about.json", {});
if (!Object.values(keys).includes(GAME_MASTER)) {
  keys[token() + token()] = GAME_MASTER;
  writeJson("keys.json", keys);
}
const gameMasterKey = Object.keys(keys).find((k) => keys[k] === GAME_MASTER)!;
setInterval(() => {
  for (const [name, c] of claudes) if (c.state === "working" && Date.now() - c.at > 120_000) presence(name, "offline");
}, 15_000);
const broadcast = (msg: object) => {
  const text = JSON.stringify(msg);
  for (const ws of sockets.values()) ws.send(text);
};
function log(mod: string, level: string, text: string, player?: string) {
  logs.push({ at: Date.now(), mod, level, text, player });
  if (logs.length > 1000) logs.shift();
}
function feed(text: string, kind = "info") {
  feedLog.push({ at: Date.now(), text, kind });
  if (feedLog.length > 50) feedLog.shift();
  broadcast({ t: "feed", text, kind });
  console.log(`[feed] ${text}`);
}

const mods = new Mods(ROOT, BUILD, join(DATA, "mods.json"), {
  client: (name, url) => broadcast({ t: "mod", name, url }),
  feed,
});
const sim = new SimHost(DB, () => mods.list(), {
  tick: (outs) => {
    for (const [id, text] of Object.entries(outs)) sockets.get(id)?.send(text);
  },
  log,
  fault: (mod, error) => {
    log(mod, "error", error);
    mods.revert(mod, error);
  },
});
mods.sim = sim;

const store = openStore(join(DATA, "world.sqlite"));
store.load(sim);
await mods.loadAll(owners);
sim.start();
for (const mod of refreshed) await mods.reload(mod, "world", owners[mod] ?? "world");
setInterval(() => store.save(sim), 5000);
store.snapshot(sim);
setInterval(() => store.snapshot(sim), 60_000);
setInterval(() => store.record(sim), 2000);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    store.save(sim);
    process.exit(0);
  });

const clientBuild = await Bun.build({ entrypoints: [join(ENGINE, "client/main.ts")], target: "browser", external: ["three", "three/*"] });
if (!clientBuild.success) throw new AggregateError(clientBuild.logs, "client build failed");
const clientJs = await clientBuild.outputs[0]!.text();

const status = () => ({
  world: config.name,
  rules: config.rules === "additive" ? "additive: you can add mods and change your own, never someone else's" : "open: anyone can change any mod",
  online: [...sockets.keys()],
  mods: [...mods.running].map(([name, m]) => {
    const v = votes.get(name)?.version === m.version ? votes.get(name) : undefined;
    return { name, author: m.author, version: m.version, server: !!m.build.server, client: !!m.build.client, about: about[name], usedBy: mods.users(name), love: v?.love.size ?? 0, undo: v?.undo.size ?? 0 };
  }),
  undoNeeded: Math.floor(sockets.size / 2) + 1,
  controls: { engineKeys: ENGINE_KEYS, ...mods.controls() },
  entities: sim.entities.size,
  recent: feedLog.slice(-15).map((f) => f.text),
});

const perf = () => ({
  server: { ...sim.perf, budget: "a tick is due every 50 ms; mods is ms per tick" },
  entities: sim.entities.size,
  players: Object.fromEntries([...clientPerf].map(([name, { at, ...p }]) => [name, { ...p, secondsOld: Math.round((Date.now() - at) / 1000) }])),
});

let publicUrl: string | null = null;
const shots = new Map<string, (data: string) => void>();
const mcp = createMcp({
  root: ROOT,
  dbDir: DB,
  rules: () => config.rules,
  owners,
  saveOwners: () => writeJson("owners.json", owners),
  mods,
  sim,
  logs,
  feed,
  chat,
  chatLog,
  presence,
  setTask,
  announce: (a) => {
    about[a.mod] = { title: a.title, text: a.text, color: a.color };
    writeJson("about.json", about);
    broadcast({ t: "announce", ...a });
  },
  nextChat: () => new Promise<void>((resolve) => chatWaiters.add(function wake() { chatWaiters.delete(wake); resolve(); })),
  status,
  perf,
  screenshot: (who) =>
    new Promise((resolve, reject) => {
      const ws = sockets.get(who);
      if (!ws) return reject(new Error(`${who} doesn't have the game open, so there is nothing to see.`));
      const id = crypto.randomUUID();
      const timer = setTimeout(() => shots.delete(id) && reject(new Error("The game didn't answer within 5 s.")), 5000);
      shots.set(id, (data) => {
        clearTimeout(timer);
        shots.delete(id);
        resolve(data);
      });
      ws.send(JSON.stringify({ t: "shot", id }));
    }),
});

/** ElevenLabs Scribe in English; it tags sounds like [laughter], and a phrase with nothing but tags was only noise. */
async function transcribe(audio: Blob) {
  const form = new FormData();
  form.append("file", audio, audio.type.includes("mp4") ? "speech.mp4" : "speech.webm");
  form.append("model_id", "scribe_v2");
  form.append("language_code", "eng");
  form.append("tag_audio_events", "true");
  // This key belongs to ElevenLabs' EU data-residency stack, which rejects the global API host.
  const res = await fetch("https://api.eu.residency.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! }, body: form });
  if (!res.ok) throw new Error(`transcription failed: ${res.status} ${await res.text()}`);
  const { text } = (await res.json()) as { text: string };
  return /\p{L}/u.test(text.replace(/\[[^\]]*\]|\([^)]*\)/g, "")) ? text.trim() : "";
}

const html = (file: string) => new Response(Bun.file(join(ENGINE, "client", file)), { headers: { "content-type": "text/html" } });
const bearer = (req: Request) => req.headers.get("authorization")?.replace(/^Bearer /, "") ?? new URL(req.url).searchParams.get("key");

const server = Bun.serve<Conn>({
  port: PORT,
  idleTimeout: 255,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/") return html("index.html");
    if (path === "/client.js") return new Response(clientJs, { headers: { "content-type": "text/javascript" } });
    if (path.startsWith("/vendor/three/")) {
      const file = Bun.file(join(ENGINE, "../node_modules/three", path.slice("/vendor/three/".length).replaceAll("..", "")));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    }
    if (path.startsWith("/assets/")) {
      const [mod, name] = path.slice("/assets/".length).split("/").map(decodeURIComponent);
      const file = Bun.file(join(ROOT, "mods", mod ?? "", "assets", name ?? ""));
      if (![mod, name].every((part) => /^\w[\w.-]*$/.test(part ?? "")) || !(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file);
    }
    if (path.startsWith("/build/")) {
      const file = Bun.file(join(BUILD, path.slice("/build/".length).replaceAll("..", "")));
      return (await file.exists()) ? new Response(file, { headers: { "cache-control": "max-age=31536000, immutable" } }) : new Response("not found", { status: 404 });
    }

    if (path.startsWith("/api/host/")) {
      if (bearer(req) !== config.hostKey) return new Response(null, { status: 401 });
      const body = req.method === "POST" ? await req.json() : {};
      switch (path.slice("/api/host/".length)) {
        case "players":
          return Response.json([...new Set(Object.values(keys))].filter((name) => name !== GAME_MASTER).map((name) => ({ name, online: sockets.has(name), key: Object.keys(keys).find((k) => keys[k] === name) })));
        case "remove": {
          for (const [key, name] of Object.entries(keys)) if (name === body.name) delete keys[key];
          writeJson("keys.json", keys);
          sockets.get(body.name)?.close(4002, "Removed by the host");
          feed(`${body.name} was removed by the host`, "info");
          return Response.json({});
        }
        case "public":
          publicUrl = body.url ?? null;
          broadcast({ t: "public", url: publicUrl });
          return Response.json({});
        case "invite":
          config.invite = token();
          writeJson("config.json", config);
          return Response.json({ invite: config.invite });
        case "snapshots":
          return Response.json(store.snapshots());
        case "rewind": {
          if (!store.rewind(Number(body.at), sim)) return Response.json({ error: "That moment is no longer saved." }, { status: 404 });
          store.save(sim);
          sim.restart();
          feed(`The host rewound the world to ${new Date(Number(body.at)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, "error");
          return Response.json({});
        }
      }
    }
    if (path === "/api/timelapse") {
      const who = nameByKey(bearer(req));
      if (!who) return new Response(null, { status: 401 });
      return new Response(Bun.gzipSync(JSON.stringify(await sim.visibleTo(who, store.ticks(600)))), { headers: { "content-type": "application/json", "content-encoding": "gzip" } });
    }
    if (path === "/api/status") return nameByKey(bearer(req)) ? Response.json({ ...status(), gameMaster: { key: gameMasterKey, ...builder(GAME_MASTER) } }) : new Response(null, { status: 401 });
    if (path === "/api/voice" && req.method === "POST") {
      const who = nameByKey(bearer(req));
      if (!who) return new Response(null, { status: 401 });
      const audio = await req.blob();
      transcribe(audio).then(
        (text) => text && chat(who, text.slice(0, 300), "spoken"),
        (error) => console.log(`[voice] ${who}: ${error.message}`),
      );
      return new Response(null, { status: 204 });
    }
    if (path === "/api/info") return Response.json({ id: basename(DATA), name: config.name, rules: config.rules, online: sockets.size });
    if (path === "/api/join" && req.method === "POST") {
      const body = await req.json();
      const known = nameByKey(body.key);
      if (known) return Response.json({ key: body.key, name: known, invite: config.invite });
      if (body.invite !== config.invite && body.invite !== config.hostKey) return Response.json({ error: "You need an invite link from the host." }, { status: 403 });
      const name = String(body.name ?? "").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{1,15}$/.test(name)) return Response.json({ error: "Names are 2–16 letters, digits, - or _." }, { status: 400 });
      if (Object.values(keys).includes(name)) return Response.json({ error: "That name is taken. If it's you, ask the host for your personal link from their main menu." }, { status: 409 });
      const key = token() + token();
      keys[key] = name;
      writeJson("keys.json", keys);
      return Response.json({ key, name, invite: config.invite });
    }

    if (path === "/mcp") return mcp.http(req, nameByKey(bearer(req)) ?? null);
    if (path === "/cli" || path.startsWith("/cli/")) return mcp.cli(req, nameByKey(bearer(req)) ?? null, path.slice(5) || "script", url.searchParams.get("url"), url.searchParams.get("name"));

    if (path === "/ws") {
      const name = nameByKey(url.searchParams.get("key"));
      if (!name) return new Response("unknown key", { status: 401 });
      return server.upgrade(req, { data: { name } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const { name } = ws.data;
      const previous = sockets.get(name);
      sockets.set(name, ws);
      if (previous) previous.close(4000, "Opened in another tab");
      if (previous) sim.resync(name);
      else sim.send({ t: "join", player: { id: name, name } });
      ws.send(
        JSON.stringify({
          t: "welcome",
          playerId: name,
          world: config.name,
          rules: config.rules,
          invite: config.invite,
          publicUrl,
          voice: !!process.env.ELEVENLABS_API_KEY,
          mods: [...mods.running].filter(([, m]) => m.build.client).map(([name, m]) => ({ name, url: m.build.client })),
          feed: feedLog.slice(-8),
          claudes: Object.fromEntries([...claudes.keys()].map((name) => [name, builder(name)])),
          talk: chatLog.filter((c) => c.claudes).map(({ from, text }) => ({ from, text })),
        }),
      );
      if (!previous) feed(`${name} joined`, "info");
    },
    message(ws, raw) {
      const msg = JSON.parse(String(raw));
      if (msg.t === "m") sim.send({ t: "msg", id: ws.data.name, mod: msg.mod, msg: msg.msg });
      else if (msg.t === "chat") chat(ws.data.name, String(msg.text).slice(0, 300));
      else if (msg.t === "resync") sim.resync(ws.data.name);
      else if (msg.t === "react") react(ws.data.name, String(msg.mod), String(msg.kind));
      else if (msg.t === "shot") shots.get(msg.id)?.(String(msg.data));
      else if (msg.t === "error") log(msg.mod, "client-error", `${ws.data.name}'s game: ${String(msg.text).slice(0, 2000)}`, ws.data.name);
      else if (msg.t === "log") log(String(msg.mod), `client-${msg.level}`, `${ws.data.name}'s game: ${String(msg.text).slice(0, 2000)}`, ws.data.name);
      else if (msg.t === "perf") {
        const { t, at, ...report } = msg;
        clientPerf.set(ws.data.name, { ...report, at: Date.now() });
        ws.send(JSON.stringify({ t: "pong", at }));
      }
    },
    close(ws) {
      if (sockets.get(ws.data.name) !== ws) return;
      sockets.delete(ws.data.name);
      clientPerf.delete(ws.data.name);
      sim.send({ t: "leave", id: ws.data.name });
      feed(`${ws.data.name} left`, "info");
    },
  },
});

const base = `http://localhost:${server.port}`;
console.log(`\n  ${config.name} is running.\n  Host link (keep private): ${base}/#invite=${config.hostKey}\n`);
process.send?.({ port: server.port });
