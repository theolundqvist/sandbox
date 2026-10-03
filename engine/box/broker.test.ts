// The egress broker between a boxed child and the network. A stand-in mod process talks to it over real IPC: it reaches
// local stubs only at the exact addresses the host allowed, every redirect hop is checked, and nothing a child sends
// widens what is allowed.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { lookup } from "node:dns/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Server, Subprocess } from "bun";
import type { Command } from "./broker.child";
import { createBroker, publicAddress, type Broker, type NetReply } from "./broker";

type Hit = { stub: string; path: string; host: string | null };
type FetchResult = { status: number; url: string; redirected: boolean; headers: Record<string, string>; body: string };
type Upgrade = { host: string; mod: string };
type Distribute<T> = T extends unknown ? Omit<T, "id"> : never;

const hits: Hit[] = [];
let slowCancelled = false;

function stub(name: string): Server<Upgrade> {
  return Bun.serve<Upgrade>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      hits.push({ stub: name, path: url.pathname, host: req.headers.get("host") });
      const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } });
      switch (url.pathname) {
        case "/json":
          return Response.json({ hello: "world" }, { headers: { "x-stub": name } });
        case "/echo": {
          const h = (key: string) => req.headers.get(key);
          return Response.json({ method: req.method, host: h("host"), type: h("content-type"), mod: h("x-mod"), auth: h("authorization"), body: await req.text() }, { status: 201 });
        }
        case "/to-json":
          return redirect(302, "/json");
        case "/to-other":
          return redirect(302, `http://127.0.0.1:${other.port}/secret`);
        case "/to-peer":
          return redirect(307, `http://127.0.0.1:${peer.port}/echo`);
        case "/see-other":
          return redirect(303, "/echo");
        case "/slow":
          return new Response(
            new ReadableStream({
              start: (controller) => controller.enqueue(new TextEncoder().encode("first")),
              cancel: () => {
                slowCancelled = true;
              },
            }),
          );
        case "/ws":
          return server.upgrade(req, { data: { host: req.headers.get("host") ?? "", mod: req.headers.get("x-mod") ?? "" } }) ? undefined : new Response("no upgrade", { status: 400 });
      }
      return new Response("secret");
    },
    websocket: {
      open: (ws) => void ws.send(`hello ${ws.data.host} ${ws.data.mod}`),
      message: (ws, msg) => (msg === "bye" ? ws.close(4001, "done") : void ws.send(msg)),
    },
  });
}

const api = stub("api");
const peer = stub("peer");
/** Never allowed: anything reaching it is a hole. */
const other = stub("other");
const allow = [`127.0.0.1:${api.port}`, `[::1]:${api.port}`, `127.0.0.1:${peer.port}`];
/** .invalid names never resolve for real, so a stub reached by one shows the connection went to the address the broker checked. */
const names: Record<string, string[]> = { "pinned.invalid": ["127.0.0.1"], "mixed.invalid": ["127.0.0.1", "93.184.215.14"] };
const testLookup = async (host: string) => names[host]?.map((address) => ({ address, family: 4 })) ?? (await lookup(host, { all: true }));

let child: Subprocess<"ignore", "inherit", "inherit">;
let broker: Broker;
const waiting = new Map<number, (result: { value?: unknown; error?: string }) => void>();
let seq = 0;

/** Runs a command in the stand-in mod process and gives its result, or throws its error. */
async function inChild<T>(cmd: Distribute<Command>): Promise<T> {
  const id = ++seq;
  const { promise, resolve } = Promise.withResolvers<{ value?: unknown; error?: string }>();
  waiting.set(id, resolve);
  child.send({ ...cmd, id });
  const result = await promise;
  if (result.error !== undefined) throw new Error(result.error);
  return result.value as T;
}

async function until(what: string, check: () => boolean) {
  for (let i = 0; !check(); i++) {
    if (i > 100) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

beforeAll(async () => {
  const ready = Promise.withResolvers<void>();
  broker = createBroker((msg) => child.send(msg), { allow, lookup: testLookup });
  child = Bun.spawn([process.execPath, join(import.meta.dir, "broker.child.ts")], {
    env: { PATH: process.env.PATH ?? "" },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    ipc(msg) {
      if (broker.receive(msg)) return;
      if (msg.t === "ready") ready.resolve();
      else waiting.get(msg.id)?.(msg);
    },
  });
  await ready.promise;
});

afterAll(() => {
  child.kill();
  broker.close();
  for (const server of [api, peer, other]) server.stop(true);
});

test("a mod's fetch reaches an allowed stub with its method, headers and body, but not its own Host", async () => {
  const res = await inChild<FetchResult>({
    t: "fetch",
    url: `http://127.0.0.1:${api.port}/echo`,
    init: { method: "POST", headers: { "content-type": "application/json", "x-mod": "legit", host: "evil.example" }, body: '{"n":1}' },
  });
  expect(res.status).toBe(201);
  expect(JSON.parse(res.body)).toEqual({ method: "POST", host: `127.0.0.1:${api.port}`, type: "application/json", mod: "legit", auth: null, body: '{"n":1}' });
  expect((await inChild<FetchResult>({ t: "fetch", url: "data:text/plain,stays%20local" })).body).toBe("stays local");
});

test("a name is resolved once and the connection goes to the checked address, keeping the name as Host", async () => {
  const res = await inChild<FetchResult>({ t: "fetch", url: `http://localhost:${api.port}/json` });
  expect(res).toMatchObject({ status: 200, url: `http://localhost:${api.port}/json`, redirected: false, body: '{"hello":"world"}' });
  expect(res.headers["x-stub"]).toBe("api");
  expect(hits.at(-1)).toEqual({ stub: "api", path: "/json", host: `localhost:${api.port}` });
  expect((await inChild<FetchResult>({ t: "fetch", url: `http://pinned.invalid:${api.port}/json` })).status).toBe(200);
  expect(hits.at(-1)).toEqual({ stub: "api", path: "/json", host: `pinned.invalid:${api.port}` });
});

test("an ambient proxy cannot replace the pinned destination or supply an HTTPS response", async () => {
  const before = hits.length;
  const previous = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = `http://127.0.0.1:${other.port}`;
  try {
    for (const protocol of ["http:", "https:"])
      await expect(inChild({ t: "fetch", url: `${protocol}//pinned.invalid:${api.port}/json` })).rejects.toThrow("destination addresses cannot be pinned safely");
    expect(hits.slice(before)).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previous;
  }
  expect((await inChild<FetchResult>({ t: "fetch", url: `http://pinned.invalid:${api.port}/json` })).body).toBe('{"hello":"world"}');
});

test("loopback, private, link-local, CGNAT, multicast and IPv4-mapped targets are refused before any connection", async () => {
  const before = hits.length;
  const refused = [
    `http://127.0.0.1:${other.port}/secret`,
    `http://localhost:${other.port}/secret`,
    `http://mixed.invalid:${other.port}/secret`,
    `http://0x7f.1:${other.port}/secret`,
    `http://[::ffff:127.0.0.1]:${other.port}/secret`,
    `http://[::1]:${other.port}/secret`,
    `http://0.0.0.0:${other.port}/secret`,
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://100.64.0.1/",
    "http://224.0.0.1/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
  ];
  for (const url of refused) await expect(inChild({ t: "fetch", url })).rejects.toThrow(/egress refused: .* is not a public address/);
  await expect(inChild({ t: "fetch", url: "http://1.1.1.1:25/" })).rejects.toThrow("egress refused: port 25 is not allowed");
  await expect(inChild({ t: "fetch", url: "file:///etc/hostname" })).rejects.toThrow("file: URLs are not available to mods");
  expect(await inChild<unknown[][]>({ t: "ws", url: `ws://127.0.0.1:${other.port}/ws`, messages: [] })).toEqual([
    ["error", "egress refused: 127.0.0.1 is not a public address"],
    ["close", 1006, "", false],
  ]);
  expect(hits.slice(before)).toEqual([]);
});

test("every redirect hop is checked like the first request", async () => {
  const before = hits.length;
  await expect(inChild({ t: "fetch", url: `http://127.0.0.1:${api.port}/to-other` })).rejects.toThrow("egress refused: 127.0.0.1 is not a public address");
  expect(hits.slice(before).map((h) => `${h.stub}${h.path}`)).toEqual(["api/to-other"]);

  const followed = await inChild<FetchResult>({ t: "fetch", url: `http://127.0.0.1:${api.port}/to-json` });
  expect(followed).toMatchObject({ status: 200, redirected: true, url: `http://127.0.0.1:${api.port}/json`, body: '{"hello":"world"}' });

  const manual = await inChild<FetchResult>({ t: "fetch", url: `http://127.0.0.1:${api.port}/to-json`, init: { redirect: "manual" } });
  expect(manual).toMatchObject({ status: 302, redirected: false });
  expect(manual.headers.location).toBe("/json");
  await expect(inChild({ t: "fetch", url: `http://127.0.0.1:${api.port}/to-json`, init: { redirect: "error" } })).rejects.toThrow('redirect is "error"');

  // 303 turns a POST into a body-less GET; 307 keeps it, but a credential doesn't follow it to another origin.
  const seeOther = await inChild<FetchResult>({ t: "fetch", url: `http://127.0.0.1:${api.port}/see-other`, init: { method: "POST", headers: { "content-type": "text/plain" }, body: "x" } });
  expect(JSON.parse(seeOther.body)).toMatchObject({ method: "GET", type: null, body: "" });
  const kept = await inChild<FetchResult>({ t: "fetch", url: `http://127.0.0.1:${api.port}/to-peer`, init: { method: "POST", headers: { authorization: "Bearer mod-token" }, body: "kept" } });
  expect(JSON.parse(kept.body)).toMatchObject({ method: "POST", host: `127.0.0.1:${peer.port}`, auth: null, body: "kept" });
});

test("a mod's WebSocket reaches an allowed stub through a loopback endpoint pinned to the checked address", async () => {
  const events = await inChild<unknown[][]>({ t: "ws", url: `ws://pinned.invalid:${api.port}/ws`, protocols: ["chat", "v2"], headers: { "x-mod": "legit" }, messages: ["hi", [1, 2, 3], "bye"] });
  expect(events.slice(0, -1)).toEqual([
    ["open", "chat"],
    ["message", `hello pinned.invalid:${api.port} legit`],
    ["message", "hi"],
    ["message", [1, 2, 3]],
  ]);
  // Bun's own client reports even a clean close by the server as unclean, so only the code and reason are compared.
  expect(events.at(-1)?.slice(0, 3)).toEqual(["close", 4001, "done"]);
});

test("WebSockets work and stay pinned whatever proxy settings the host has", async () => {
  let proxied = 0;
  const proxy = createServer((socket) => {
    proxied++;
    socket.destroy();
  });
  const listening = Promise.withResolvers<void>();
  proxy.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = proxy.address();
  const proxyUrl = `http://127.0.0.1:${address && typeof address === "object" ? address.port : 0}`;
  const keys = ["NO_PROXY", "no_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];
  const saved = keys.map((key) => [key, process.env[key]] as const);
  const settings: Record<string, string>[] = [
    { NO_PROXY: "*" },
    { NO_PROXY: "pinned.invalid,127.0.0.1,localhost" },
    { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl },
  ];
  try {
    for (const env of settings) {
      for (const key of keys) delete process.env[key];
      Object.assign(process.env, env);
      const replies: NetReply[] = [];
      const proxiedBroker = createBroker(
        (msg) => {
          replies.push(msg);
          if (msg.op === "message") proxiedBroker.receive({ t: "box-net", op: "close", id: 1, code: 1000 });
        },
        { allow, lookup: testLookup },
      );
      proxiedBroker.receive({ t: "box-net", op: "ws", id: 1, url: `ws://pinned.invalid:${api.port}/ws`, protocols: [], headers: [] });
      await until("the socket to close", () => replies.some((r) => r.op === "closed"));
      proxiedBroker.close();
      expect([env, replies.map((r) => (r.op === "message" ? r.text : r.op))]).toEqual([env, ["open", `hello pinned.invalid:${api.port} `, "closed"]]);
    }
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    proxy.close();
  }
  expect(proxied).toBe(0);
});

test("aborting a mod's fetch aborts the host's request", async () => {
  slowCancelled = false;
  expect(await inChild<{ first: string; after: string }>({ t: "abort", url: `http://127.0.0.1:${api.port}/slow` })).toEqual({ first: "first", after: "AbortError" });
  await until("the stub to see the request cancelled", () => slowCancelled);
});

test("forged IPC cannot widen egress or reach anything but the network", async () => {
  const replies: NetReply[] = [];
  const forged = createBroker((msg) => replies.push(msg));
  const before = hits.length;
  const json = `http://127.0.0.1:${api.port}/json`;
  const fetchMsg = { t: "box-net", op: "fetch", method: "GET", headers: [], body: null, redirect: "follow" };
  expect(forged.receive({ t: "log", text: "hi" })).toBe(false);
  expect(forged.receive(null)).toBe(false);
  expect(forged.receive("box-net")).toBe(false);
  for (const msg of [
    { t: "box-net", op: "allow", id: 1, allow: [`127.0.0.1:${api.port}`] },
    { ...fetchMsg, id: 2, url: json, allow: [`127.0.0.1:${api.port}`], options: { allow: [`127.0.0.1:${api.port}`] } },
    { ...fetchMsg, id: 3, url: json, headers: [["x-a", "a\r\nhost: evil"]] },
    { ...fetchMsg, id: 4, url: json, method: "CONNECT" },
    { ...fetchMsg, id: 5, url: `http://user:pw@127.0.0.1:${api.port}/json` },
    { ...fetchMsg, id: 6, url: "file:///etc/hostname" },
    { ...fetchMsg, id: 7, url: json, headers: "x-a: 1" },
    { ...fetchMsg, id: -1, url: json },
    { ...fetchMsg, id: 1.5, url: json },
    { t: "box-net", op: "spawn", id: 8, cmd: ["sh", "-c", "id"] },
    { t: "box-net", op: "ws", id: 9, url: `ws://127.0.0.1:${api.port}/ws`, protocols: [], headers: [], allow: [`127.0.0.1:${api.port}`] },
  ])
    expect(forged.receive(msg)).toBe(true);
  // Requests that are refused outright answer synchronously or not at all; the rest answer once their checks finish.
  await until("every refusal", () => replies.length >= 7);
  const byId = Object.fromEntries(replies.map((r) => [r.id, r.op === "fail" ? r.message : r.op === "closed" ? r.error : r.op]));
  expect(byId).toEqual({
    2: "egress refused: 127.0.0.1 is not a public address",
    3: "fetch: invalid request",
    4: "fetch: invalid request",
    5: "egress refused: URLs with credentials are not allowed",
    6: "egress refused: file: URLs are not allowed",
    7: "fetch: invalid request",
    9: "egress refused: 127.0.0.1 is not a public address",
  });
  expect(hits.slice(before)).toEqual([]);
  forged.close();
});

test("closing the broker aborts what is in flight and sends nothing more, even when the child is gone", async () => {
  const replies: NetReply[] = [];
  const closing = createBroker((msg) => replies.push(msg), { allow });
  slowCancelled = false;
  closing.receive({ t: "box-net", op: "fetch", id: 1, url: `http://127.0.0.1:${api.port}/slow`, method: "GET", headers: [], body: null, redirect: "follow" });
  await until("the first chunk", () => replies.some((r) => r.op === "body"));
  closing.close();
  await until("the stub to see the request cancelled", () => slowCancelled);
  const sent = replies.length;
  const jsonHits = hits.filter((h) => h.path === "/json").length;
  expect(closing.receive({ t: "box-net", op: "fetch", id: 2, url: `http://127.0.0.1:${api.port}/json`, method: "GET", headers: [], body: null, redirect: "follow" })).toBe(true);
  // A full round trip through the live broker lets anything the closed one still had queued run first.
  await inChild({ t: "fetch", url: `http://127.0.0.1:${api.port}/json` });
  expect(replies.length).toBe(sent);
  expect(hits.filter((h) => h.path === "/json").length).toBe(jsonHits + 1);

  let attempts = 0;
  const gone = createBroker(() => {
    attempts++;
    throw new Error("the child exited");
  });
  expect(gone.receive({ t: "box-net", op: "fetch", id: 1, url: "http://10.0.0.1/", method: "GET", headers: [], body: null, redirect: "follow" })).toBe(true);
  await until("the refusal to be sent", () => attempts === 1);
  gone.close();
});

test("only ordinary public unicast addresses count as public", () => {
  const cases: [string, boolean][] = [
    ["8.8.8.8", true],
    ["9.255.255.255", true],
    ["10.0.0.0", false],
    ["11.0.0.0", true],
    ["0.0.0.0", false],
    ["100.63.255.255", true],
    ["100.64.0.0", false],
    ["100.127.255.255", false],
    ["100.128.0.0", true],
    ["127.0.0.1", false],
    ["169.254.169.254", false],
    ["172.15.255.255", true],
    ["172.16.0.0", false],
    ["172.31.255.255", false],
    ["172.32.0.0", true],
    ["192.0.0.8", false],
    ["192.0.2.1", false],
    ["192.168.0.1", false],
    ["198.18.0.1", false],
    ["198.19.255.255", false],
    ["198.20.0.0", true],
    ["223.255.255.255", true],
    ["224.0.0.1", false],
    ["255.255.255.255", false],
    ["2606:4700::6810:84e5", true],
    ["2000::1", true],
    ["1fff::1", false],
    ["4000::1", false],
    ["::", false],
    ["::1", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:8.8.8.8", false],
    ["::8.8.8.8", false],
    ["fe80::1", false],
    ["fe80::1%eth0", false],
    ["fd12:3456::1", false],
    ["ff02::1", false],
    ["2001::1", false],
    ["2001:1ff::1", false],
    ["2001:200::1", true],
    ["2001:db8::1", false],
    ["2002:7f00:1::", false],
    ["3fff::1", false],
    ["3fff:1000::1", true],
    ["64:ff9b::8.8.8.8", true],
    ["64:ff9b::7f00:1", false],
    ["64:ff9b::a00:1", false],
    ["localhost", false],
    ["", false],
  ];
  expect(cases.filter(([address, expected]) => publicAddress(address) !== expected)).toEqual([]);
});
