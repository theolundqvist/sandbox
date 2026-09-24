import { Database } from "bun:sqlite";

/** What the world's record holds: every Claude's tool calls, chat, players' sessions and actions, reloads, errors, and server, client and proxy performance. */
export type Kind = "tool" | "chat" | "claude" | "session" | "action" | "reload" | "error" | "server" | "client" | "proxy" | "exit";
export type Row = { at: number; kind: Kind; who: string | null; data: any };
export type Filter = { since?: number; until?: number; who?: string; kind?: string; limit?: number };

const DAYS = 14;

/** Rows are buffered and written once a second, so recording costs a tool call or tick an array push. */
export function openRecord(path: string) {
  const db = new Database(path, { create: true });
  db.run("pragma journal_mode = wal");
  db.run("pragma synchronous = normal");
  db.run("pragma busy_timeout = 2000");
  db.run("create table if not exists events (at integer not null, kind text not null, who text, data text not null)");
  db.run("create index if not exists events_kind on events (kind, at)");
  db.run("create index if not exists events_at on events (at)");
  const insert = db.prepare("insert into events values (?, ?, ?, ?)");
  let pending: [number, string, string | null, string][] = [];
  const flush = () => {
    if (!pending.length) return;
    const rows = pending;
    pending = [];
    db.transaction(() => {
      for (const row of rows) insert.run(...row);
    })();
  };
  const prune = () => db.run("delete from events where at < ?", [Date.now() - DAYS * 86_400_000]);
  prune();
  const timers = [setInterval(flush, 1000), setInterval(prune, 3_600_000)];

  function rows({ since = Date.now() - 3_600_000, until = Date.now(), who, kind, limit = 10_000 }: Filter): Row[] {
    const where = ["at >= ?", "at <= ?"];
    const params: (string | number)[] = [since, until];
    if (kind) where.push(`kind in (${kind.split(",").map(() => "?").join(",")})`), params.push(...kind.split(","));
    if (who) where.push("who = ?"), params.push(who);
    flush();
    const found = db.query(`select at, kind, who, data from events where ${where.join(" and ")} order by at desc limit ?`).all(...params, limit) as any[];
    return found.reverse().map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  return {
    add(kind: Kind, who: string | null, data: object) {
      pending.push([Date.now(), kind, who, JSON.stringify(data)]);
    },
    rows,
    /** The last minutes of the record as rows, or by default as a digest of them. */
    activity({ minutes = 60, who, kind, limit = 200, summary = true }: { minutes?: number; who?: string; kind?: string; limit?: number; summary?: boolean }) {
      const filter = { since: Date.now() - minutes * 60_000, who, kind };
      return summary ? summarize(rows({ ...filter, limit: 1_000_000 })) : rows({ ...filter, limit });
    },
    close() {
      for (const t of timers) clearInterval(t);
      flush();
      db.close();
    },
  };
}

export type Recorder = ReturnType<typeof openRecord>;

const pct = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};
const spread = (xs: number[]) => (xs.length ? { n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: pct(xs, 1) } : undefined);
const time = (at: number) => new Date(at).toISOString().slice(11, 19);
const count = <T>(items: T[], key: (item: T) => string) => {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
};

/** The questions a session review asks first: what was slow, what failed, and how often. */
function summarize(all: Row[]) {
  const of = (kind: Kind) => all.filter((r) => r.kind === kind);
  const tools = of("tool");
  const reloads = of("reload");
  const byTool = Object.fromEntries(Object.entries(count(tools, (r) => r.data.tool)).map(([tool]) => {
    const calls = tools.filter((r) => r.data.tool === tool);
    return [tool, { ...spread(calls.map((r) => r.data.ms)), errors: calls.filter((r) => r.data.error).length }];
  }));
  const server = of("server");
  const clients = of("client");
  const http = server.flatMap((r) => Object.entries(r.data.http as Record<string, { n: number; p95: number; max: number }>).map(([path, s]) => ({ at: r.at, path, ...s })));
  const proxy = of("proxy").flatMap((r) => Object.entries(r.data as Record<string, { n: number; p95: number; max: number }>).map(([path, s]) => ({ at: r.at, path, ...s })));
  return {
    from: all[0] && new Date(all[0].at).toISOString(),
    to: all.at(-1) && new Date(all.at(-1)!.at).toISOString(),
    rows: count(all, (r) => r.kind),
    tools: byTool,
    slowestTools: [...tools].sort((a, b) => b.data.ms - a.data.ms).filter((r) => r.data.tool !== "wait_for_chat").slice(0, 10).map((r) => `${time(r.at)} ${r.who} ${r.data.tool} ${r.data.ms} ms ${JSON.stringify(r.data.args)}${r.data.error ? ` error: ${r.data.error}` : ""}`),
    toolErrors: count(tools.filter((r) => r.data.error), (r) => `${r.data.tool}: ${String(r.data.error).slice(0, 80)}`),
    reloads: {
      ok: reloads.filter((r) => r.data.ok).length,
      rejected: count(reloads.filter((r) => !r.data.ok), (r) => r.data.stage),
      ms: spread(reloads.filter((r) => r.data.ok).map((r) => r.data.ms.total)),
      typecheckMs: spread(reloads.filter((r) => r.data.ms.typecheck !== undefined).map((r) => r.data.ms.typecheck)),
      reverts: of("error").filter((r) => r.data.revert).map((r) => `${time(r.at)} ${r.data.mod}: ${r.data.text.slice(0, 120)}`),
    },
    errors: count(of("error"), (r) => `${r.data.mod}${r.who ? ` (${r.who}'s game)` : ""}`),
    server: server.length && {
      tickMs: spread(server.map((r) => r.data.tick.p95)),
      worstTick: server.reduce((w, r) => (r.data.tick.max > w.max ? { at: time(r.at), max: r.data.tick.max } : w), { at: "", max: 0 }),
      mainLagMs: spread(server.map((r) => r.data.lagMs)),
      rssMB: Math.max(...server.map((r) => r.data.rssMB)),
      entities: Math.max(...server.map((r) => r.data.entities)),
      sentKBps: Math.max(...server.map((r) => Object.values(r.data.ws as Record<string, { outKB: number }>).reduce((a, c) => a + c.outKB, 0) / 10)),
    },
    clients: Object.fromEntries(Object.entries(count(clients, (r) => r.who!)).map(([who]) => {
      const mine = clients.filter((r) => r.who === who && !r.data.hidden);
      return [who, { fps: spread(mine.map((r) => r.data.fps)), p95FrameMs: spread(mine.map((r) => r.data.p95FrameMs)), worstFrameMs: Math.max(0, ...mine.map((r) => r.data.slowestFrameMs)) }];
    })),
    loads: of("session").filter((r) => r.data.loaded).map((r) => `${time(r.at)} ${r.who} first frame ${r.data.firstFrameMs} ms, mods ${r.data.modsMs} ms`),
    slowestHttp: http.sort((a, b) => b.max - a.max).slice(0, 8).map((h) => `${time(h.at)} ${h.path} max ${h.max} ms (${h.n} requests)`),
    slowestProxy: proxy.sort((a, b) => b.max - a.max).slice(0, 8).map((h) => `${time(h.at)} ${h.path} max ${h.max} ms (${h.n} requests)`),
    exits: of("exit").map((r) => `${time(r.at)} ${JSON.stringify(r.data)}`),
  };
}

/** Tool arguments with long text cut to a preview, so the record stays small. */
export function brief(args: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" && v.length > 120 ? `${v.slice(0, 80)}… (${v.length} chars)` : v]));
}

/** Request counts and latency spread per path over one window. */
export function latencies() {
  let window = new Map<string, number[]>();
  return {
    add(path: string, ms: number) {
      const list = window.get(path) ?? [];
      list.push(ms);
      window.set(path, list);
    },
    take() {
      const out = Object.fromEntries([...window].map(([path, ms]) => [path, { n: ms.length, p50: Math.round(pct(ms, 0.5)), p95: Math.round(pct(ms, 0.95)), max: Math.round(pct(ms, 1)) }]));
      window = new Map();
      return out;
    },
  };
}

/** The route a request took, without ids, keys or file names; CLI routes keep the tool name. */
export const route = (path: string) => path.replace(/^\/r\/[^/]+/, "").replace(/^\/(build|assets|vendor)\/.*/, "/$1");
