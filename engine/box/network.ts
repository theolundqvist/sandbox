import type { NetReply, NetRequest } from "./broker";

/**
 * The child half of the egress broker. A boxed process has no sockets, so its global fetch and WebSocket hand every
 * request to the host over IPC, where the broker decides what may go out. data: and blob: URLs never leave the process.
 */

const NET = "box-net" satisfies NetRequest["t"];
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Bun's WebSocket options a mod may pass: subprotocols and extra handshake headers. */
export type SocketOptions = { protocols?: string | string[]; protocol?: string; headers?: HeadersInit };
type Handler<E extends Event> = ((ev: E) => unknown) | null;
type FetchCall = {
  kind: "fetch";
  head: boolean;
  resolve(response: Response): void;
  reject(error: unknown): void;
  stream: ReadableStreamDefaultController<Uint8Array> | null;
  settle(): void;
};
type SocketCall = { kind: "ws"; deliver(msg: NetReply): void };

/** Replaces this process's global fetch and WebSocket with ones that go through the host's broker; `receive` takes the broker's replies and says whether a message was one. */
export function installNetwork(send: (msg: NetRequest) => void): { receive(msg: unknown): boolean } {
  const calls = new Map<number, FetchCall | SocketCall>();
  let last = 0;
  const local = globalThis.fetch;

  async function brokerFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const { protocol } = new URL(request.url);
    if (protocol === "data:" || protocol === "blob:") return local(request);
    if (protocol !== "http:" && protocol !== "https:") throw new TypeError(`fetch: ${protocol} URLs are not available to mods`);
    const { signal } = request;
    signal.throwIfAborted();
    const body = request.body ? Buffer.from(await request.arrayBuffer()).toString("base64") : null;
    signal.throwIfAborted();
    const id = ++last;
    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    const onAbort = () => {
      if (!calls.delete(id)) return;
      send({ t: NET, op: "abort", id });
      if (call.stream) call.stream.error(signal.reason);
      else reject(signal.reason);
    };
    const call: FetchCall = { kind: "fetch", head: request.method === "HEAD", resolve, reject, stream: null, settle: () => signal.removeEventListener("abort", onAbort) };
    signal.addEventListener("abort", onAbort, { once: true });
    calls.set(id, call);
    send({ t: NET, op: "fetch", id, url: request.url, method: request.method, headers: [...request.headers], body, redirect: request.redirect });
    return promise;
  }

  function onFetch(id: number, call: FetchCall, msg: NetReply) {
    switch (msg.op) {
      case "head": {
        const body =
          call.head || NULL_BODY.has(msg.status)
            ? null
            : new ReadableStream<Uint8Array>({
                start: (controller) => {
                  call.stream = controller;
                },
                cancel: () => {
                  if (!calls.delete(id)) return;
                  call.settle();
                  send({ t: NET, op: "abort", id });
                },
              });
        const response = new Response(body, { status: msg.status, statusText: msg.statusText, headers: msg.headers });
        Object.defineProperties(response, { url: { value: msg.url }, redirected: { value: msg.redirected } });
        return call.resolve(response);
      }
      case "body":
        return call.stream?.enqueue(new Uint8Array(Buffer.from(msg.data, "base64")));
      case "end":
        calls.delete(id);
        call.settle();
        return call.stream?.close();
      case "fail": {
        calls.delete(id);
        call.settle();
        const error = new TypeError(msg.message);
        return call.stream ? call.stream.error(error) : call.reject(error);
      }
    }
  }

  class BoxWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readonly url: string;
    readyState = 0;
    protocol = "";
    extensions = "";
    /** Bun's default, so mods see the Buffers they would get from Bun's own WebSocket. */
    binaryType: "nodebuffer" | "arraybuffer" | "blob" = "nodebuffer";
    readonly #id: number;
    /** Set while a Blob is being read, so that later messages wait for it and keep their order. */
    #queue: Promise<void> | null = null;
    #queued = 0;
    #handlers = new Map<string, { handler: unknown; listener: (event: Event) => void }>();

    constructor(address: string | URL, options?: string | string[] | SocketOptions) {
      super();
      let url: URL;
      try {
        url = new URL(address);
      } catch {
        throw new DOMException(`WebSocket: invalid URL ${String(address)}`, "SyntaxError");
      }
      if (url.protocol === "http:") url.protocol = "ws:";
      else if (url.protocol === "https:") url.protocol = "wss:";
      if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new DOMException(`WebSocket: ${url.protocol} is not a WebSocket URL`, "SyntaxError");
      if (url.hash) throw new DOMException("WebSocket: URLs cannot have a fragment", "SyntaxError");
      const opts: SocketOptions = typeof options === "string" || Array.isArray(options) ? { protocols: options } : (options ?? {});
      const wanted = opts.protocols ?? opts.protocol ?? [];
      const protocols = typeof wanted === "string" ? [wanted] : [...wanted];
      if (protocols.some((p) => !TOKEN.test(p)) || new Set(protocols).size !== protocols.length) throw new DOMException("WebSocket: invalid subprotocols", "SyntaxError");
      this.url = url.href;
      this.#id = ++last;
      calls.set(this.#id, { kind: "ws", deliver: (msg) => this.#deliver(msg) });
      send({ t: NET, op: "ws", id: this.#id, url: url.href, protocols, headers: [...new Headers(opts.headers)] });
    }

    get onopen() {
      return this.#handler("open") as Handler<Event>;
    }
    set onopen(handler: Handler<Event>) {
      this.#setHandler("open", handler);
    }
    get onmessage() {
      return this.#handler("message") as Handler<MessageEvent>;
    }
    set onmessage(handler: Handler<MessageEvent>) {
      this.#setHandler("message", handler);
    }
    get onerror() {
      return this.#handler("error") as Handler<Event>;
    }
    set onerror(handler: Handler<Event>) {
      this.#setHandler("error", handler);
    }
    get onclose() {
      return this.#handler("close") as Handler<CloseEvent>;
    }
    set onclose(handler: Handler<CloseEvent>) {
      this.#setHandler("close", handler);
    }

    /**
     * Bytes sent but still waiting in this process behind a Blob being read. Data handed to the host is out of sight:
     * the broker's IPC and socket buffers don't show here, so a mod can't use this to pace a fast sender.
     */
    get bufferedAmount() {
      return this.#queued;
    }

    send(data: string | ArrayBufferLike | ArrayBufferView | Blob) {
      if (this.readyState === BoxWebSocket.CONNECTING) throw new DOMException("WebSocket is not open yet", "InvalidStateError");
      if (!(data instanceof Blob) && !this.#queue) return this.#send(data);
      const size =
        data instanceof Blob
          ? data.size
          : typeof data === "string"
            ? Buffer.byteLength(data)
            : ArrayBuffer.isView(data) || data instanceof ArrayBuffer || data instanceof SharedArrayBuffer
              ? data.byteLength
              : Buffer.byteLength(String(data));
      this.#queued += size;
      const next = (this.#queue ?? Promise.resolve())
        .then(async () => this.#send(data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data))
        .catch(() => {})
        .then(() => {
          this.#queued -= size;
          if (this.#queue === next) this.#queue = null;
        });
      this.#queue = next;
    }

    close(code?: number, reason?: string) {
      if (code !== undefined && code !== 1000 && !(Number.isInteger(code) && code >= 3000 && code <= 4999))
        throw new DOMException("WebSocket: close code must be 1000 or 3000-4999", "InvalidAccessError");
      if (reason !== undefined && Buffer.byteLength(reason) > 123) throw new DOMException("WebSocket: close reason must be at most 123 bytes", "SyntaxError");
      if (this.readyState >= BoxWebSocket.CLOSING) return;
      this.readyState = BoxWebSocket.CLOSING;
      send({ t: NET, op: "close", id: this.#id, ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) });
    }

    #send(data: string | ArrayBufferLike | ArrayBufferView) {
      if (this.readyState !== BoxWebSocket.OPEN) return;
      const bytes = ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : data instanceof ArrayBuffer || data instanceof SharedArrayBuffer
          ? Buffer.from(data)
          : null;
      send(bytes ? { t: NET, op: "send", id: this.#id, data: bytes.toString("base64") } : { t: NET, op: "send", id: this.#id, text: String(data) });
    }

    #deliver(msg: NetReply) {
      switch (msg.op) {
        case "open":
          this.readyState = BoxWebSocket.OPEN;
          this.protocol = msg.protocol;
          this.extensions = msg.extensions;
          return void this.dispatchEvent(new Event("open"));
        case "message": {
          let data: string | ArrayBuffer | Blob | Buffer = msg.text ?? "";
          if (msg.text === undefined) {
            const bytes = Buffer.from(msg.data ?? "", "base64");
            data = this.binaryType === "arraybuffer" ? new Uint8Array(bytes).buffer : this.binaryType === "blob" ? new Blob([bytes]) : bytes;
          }
          return void this.dispatchEvent(new MessageEvent("message", { data, origin: new URL(this.url).origin }));
        }
        case "closed":
          calls.delete(this.#id);
          this.readyState = BoxWebSocket.CLOSED;
          if (msg.error !== undefined) this.dispatchEvent(new ErrorEvent("error", { message: msg.error }));
          return void this.dispatchEvent(new CloseEvent("close", { code: msg.code, reason: msg.reason, wasClean: msg.clean }));
      }
    }

    #handler(type: string) {
      return this.#handlers.get(type)?.handler ?? null;
    }

    #setHandler(type: string, handler: unknown) {
      const old = this.#handlers.get(type);
      if (old) this.removeEventListener(type, old.listener);
      this.#handlers.delete(type);
      if (typeof handler !== "function") return;
      const listener = (event: Event) => void handler.call(this, event);
      this.#handlers.set(type, { handler, listener });
      this.addEventListener(type, listener);
    }
  }

  // preconnect is only a hint; the broker opens a connection per request.
  Object.defineProperty(globalThis, "fetch", { value: Object.assign(brokerFetch, { preconnect() {} }), writable: true, configurable: true });
  Object.defineProperty(globalThis, "WebSocket", { value: BoxWebSocket, writable: true, configurable: true });

  return {
    receive(msg) {
      if (msg === null || typeof msg !== "object" || !("t" in msg) || msg.t !== NET) return false;
      // The host's broker is trusted: its replies need no checking beyond the tag.
      const reply = msg as NetReply;
      const call = calls.get(reply.id);
      try {
        if (call?.kind === "fetch") onFetch(reply.id, call, reply);
        else call?.deliver(reply);
      } catch {}
      return true;
    },
  };
}
