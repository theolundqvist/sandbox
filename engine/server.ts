import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { createMcp } from "./mcp";
import { Mods } from "./mods";
import { SimHost } from "./simhost";
import { openStore } from "./world";

const ENGINE = import.meta.dir;
const DATA = process.env.SANDBOX_DATA ?? join(ENGINE, "../data");
const ROOT = join(DATA, "world");
const BUILD = join(DATA, "build");
const DB = join(DATA, "db");
const PORT = Number(process.env.PORT ?? 7777);

type Config = { name: string; rules: "open" | "additive"; invite: string; hostKey: string; setup: boolean };
type Conn = { name: string };

const token = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const readJson = <T>(file: string, fallback: T): T => (existsSync(join(DATA, file)) ? JSON.parse(readFileSync(join(DATA, file), "utf8")) : fallback);
const writeJson = (file: string, value: unknown) => writeFileSync(join(DATA, file), JSON.stringify(value, null, 2));

mkdirSync(DB, { recursive: true });
const config = readJson<Config>("config.json", { name: "", rules: "open", invite: token(), hostKey: token(), setup: false });
writeJson("config.json", config);
const keys = readJson<Record<string, string>>("keys.json", {});
const owners = readJson<Record<string, string>>("owners.json", {});
const nameByKey = (key: string | null) => (key ? keys[key] : undefined);

if (!existsSync(ROOT)) {
  cpSync(join(ENGINE, "seed"), ROOT, { recursive: true });
  for (const mod in owners) delete owners[mod];
  owners.basics = "world";
  writeJson("owners.json", owners);
  Bun.spawnSync(["git", "init", "-q"], { cwd: ROOT });
  Bun.spawnSync(["git", "config", "user.name", "sandbox"], { cwd: ROOT });
  Bun.spawnSync(["git", "config", "user.email", "sandbox@sandbox"], { cwd: ROOT });
}
cpSync(join(ENGINE, "api.ts"), join(ROOT, "api.ts"));
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

const logs: { at: number; mod: string; level: string; text: string }[] = [];
const feedLog: { at: number; text: string; kind: string }[] = [];
const sockets = new Map<string, ServerWebSocket<Conn>>();
const broadcast = (msg: object) => {
  const text = JSON.stringify(msg);
  for (const ws of sockets.values()) ws.send(text);
};
function log(mod: string, level: string, text: string) {
  logs.push({ at: Date.now(), mod, level, text });
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
setInterval(() => store.save(sim), 5000);
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
  mods: [...mods.running].map(([name, m]) => ({ name, author: m.author, version: m.version, server: !!m.build.server, client: !!m.build.client })),
  entities: sim.entities.size,
  recent: feedLog.slice(-15).map((f) => f.text),
});

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
  chat: (from, text) => broadcast({ t: "chat", from, text }),
  status,
});

const html = (file: string) => new Response(Bun.file(join(ENGINE, "client", file)), { headers: { "content-type": "text/html" } });
const bearer = (req: Request) => req.headers.get("authorization")?.replace(/^Bearer /, "") ?? new URL(req.url).searchParams.get("key");

const server = Bun.serve<Conn>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/") return html(config.setup ? "index.html" : "setup.html");
    if (path === "/client.js") return new Response(clientJs, { headers: { "content-type": "text/javascript" } });
    if (path.startsWith("/vendor/three/")) {
      const file = Bun.file(join(ENGINE, "../node_modules/three", path.slice("/vendor/three/".length).replaceAll("..", "")));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    }
    if (path.startsWith("/build/")) {
      const file = Bun.file(join(BUILD, path.slice("/build/".length).replaceAll("..", "")));
      return (await file.exists()) ? new Response(file, { headers: { "cache-control": "max-age=31536000, immutable" } }) : new Response("not found", { status: 404 });
    }

    if (path === "/api/setup" && req.method === "POST") {
      const body = await req.json();
      if (body.hostKey !== config.hostKey) return Response.json({ error: "Use the setup link printed in the server terminal." }, { status: 403 });
      if (config.setup) return Response.json({ error: "Already set up." }, { status: 409 });
      config.name = String(body.name || "Sandbox").slice(0, 40);
      config.rules = body.rules === "additive" ? "additive" : "open";
      config.setup = true;
      writeJson("config.json", config);
      return Response.json({ invite: config.invite });
    }
    if (path === "/api/status") return nameByKey(bearer(req)) ? Response.json(status()) : new Response(null, { status: 401 });
    if (path === "/api/info") return Response.json({ name: config.name, rules: config.rules, online: sockets.size });
    if (path === "/api/join" && req.method === "POST") {
      const body = await req.json();
      const known = nameByKey(body.key);
      if (known) return Response.json({ key: body.key, name: known, invite: config.invite });
      if (body.invite !== config.invite && body.invite !== config.hostKey) return Response.json({ error: "You need an invite link from the host." }, { status: 403 });
      const name = String(body.name ?? "").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{1,15}$/.test(name)) return Response.json({ error: "Names are 2–16 letters, digits, - or _." }, { status: 400 });
      if (Object.values(keys).includes(name)) return Response.json({ error: "That name is taken." }, { status: 409 });
      const key = token() + token();
      keys[key] = name;
      writeJson("keys.json", keys);
      return Response.json({ key, name, invite: config.invite });
    }

    if (path === "/mcp") {
      const who = nameByKey(bearer(req));
      if (!who) return Response.json({ error: "Unknown key. Copy the connect command from the game menu." }, { status: 401 });
      return mcp(req, who);
    }

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
          mods: [...mods.running].filter(([, m]) => m.build.client).map(([name, m]) => ({ name, url: m.build.client })),
          feed: feedLog.slice(-8),
        }),
      );
      if (!previous) feed(`${name} joined`, "info");
    },
    message(ws, raw) {
      const msg = JSON.parse(String(raw));
      if (msg.t === "m") sim.send({ t: "msg", id: ws.data.name, mod: msg.mod, msg: msg.msg });
      else if (msg.t === "chat") broadcast({ t: "chat", from: ws.data.name, text: String(msg.text).slice(0, 300) });
      else if (msg.t === "error") log(msg.mod, "client-error", `${ws.data.name}'s game: ${String(msg.text).slice(0, 2000)}`);
    },
    close(ws) {
      if (sockets.get(ws.data.name) !== ws) return;
      sockets.delete(ws.data.name);
      sim.send({ t: "leave", id: ws.data.name });
      feed(`${ws.data.name} left`, "info");
    },
  },
});

const base = `http://localhost:${server.port}`;
console.log(config.setup ? `\n  ${config.name} is running.\n  Host link (keep private): ${base}/#invite=${config.hostKey}\n` : `\n  Set up your world: ${base}/#host=${config.hostKey}\n`);
