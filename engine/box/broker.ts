import { lookup } from "node:dns/promises";
import { connect, createServer, isIP, type Server, type Socket } from "node:net";
import { checkServerIdentity, connect as tlsConnect, type PeerCertificate } from "node:tls";

/**
 * The host half of a boxed child's network. A mod has no sockets: its fetch and WebSocket arrive here over IPC as
 * `{ t: "box-net" }` messages and only HTTP(S) and WS(S) to public addresses go out. Each name is resolved once and the
 * connection goes to the address that was checked, keeping the name's Host header and TLS server name, so DNS can't
 * swap a private address in between. Every redirect is checked the same way. Nothing a child sends can widen this.
 * The host's own downloads from URLs a builder picks (add_asset) go out the same way through `publicGet`.
 */

export const NET = "box-net";
type Pairs = [string, string][];

/** What a boxed child may ask. Ids are the child's own, scoped to its broker; bytes travel as base64 so any IPC serialization carries them. */
export type NetRequest =
  | { t: typeof NET; op: "fetch"; id: number; url: string; method: string; headers: Pairs; body: string | null; redirect: RequestRedirect }
  | { t: typeof NET; op: "abort"; id: number }
  | { t: typeof NET; op: "ws"; id: number; url: string; protocols: string[]; headers: Pairs }
  | { t: typeof NET; op: "send"; id: number; text?: string; data?: string }
  | { t: typeof NET; op: "close"; id: number; code?: number; reason?: string };

/** The broker's answers: a fetch gets head, body chunks and end, or fail; a WebSocket gets open, messages and closed. */
export type NetReply =
  | { t: typeof NET; op: "head"; id: number; status: number; statusText: string; headers: Pairs; url: string; redirected: boolean }
  | { t: typeof NET; op: "body"; id: number; data: string }
  | { t: typeof NET; op: "end"; id: number }
  | { t: typeof NET; op: "fail"; id: number; message: string }
  | { t: typeof NET; op: "open"; id: number; protocol: string; extensions: string }
  | { t: typeof NET; op: "message"; id: number; text?: string; data?: string }
  | { t: typeof NET; op: "closed"; id: number; code: number; reason: string; clean: boolean; error?: string };

export type BrokerOptions = {
  /** Tests only: exact `ip:port` targets (`[ip]:port` for IPv6) let through although not public, e.g. a local stub. Set by the host, never from a mod or its env. */
  allow?: readonly string[];
  /** Tests only: resolves names in place of the system resolver, to show that a connection goes to the address checked rather than the name. */
  lookup?: (hostname: string) => Promise<{ address: string; family: number }[]>;
};

export type Broker = {
  /** Handles a message from the child if it is a network one, and says whether it was. Never throws. */
  receive(msg: unknown): boolean;
  /** Aborts every request and socket of the child; nothing is sent to it afterwards. */
  close(): void;
};

const MAX_OPEN = 64;
const MAX_BODY = 32 * 1024 * 1024;
const MAX_MESSAGE = 16 * 1024 * 1024;
const MAX_URL = 8192;
const MAX_HEADERS = 100;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_REDIRECTS = 20;
const CHUNK = 256 * 1024;
const HTTP = new Set(["http:", "https:"]);
const WS = new Set(["ws:", "wss:"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
/** Headers the broker sets itself or that only make sense per hop. */
const HOP = new Set(["host", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "expect", "http2-settings"]);
/** Dropped when a redirect turns the request into a GET. */
const BODY_HEADERS = new Set(["content-type", "content-encoding", "content-language", "content-location"]);
/** Dropped when a redirect leaves the origin. */
const CREDENTIALS = new Set(["authorization", "cookie"]);
/** The Fetch standard's bad ports: services other than HTTP that a request must not be aimed at (mail, ssh, irc...). */
const BAD_PORTS = new Set([0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
const NAT64 = [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0];

/** Captured at load, so a test that installs the child adapter in this process doesn't route the broker through itself. */
const nativeFetch = globalThis.fetch;
// lib DOM hides the constructor overload that takes Bun's options (headers).
const NativeWebSocket = globalThis.WebSocket as unknown as { new (url: string, options: Bun.WebSocketOptions): WebSocket; readonly OPEN: number };

/** A refusal or failure whose message is meant for whoever asked: the mod, or the builder whose download it is. */
export class EgressError extends Error {}

function ipv4(address: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  const bytes = m?.slice(1).map(Number);
  return bytes && bytes.every((b) => b <= 255) ? bytes : null;
}

function ipv6(address: string): number[] | null {
  let text = address.replace(/%.*$/, "");
  if (isIP(text) !== 6) return null;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (tail) {
    const v4 = ipv4(tail);
    if (!v4) return null;
    text = `${text.slice(0, -tail.length)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const groups = rest === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return groups.length === 8 ? groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]) : null;
}

function publicV4([a, b, c]: number[]) {
  if (a === 0 || a === 10 || a === 127 || a! >= 224) return false; // this network, private, loopback, multicast, reserved and broadcast
  if (a === 100 && (b! & 0xc0) === 64) return false; // 100.64/10 carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && (b! & 0xf0) === 16) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // protocol assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
  if (a === 198 && (b! & 0xfe) === 18) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

/** Whether an IP address is ordinary public unicast, the only kind a mod may reach. */
export function publicAddress(address: string): boolean {
  const v4 = ipv4(address);
  if (v4) return publicV4(v4);
  const v6 = ipv6(address);
  if (!v6) return false;
  // NAT64's well-known prefix carries an IPv4 address, and may only carry a public one.
  if (NAT64.every((b, i) => v6[i] === b)) return publicV4(v6.slice(12));
  // Only 2000::/3 is global unicast: that leaves out IPv4-mapped and -compatible, loopback, unique-local, link-local and multicast.
  const [a, b, c, d] = v6;
  if ((a! & 0xe0) !== 0x20) return false;
  if (a === 0x20 && b === 0x01 && (c! & 0xfe) === 0) return false; // 2001::/23 protocol assignments: Teredo, benchmarking, ORCHID
  if (a === 0x20 && b === 0x01 && c === 0x0d && d === 0xb8) return false; // documentation
  if (a === 0x20 && b === 0x02) return false; // 6to4
  if (a === 0x3f && b === 0xff && (c! & 0xf0) === 0) return false; // documentation
  return true;
}

/** One key per address and port, whatever way the address was written. */
function targetKey(address: string, port: number) {
  const bytes = ipv4(address) ?? ipv6(address);
  return bytes ? `${bytes.join(".")}/${port}` : null;
}

/** The URL's host without IPv6 brackets or a trailing dot: what DNS, TLS and certificates expect. */
function bareHost(url: URL) {
  return url.hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function shortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function base64Fits(value: unknown, bytes: number): value is string {
  return shortString(value, Math.ceil(bytes / 3) * 4);
}

function parseUrl(value: unknown, base?: URL) {
  if (!shortString(value, MAX_URL)) return null;
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

/** A child's headers, lowercased, without the ones the broker owns; null if any is malformed. */
function headerList(value: unknown, drop: (name: string) => boolean): Pairs | null {
  if (!Array.isArray(value) || value.length > MAX_HEADERS) return null;
  const out: Pairs = [];
  let bytes = 0;
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [name, text] = pair as unknown[];
    if (typeof name !== "string" || typeof text !== "string" || !TOKEN.test(name) || !VALUE.test(text)) return null;
    if ((bytes += name.length + text.length) > MAX_HEADER_BYTES) return null;
    const lower = name.toLowerCase();
    if (!drop(lower)) out.push([lower, text]);
  }
  return out;
}

const hopHeader = (name: string) => HOP.has(name) || name.startsWith("proxy-");
const socketHeader = (name: string) => hopHeader(name) || name.startsWith("sec-websocket-");

function method(value: unknown) {
  if (!shortString(value, 32) || !TOKEN.test(value)) return null;
  const upper = value.toUpperCase();
  if (upper === "CONNECT" || upper === "TRACE" || upper === "TRACK") return null;
  return ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"].includes(upper) ? upper : value;
}

function failure(url: URL, error: unknown) {
  if (error instanceof EgressError) return error.message;
  const code = record(error)?.code;
  return `${url.protocol === "ws:" || url.protocol === "wss:" ? "WebSocket" : "fetch"} to ${url.origin} failed: ${typeof code === "string" ? code : error instanceof Error ? error.name : "error"}`;
}

type Target = { address: string; port: number };
type FetchInit = { method: string; headers: Pairs; body: Uint8Array<ArrayBuffer> | null; redirect: RequestRedirect };
type FetchJob = { kind: "fetch"; abort: AbortController };
type SocketJob = { kind: "ws"; ws: WebSocket | null; ended: boolean; error?: string };
/** Which non-public targets get through and how names resolve: both only ever set by the host's tests. */
type Egress = { allowed: ReadonlySet<string>; lookup: (host: string) => Promise<{ address: string; family: number }[]> };

function egressRules(options: BrokerOptions): Egress {
  return {
    allowed: new Set(
      (options.allow ?? []).map((entry) => {
        const m = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(entry);
        const key = m && targetKey(m[1] ?? m[2]!, Number(m[3]));
        if (!key) throw new Error(`broker allow entry must be ip:port or [ipv6]:port, got ${JSON.stringify(entry)}`);
        return key;
      }),
    ),
    lookup: options.lookup ?? ((host: string) => lookup(host, { all: true })),
  };
}

/** Resolves the URL's host once and checks every address it has, then names the one to connect to. */
async function resolve(url: URL, schemes: ReadonlySet<string>, egress: Egress): Promise<Target> {
  if (!schemes.has(url.protocol)) throw new EgressError(`egress refused: ${url.protocol} URLs are not allowed`);
  if (url.username || url.password) throw new EgressError("egress refused: URLs with credentials are not allowed");
  const port = url.port ? Number(url.port) : url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80;
  if (BAD_PORTS.has(port)) throw new EgressError(`egress refused: port ${port} is not allowed`);
  const name = bareHost(url);
  let found: { address: string; family: number }[];
  if (isIP(name)) found = [{ address: name, family: isIP(name) }];
  else {
    try {
      found = await egress.lookup(name);
    } catch {
      throw new EgressError(`could not resolve ${name}`);
    }
  }
  if (!found.length) throw new EgressError(`could not resolve ${name}`);
  for (const { address } of found) {
    const key = targetKey(address, port);
    if (!publicAddress(address) && !(key && egress.allowed.has(key))) throw new EgressError(`egress refused: ${name} is not a public address`);
  }
  // Pinned to one address, so no happy eyeballs: IPv4 first, as many hosts have no IPv6 route.
  return { address: (found.find((a) => a.family === 4) ?? found[0]!).address, port };
}

/**
 * One HTTP(S) request out: each hop's name resolved once and checked, the connection made to the checked address with
 * the name's Host header and TLS identity, and redirects followed as `init.redirect` says, each checked the same way.
 * Answers the last hop's response with its body unread.
 */
async function pinnedFetch(first: URL, init: FetchInit, signal: AbortSignal | undefined, egress: Egress): Promise<{ res: Response; url: URL; redirected: boolean }> {
  let { method, headers, body } = init;
  let url = first;
  for (let hops = 0; ; hops++) {
    const to = await resolve(url, HTTP, egress);
    signal?.throwIfAborted();
    const pinned = new URL(url);
    pinned.hostname = isIP(to.address) === 6 ? `[${to.address}]` : to.address;
    const name = bareHost(url);
    if (PROXY_ENV.some((name) => process.env[name]))
      throw new EgressError("Fetch is unavailable while a network proxy is configured; destination addresses cannot be pinned safely.");
    const res = await nativeFetch(pinned, {
      method,
      headers: [...headers, ["host", url.host]],
      body,
      redirect: "manual",
      // A pooled connection is keyed by the address, and could carry this request over another name's TLS session.
      keepalive: false,
      signal,
      tls:
        url.protocol === "https:"
          ? { ...(isIP(name) ? {} : { serverName: name }), checkServerIdentity: (_host: string, cert: PeerCertificate) => checkServerIdentity(name, cert) }
          : undefined,
    });
    const location = REDIRECTS.has(res.status) && init.redirect !== "manual" ? res.headers.get("location") : null;
    if (location === null) return { res, url, redirected: hops > 0 };
    await res.body?.cancel();
    if (init.redirect === "error") throw new EgressError(`${url.origin} redirected, and redirect is "error"`);
    if (hops >= MAX_REDIRECTS) throw new EgressError(`too many redirects from ${first.origin}`);
    const next = parseUrl(location, url);
    if (!next) throw new EgressError(`${url.origin} redirected to an invalid location`);
    if (res.status === 303 ? method !== "HEAD" : (res.status === 301 || res.status === 302) && method === "POST") {
      method = "GET";
      body = null;
      headers = headers.filter(([k]) => !BODY_HEADERS.has(k));
    }
    if (next.origin !== url.origin) headers = headers.filter(([k]) => !CREDENTIALS.has(k));
    next.hash = "";
    url = next;
  }
}

/**
 * The host's own GET of a URL someone else picked, like a builder's add_asset: the same checks, pinning and redirects as
 * a mod's fetch, without the trip through IPC. Every refusal or failure is an EgressError worded for the builder; the
 * caller reads the body and caps its size. `options` is for the host's tests only.
 */
export async function publicGet(raw: string, options: BrokerOptions = {}): Promise<{ res: Response; url: URL }> {
  const url = parseUrl(raw);
  if (!url) throw new EgressError("egress refused: not a URL");
  url.hash = "";
  const egress = egressRules(options);
  try {
    const { res, url: last } = await pinnedFetch(url, { method: "GET", headers: [], body: null, redirect: "follow" }, undefined, egress);
    return { res, url: last };
  } catch (error) {
    throw new EgressError(failure(url, error));
  }
}

/** Starts the egress broker for one child. `send` delivers a reply to that child; it may throw once the child is gone. */
export function createBroker(send: (msg: NetReply) => void, options: BrokerOptions = {}): Broker {
  const egress = egressRules(options);
  const jobs = new Map<number, FetchJob | SocketJob>();
  /** The WebSocket endpoints and connections the broker opened, torn down when it closes. */
  const servers = new Set<Server>();
  const sockets = new Set<Socket>();
  let closed = false;

  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };

  const reply = (msg: NetReply) => {
    if (closed) return;
    try {
      send(msg);
    } catch {}
  };
  const fail = (id: number, message: string) => reply({ t: NET, op: "fail", id, message });
  const failSocket = (id: number, error: string) => reply({ t: NET, op: "closed", id, code: 1006, reason: "", clean: false, error });

  async function runFetch(id: number, signal: AbortSignal, first: URL, init: FetchInit) {
    const { res, url, redirected } = await pinnedFetch(first, init, signal, egress);
    reply({ t: NET, op: "head", id, status: res.status, statusText: res.statusText, headers: [...res.headers], url: url.href, redirected });
    let total = 0;
    if (res.body)
      for await (const chunk of res.body) {
        if ((total += chunk.byteLength) > MAX_BODY) throw new EgressError(`response from ${url.origin} is larger than ${MAX_BODY >> 20} MiB`);
        for (let at = 0; at < chunk.byteLength; at += CHUNK) reply({ t: NET, op: "body", id, data: Buffer.from(chunk.subarray(at, at + CHUNK)).toString("base64") });
      }
    reply({ t: NET, op: "end", id });
  }

  function startFetch(id: number, msg: Record<string, unknown>) {
    const url = parseUrl(msg.url);
    const verb = method(msg.method);
    const headers = headerList(msg.headers, hopHeader);
    const { redirect, body: encoded } = msg;
    if (!url || !verb || !headers || (encoded !== null && typeof encoded !== "string") || (redirect !== "follow" && redirect !== "manual" && redirect !== "error"))
      return fail(id, "fetch: invalid request");
    if (encoded !== null && !base64Fits(encoded, MAX_BODY)) return fail(id, `fetch: request body must be at most ${MAX_BODY >> 20} MiB`);
    if (encoded !== null && (verb === "GET" || verb === "HEAD")) return fail(id, `fetch: a ${verb} request has no body`);
    const body = encoded === null ? null : new Uint8Array(Buffer.from(encoded, "base64"));
    url.hash = "";
    const job: FetchJob = { kind: "fetch", abort: new AbortController() };
    jobs.set(id, job);
    runFetch(id, job.abort.signal, url, { method: verb, headers, body, redirect })
      .catch((error) => job.abort.signal.aborted || fail(id, failure(url, error)))
      .finally(() => jobs.get(id) === job && jobs.delete(id));
  }

  /**
   * A loopback endpoint for one WebSocket connection. Bun's WebSocket client can't pin an address itself: given the
   * checked IP as its URL, it skips checking the certificate's name. So the client speaks plain WebSocket to this
   * endpoint with the mod's Host header, and the endpoint connects to the checked address, adding TLS verified for the
   * URL's name for wss. It takes only the first connection, which can only ever reach that address, and no proxy
   * setting in the host's env applies to a loopback URL.
   */
  function forward(to: Target, tlsName: string | null, failed: (error: unknown) => void) {
    const { promise, resolve, reject } = Promise.withResolvers<{ server: Server; port: number }>();
    const server = createServer((client) => {
      server.close();
      track(client);
      const upstream =
        tlsName === null
          ? connect({ host: to.address, port: to.port })
          : tlsConnect({
              host: to.address,
              port: to.port,
              ...(isIP(tlsName) ? {} : { servername: tlsName }),
              checkServerIdentity: (_host: string, cert: PeerCertificate) => checkServerIdentity(tlsName, cert),
            });
      track(upstream);
      // A side that closes ends the other once what it sent is flushed; a failure cuts both at once.
      upstream.on("error", (error) => {
        failed(error);
        client.destroy();
      });
      client.on("error", () => upstream.destroy());
      upstream.on("close", () => client.end());
      client.on("close", () => upstream.end());
      // The upgrade request waits here until the upstream is connected and, for wss, its certificate checked, so a
      // server with the wrong name never sees it. (Bun stalls a paused socket that is piped later, so hold it by hand.)
      const early: Buffer[] = [];
      const hold = (chunk: Buffer) => early.push(chunk);
      client.on("data", hold);
      upstream.once(tlsName === null ? "connect" : "secureConnect", () => {
        client.off("data", hold);
        for (const chunk of early) upstream.write(chunk);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    });
    servers.add(server);
    server.on("close", () => servers.delete(server));
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve({ server, port: address.port });
      else reject(new Error("WebSocket endpoint has no port"));
    });
    return promise;
  }

  async function openSocket(id: number, job: SocketJob, url: URL, protocols: string[], headers: Pairs) {
    const to = await resolve(url, WS, egress);
    if (job.ended || closed) throw new EgressError("WebSocket closed before it opened");
    const local = await forward(to, url.protocol === "wss:" ? bareHost(url) : null, (error) => (job.error ??= failure(url, error)));
    const stop = () => local.server.listening && local.server.close();
    if (job.ended || closed) {
      stop();
      throw new EgressError("WebSocket closed before it opened");
    }
    const merged = new Map<string, string>([["host", url.host]]);
    for (const [name, value] of headers) merged.set(name, merged.has(name) ? `${merged.get(name)}, ${value}` : value);
    const ws = new NativeWebSocket(`ws://127.0.0.1:${local.port}${url.pathname}${url.search}`, {
      ...(protocols.length ? { protocols } : {}),
      headers: Object.fromEntries(merged),
    });
    job.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => reply({ t: NET, op: "open", id, protocol: ws.protocol, extensions: ws.extensions });
    ws.onmessage = ({ data }: MessageEvent) => {
      if (typeof data === "string") reply({ t: NET, op: "message", id, text: data });
      else if (data instanceof ArrayBuffer) reply({ t: NET, op: "message", id, data: Buffer.from(data).toString("base64") });
    };
    ws.onerror = () => {
      job.error ??= `WebSocket to ${url.origin} failed`;
    };
    ws.onclose = ({ code, reason, wasClean }: CloseEvent) => {
      stop();
      if (jobs.get(id) === job) jobs.delete(id);
      reply({ t: NET, op: "closed", id, code, reason, clean: wasClean && !job.error, ...(job.error ? { error: job.error } : {}) });
    };
  }

  function startSocket(id: number, msg: Record<string, unknown>) {
    const url = parseUrl(msg.url);
    const headers = headerList(msg.headers, socketHeader);
    const protocols = msg.protocols;
    const valid =
      Array.isArray(protocols) && protocols.length <= 32 && protocols.every((p) => shortString(p, 256) && TOKEN.test(p)) && new Set(protocols).size === protocols.length;
    if (!url || !headers || !valid) return failSocket(id, "WebSocket: invalid request");
    url.hash = "";
    const job: SocketJob = { kind: "ws", ws: null, ended: false };
    jobs.set(id, job);
    openSocket(id, job, url, protocols as string[], headers).catch((error) => {
      if (jobs.get(id) === job) jobs.delete(id);
      failSocket(id, failure(url, error));
    });
  }

  function handle(msg: Record<string, unknown>) {
    const id = msg.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return;
    const job = jobs.get(id);
    switch (msg.op) {
      case "fetch":
      case "ws":
        if (job) return; // the child reused a live id; the first request keeps it
        if (jobs.size >= MAX_OPEN) {
          const error = `too many open requests (at most ${MAX_OPEN})`;
          return msg.op === "fetch" ? fail(id, error) : failSocket(id, error);
        }
        return msg.op === "fetch" ? startFetch(id, msg) : startSocket(id, msg);
      case "abort":
        if (job?.kind !== "fetch") return;
        jobs.delete(id);
        return job.abort.abort();
      case "send": {
        if (job?.kind !== "ws" || job.ws?.readyState !== NativeWebSocket.OPEN) return;
        if (shortString(msg.text, MAX_MESSAGE) && msg.data === undefined) return job.ws.send(msg.text);
        if (base64Fits(msg.data, MAX_MESSAGE) && msg.text === undefined) return job.ws.send(Buffer.from(msg.data, "base64"));
        job.error = `WebSocket messages must be at most ${MAX_MESSAGE >> 20} MiB`;
        return job.ws.close();
      }
      case "close": {
        if (job?.kind !== "ws") return;
        job.ended = true;
        const code = msg.code === 1000 || (typeof msg.code === "number" && Number.isInteger(msg.code) && msg.code >= 3000 && msg.code <= 4999) ? msg.code : undefined;
        const reason = shortString(msg.reason, 123) && Buffer.byteLength(msg.reason) <= 123 ? msg.reason : undefined;
        return job.ws?.close(code, code === undefined ? undefined : reason);
      }
    }
  }

  return {
    receive(msg) {
      const fields = record(msg);
      if (fields?.t !== NET) return false;
      if (!closed)
        try {
          handle(fields);
        } catch {}
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const job of jobs.values()) {
        if (job.kind === "fetch") job.abort.abort();
        else {
          job.ended = true;
          job.ws?.close();
        }
      }
      jobs.clear();
      for (const server of servers) if (server.listening) server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}
