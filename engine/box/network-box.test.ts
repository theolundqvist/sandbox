import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { createBroker } from "./broker";
import { box, boxReason } from "./index";

const base = join(import.meta.dir, "../../.scratch/test-tmp");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, "network-box-"));
const home = join(root, "fake-home");
const own = join(root, "mod");
const dbDir = join(root, "mod-db");
const scratch = join(root, "scratch");
for (const dir of [home, own, dbDir, scratch, join(home, ".ssh"), join(own, "node_modules")]) mkdirSync(dir, { recursive: true });
const canary = `SYNTHETIC-ONLY-${crypto.randomUUID()}`;
const secrets = {
  home: join(home, ".ssh", "id_fixture"),
  env: join(root, ".env"),
  launcher: join(root, "launcher.json"),
  world: join(root, "world.sqlite"),
  outside: join(root, "outside.txt"),
};
for (const path of Object.values(secrets)) writeFileSync(path, canary);
// An installed dependency is copied into the mod's private tree, not imported from the host's node_modules.
cpSync(join(import.meta.dir, "../../node_modules/fflate"), join(own, "node_modules/fflate"), { recursive: true });
const mod = join(own, "mod.ts");
const runner = join(import.meta.dir, "network-box.child.ts");
let allowedHits = 0;
let privateHits = 0;
const allowed: Server<undefined> = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req, server) {
    allowedHits++;
    if (new URL(req.url).pathname === "/ws" && server.upgrade(req)) return;
    return Response.json({ marker: "allowed-stub", host: req.headers.get("host") });
  },
  websocket: {
    open(ws) { ws.send("ready"); },
    message(ws, data) { ws.send(String(data)); ws.close(4001, "done"); },
  },
});
const privateServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
  privateHits++;
  return new Response("private");
} });
const target = { ...secrets, dbDir, allowed: allowed.port, privatePort: privateServer.port };
writeFileSync(mod, `
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { unzipSync, zipSync } from "fflate";
export const name = "imported-mod-export";
const target = ${JSON.stringify(target)};
function readable(path: string) {
  try { return readFileSync(path, "utf8").length > 0; } catch { return false; }
}
function raw(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { resolve(true); socket.destroy(); });
    socket.once("error", () => resolve(false));
  });
}
export async function run() {
  const results: Record<string, boolean> = {
    home: readable(target.home),
    env: readable(target.env),
    launcher: readable(target.launcher),
    world: readable(target.world),
  };
  try { writeFileSync(target.outside, "damaged"); results.outsideWrite = true; }
  catch { results.outsideWrite = false; }
  try { results.shell = Bun.spawnSync(["/bin/sh", "-c", "true"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0; }
  catch { results.shell = false; }
  results.rawAllowedSocket = await raw(target.allowed);
  results.rawPrivateSocket = await raw(target.privatePort);
  try { await fetch("http://127.0.0.1:" + target.privatePort + "/private"); results.brokerPrivatePort = true; }
  catch { results.brokerPrivatePort = false; }
  const response = await fetch("http://pinned.invalid:" + target.allowed + "/http");
  const body = await response.json();
  results.fetch = response.status === 200 && body.marker === "allowed-stub" && body.host === "pinned.invalid:" + target.allowed;
  const ws = new WebSocket("ws://pinned.invalid:" + target.allowed + "/ws");
  results.websocket = await new Promise(resolve => {
    const messages: string[] = [];
    ws.onmessage = (ev) => {
      messages.push(String(ev.data));
      if (messages.length === 1) ws.send("ping");
    };
    ws.onclose = (ev) => resolve(messages.join(",") === "ready,ping" && ev.code === 4001 && ev.reason === "done");
    ws.onerror = () => resolve(false);
  });
  const zipped = zipSync({ "legit.txt": new TextEncoder().encode("private-package") });
  results.npm = new TextDecoder().decode(unzipSync(zipped)["legit.txt"]) === "private-package";
  const db = new Database(target.dbDir + "/mod.sqlite");
  db.run("create table marker (value text)");
  db.query("insert into marker values (?)").run("sqlite-ok");
  results.sqlite = db.query("select value from marker").get()?.value === "sqlite-ok";
  db.close();
  return results;
}
`);

afterAll(() => {
  allowed.stop(true);
  privateServer.stop(true);
  rmSync(root, { recursive: true, force: true });
});

test("the same boxed mod is confined while brokered fetch, WebSocket, npm, SQLite and exports work", async () => {
  expect(boxReason()).toBeNull();
  const started = { allowed: allowedHits, private: privateHits };
  const broker = createBroker((reply) => proc.send(reply), {
    allow: [`127.0.0.1:${allowed.port}`],
    lookup: async (host) => host === "pinned.invalid" ? [{ address: "127.0.0.1", family: 4 }] : [],
  });
  const received = Promise.withResolvers<{ name: unknown; results: unknown }>();
  const proc = box({
    cmd: [process.execPath, runner, mod], cwd: own, read: [own, runner, join(import.meta.dir, "network.ts")], write: [dbDir], scratch,
    ipc(message, child) {
      if (broker.receive(message)) return;
      if (message && typeof message === "object" && "t" in message && message.t === "result") {
        received.resolve({ name: "name" in message ? message.name : undefined, results: "results" in message ? message.results : undefined });
        child.send({ t: "ack" });
      }
    },
  });
  const output = new Response(proc.stdout).text();
  const errors = new Response(proc.stderr).text();
  try {
    const report = await Promise.race([
      received.promise,
      proc.exited.then(code => { throw new Error(`boxed mod exited without reporting (exit ${code})`); }),
      Bun.sleep(10000).then(() => { throw new Error("boxed mod timed out"); }),
    ]);
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(report.name).toBe("imported-mod-export");
    expect(report.results).toEqual({
      home: false, env: false, launcher: false, world: false, outsideWrite: false, shell: false,
      rawAllowedSocket: false, rawPrivateSocket: false, brokerPrivatePort: false,
      fetch: true, websocket: true, npm: true, sqlite: true,
    });
    expect(allowedHits - started.allowed).toBe(2);
    expect(privateHits - started.private).toBe(0);
    expect(readFileSync(secrets.outside, "utf8") === canary).toBe(true);
    expect((await output).includes(canary)).toBe(false);
    expect((await errors).includes(canary)).toBe(false);
  } finally {
    broker.close();
    proc.kill();
  }
}, 15000);
