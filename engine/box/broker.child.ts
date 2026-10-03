// A stand-in for a mod's process in broker.test.ts. Like the simulation it installs the brokered network, so its global
// fetch and WebSocket reach out only through the test's broker, over real IPC.
import { installNetwork, type SocketOptions } from "./network";

export type Command =
  | { t: "fetch"; id: number; url: string; init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: RequestRedirect } }
  | { t: "abort"; id: number; url: string }
  | { t: "ws"; id: number; url: string; protocols?: string[]; headers?: Record<string, string>; messages: (string | number[])[] };

const network = installNetwork((msg) => process.send!(msg));
// lib DOM hides the options overload; the global is now the brokered WebSocket, which takes Bun's options.
const BrokeredWebSocket = WebSocket as unknown as new (url: string, options: SocketOptions) => WebSocket;

async function run(cmd: Command): Promise<unknown> {
  switch (cmd.t) {
    case "fetch": {
      const res = await fetch(cmd.url, cmd.init);
      return { status: res.status, url: res.url, redirected: res.redirected, headers: Object.fromEntries(res.headers), body: await res.text() };
    }
    case "abort": {
      const controller = new AbortController();
      const reader = (await fetch(cmd.url, { signal: controller.signal })).body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      controller.abort();
      return { first, after: await reader.read().then(() => "read", (error: Error) => error.name) };
    }
    case "ws": {
      const events: unknown[] = [];
      const { promise, resolve } = Promise.withResolvers<unknown[]>();
      const ws = new BrokeredWebSocket(cmd.url, { protocols: cmd.protocols ?? [], headers: cmd.headers ?? {} });
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        events.push(["open", ws.protocol]);
        for (const m of cmd.messages) ws.send(typeof m === "string" ? m : new Uint8Array(m));
      };
      ws.onmessage = ({ data }) => events.push(["message", typeof data === "string" ? data : [...new Uint8Array(data)]]);
      ws.onerror = (event) => events.push(["error", event instanceof ErrorEvent ? event.message : ""]);
      ws.onclose = ({ code, reason, wasClean }) => {
        events.push(["close", code, reason, wasClean]);
        resolve(events);
      };
      return promise;
    }
  }
}

process.on("message", (msg: Command) => {
  if (network.receive(msg)) return;
  run(msg).then(
    (value) => process.send!({ t: "done", id: msg.id, value }),
    (error: Error) => process.send!({ t: "done", id: msg.id, error: `${error.name}: ${error.message}` }),
  );
});
process.on("disconnect", () => process.exit());
process.send!({ t: "ready" });
