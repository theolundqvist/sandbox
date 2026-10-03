// Playtests: an agent plays a hidden copy of the world, so the players' own game never stutters, moves or changes because of it.
import { closeSync, cpSync, existsSync, mkdtempSync, openSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Subprocess } from "bun";

export class PlaytestError extends Error {}

const PAUSED = "paused: your player's game needs the computer. The playtest copy waits until their game runs smoothly again; try again in a little while.";
const MOD = /^[a-z][a-z0-9-]{0,31}$/;
/** Everything a playtest runs gets the computer only when nothing else wants it. */
const IDLE: string[] =
  process.platform === "linux"
    ? [...(Bun.which("nice") ? ["nice", "-n", "19"] : []), ...(Bun.which("chrt") ? ["chrt", "--idle", "0"] : [])]
    : process.platform === "darwin"
      ? ["nice", "-n", "19", "taskpolicy", "-b"]
      : [];

type Run = {
  who: string;
  dir: string;
  key: string;
  fork: Subprocess;
  client: Subprocess<"pipe", "pipe", any>;
  base: string;
  ready: Promise<void>;
  replies: Map<number, (msg: any) => void>;
  seq: number;
  log: number;
};

/** The live world's side of playtests: one copy at a time, started by the agent that asks first and shared by the rest. */
export function playtests(data: string, root: string) {
  /** How the desktop app that hosts this world starts its hidden playtest client; absent under a plain launcher. */
  const app: string[] | null = process.env.SANDBOX_PLAYTEST_APP ? JSON.parse(process.env.SANDBOX_PLAYTEST_APP) : null;
  const prefix = `sandbox-playtest-${basename(data)}-`;
  let run: Run | null = null;
  let ended: string | null = null;
  let paused = false;
  /** Each live player's fps before the playtest started, and how many reports in a row since were under or back over it. */
  const baseline = new Map<string, number>();
  const lastFps = new Map<string, number>();
  const slow = new Map<string, number>();
  let fine = 0;

  const signal = (sig: NodeJS.Signals) => {
    for (const proc of run ? [run.fork, run.client] : [])
      try {
        process.kill(-proc.pid, sig);
      } catch {}
  };

  function end(why: string | null) {
    const current = run;
    if (!current) return;
    signal("SIGKILL");
    run = null;
    ended = why;
    paused = false;
    baseline.clear();
    slow.clear();
    for (const reply of current.replies.values()) reply({ error: why ?? "The playtest stopped." });
    closeSync(current.log);
    rmSync(current.dir, { recursive: true, force: true, maxRetries: 5 });
  }

  /** A tool call in the copy, as the playtest's player. */
  async function tool(name: string, args: Record<string, unknown> = {}) {
    const form = new FormData();
    for (const [k, v] of Object.entries(args)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
    const res = await fetch(`${run!.base}/cli/${name}`, { method: "POST", headers: { authorization: `Bearer ${run!.key}` }, body: form });
    return { ok: res.ok, text: await res.text() };
  }

  /** Sends the hidden client a command and waits for its answer. */
  function client(msg: object, ms: number): Promise<any> {
    const current = run!;
    const id = ++current.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (current.replies.delete(id), reject(new PlaytestError("The playtest's game didn't answer in time; the computer is busy. Try again in a little while."))), ms);
      current.replies.set(id, (reply) => {
        clearTimeout(timer);
        current.replies.delete(id);
        if (reply.error) reject(new PlaytestError(reply.error));
        else resolve(reply);
      });
      current.client.stdin.write(`${JSON.stringify({ ...msg, id })}\n`);
      current.client.stdin.flush();
    });
  }

  function launch(who: string) {
    for (const old of readdirSync(tmpdir())) if (old.startsWith(prefix)) rmSync(join(tmpdir(), old), { recursive: true, force: true });
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const key = crypto.randomUUID().replaceAll("-", "");
    const log = openSync(join(data, "playtest.log"), "w");
    // Nothing of the live world's own: no paid keys, no notice or revert meant for it, no way to start another playtest.
    const { SANDBOX_SECRETS, SANDBOX_NOTICE, SANDBOX_REVERT, SANDBOX_PLAYTEST_APP, ...env } = process.env;
    let reportPort!: (port: number) => void;
    const port = new Promise<number>((resolve) => (reportPort = resolve));
    const fork = Bun.spawn([...IDLE, process.execPath, join(import.meta.dir, "playtest-fork.ts")], {
      env: { ...env, SANDBOX_DATA: dir, SANDBOX_PLAYTEST_FROM: data, SANDBOX_PLAYTEST_PLAYER: who, SANDBOX_PLAYTEST_KEY: key, PORT: "0" },
      detached: true,
      stdout: log,
      stderr: log,
      ipc: (msg) => msg?.port && reportPort(msg.port),
    });
    const current: Run = { who, dir, key, fork, client: null!, base: "", ready: null!, replies: new Map(), seq: 0, log };
    run = current;
    void fork.exited.then(() => run === current && end("The playtest copy stopped by itself. Start it again with playtest."));
    current.ready = (async () => {
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new PlaytestError("The playtest copy didn't start within 2 minutes; the computer is busy. Try again in a little while.")), 120_000));
      current.base = `http://127.0.0.1:${await Promise.race([port, timeout])}`;
      if (run !== current) throw new PlaytestError(ended ?? "The playtest stopped.");
      current.client = Bun.spawn([...IDLE, ...app!], {
        env: { ...env, SANDBOX_PLAYTEST: `${current.base}/#key=${key}`, SANDBOX_PLAYTEST_DATA: join(dir, "client") },
        detached: true,
        stdin: "pipe",
        stdout: "pipe",
        stderr: log,
      });
      void current.client.exited.then(() => run === current && end("The playtest's game closed by itself. Start it again with playtest."));
      void (async () => {
        let buffered = "";
        for await (const chunk of current.client.stdout.pipeThrough(new TextDecoderStream())) {
          const lines = (buffered + chunk).split("\n");
          buffered = lines.pop()!;
          for (const line of lines) {
            try {
              const msg = JSON.parse(line);
              current.replies.get(msg.id)?.(msg);
            } catch {}
          }
        }
      })();
      // In once the game has drawn its first frame there.
      const joined = async () => JSON.parse((await tool("perf")).text.split("\n\n")[0]!).joins?.[who];
      while (!(await joined().catch(() => null))) {
        if (run !== current) throw new PlaytestError(ended ?? "The playtest stopped.");
        await Promise.race([Bun.sleep(500), timeout]);
      }
      // Space closes the how-to card the game opens with and takes mouse-look.
      await client({ t: "input", keys: ["Space"], ms: 50 }, 30_000);
    })();
    current.ready.catch(() => run === current && end(null));
  }

  /** The playtest's player's feet in the copy. */
  async function where() {
    const found = JSON.parse((await tool("query_world", { components: ["player", "pos"] })).text.split("\n(")[0]!);
    const body = Object.values<any>(found).find((e) => e.player === run!.who);
    return body ? `(${body.pos.map((v: number) => v.toFixed(1)).join(", ")})` : null;
  }

  function running() {
    if (paused) throw new PlaytestError(PAUSED);
    if (!run) throw new PlaytestError(ended ?? "No playtest is running. Start one with playtest.");
    return run;
  }

  return {
    get running() {
      return !!run;
    },

    async start(who: string, mod?: string) {
      if (process.platform === "win32") throw new PlaytestError("Playtests need the host's Sandbox desktop app on a Mac or Linux for now. Check with query_world, logs and your player's screenshot instead.");
      if (!app) throw new PlaytestError("Playtests run in a hidden copy of the game on the host's computer, which needs the Sandbox desktop app; this world runs from a plain launcher. Check with query_world, logs and your player's screenshot instead.");
      if (mod !== undefined && !MOD.test(mod)) throw new PlaytestError("mod is a mod's folder name under mods/.");
      if (paused) throw new PlaytestError(PAUSED);
      const fresh = !run;
      if (fresh) {
        ended = null;
        for (const [player, fps] of lastFps) baseline.set(player, fps);
        launch(who);
      }
      const current = run!;
      await current.ready;
      const lines = [fresh ? `Started a playtest: a hidden copy of the world as it is now, with you in it as ${current.who}. Nothing you do there reaches the live world or anyone's game.` : `The playtest is running, with you in it as ${current.who}.`];
      if (mod) {
        // The copy runs the mod's files as they are now, reloaded or not.
        const to = join(current.dir, "world", "mods", mod);
        rmSync(to, { recursive: true, force: true });
        if (existsSync(join(root, "mods", mod))) cpSync(join(root, "mods", mod), to, { recursive: true });
        const reload = await tool("reload", { mod });
        lines.push(reload.ok ? `${mod} reloaded in the copy from its current files.` : `${mod} didn't reload in the copy:\n${reload.text.split("\n\nWhen you are done")[0]}`);
      }
      lines.push("Use play to move and look, then screenshot to see it; playtest action=stop ends it.");
      return lines.join("\n");
    },

    async play(args: { keys?: string; ms?: number; look?: string; click?: string }) {
      const current = running();
      await current.ready;
      const keys = String(args.keys ?? "").split(",").map((k) => k.trim()).filter(Boolean);
      if (keys.length > 8) throw new PlaytestError("Hold at most 8 keys at once.");
      const look = args.look === undefined ? undefined : String(args.look).split(",").map(Number);
      if (look && (look.length !== 2 || !look.every((v) => Number.isFinite(v) && Math.abs(v) <= 2000))) throw new PlaytestError("look is dx,dy in pixels of mouse movement, each at most 2000, like look=300,0.");
      if (args.click !== undefined && args.click !== "left" && args.click !== "right") throw new PlaytestError("click is left or right.");
      const ms = Math.max(0, Math.min(10_000, Number.isFinite(Number(args.ms)) ? Number(args.ms) : 500));
      const from = await where();
      await client({ t: "input", keys, ms, look, click: args.click }, ms + 30_000);
      const to = await where();
      const did = [keys.length && `held ${keys.join(" + ")} for ${ms} ms`, look && `moved the mouse ${look[0]}, ${look[1]}`, args.click && `${args.click}-clicked`].filter(Boolean).join(", ") || `waited ${ms} ms`;
      return `In the playtest you ${did}. ${from && to ? (from === to ? `You stayed at ${to}.` : `You moved from ${from} to ${to}.`) : "You have no body in the copy."} screenshot shows it.`;
    },

    async screenshot() {
      const current = running();
      await current.ready;
      return (await client({ t: "shot" }, 30_000)).data as string;
    },

    stop() {
      if (!run) return "No playtest is running.";
      end(null);
      ended = null;
      return "The playtest stopped and its copy of the world is gone.";
    },

    /** A live player's fps report: two in a row over 10% under their fps before the playtest pause it, two back over it resume it. */
    frame(player: string, report: { fps?: number; hidden?: boolean }) {
      if (report.hidden || !Number.isFinite(report.fps)) return;
      const fps = report.fps!;
      lastFps.set(player, fps);
      if (!run) return;
      if (!baseline.has(player)) baseline.set(player, fps);
      const under = fps < baseline.get(player)! * 0.9;
      slow.set(player, under ? (slow.get(player) ?? 0) + 1 : 0);
      if (under) fine = 0;
      if (!paused && under && slow.get(player)! >= 2) {
        paused = true;
        signal("SIGSTOP");
      } else if (paused && ![...slow.values()].some(Boolean) && ++fine >= 2) {
        paused = false;
        signal("SIGCONT");
      }
    },
  };
}
