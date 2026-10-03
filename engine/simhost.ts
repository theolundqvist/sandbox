import { closeSync, cpSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Entity, Player } from "./api";
import { box, boxRefusal } from "./box";
import { createBroker } from "./box/broker";
import type { Diff, Tick } from "./world";

/** `game` is the game the mod belongs to, or null for a mod every game shares. */
export type RunningMod = { name: string; id: number; server: string | null; game: string | null; trusted?: true };
/** The server put a player somewhere other than where their own game or another mod had just moved them. */
export type Correction = { at: number; mod: string; hook: string; player: string; entity: number; overruled: string; from: number[]; to: number[]; wanted: number[] | null; repeats: number };
/** engine is the p50 of each tick's time outside mod hooks. */
export type Perf = { msPerTick: number; p50: number; p95: number; max: number; engine: number; mods: Record<string, number>; modTicks: Record<string, { p95: number; max: number }> };

const HANG_MS = 2000;
/** Starting a trial loads every server mod, which takes seconds on a busy machine; only its ticks count as hanging. */
const TRIAL_START_MS = 15_000;
/** A game whose process keeps dying at start waits this long before the next try, so it can't spin. */
const CRASH_BACKOFF_MS = 1000;
const simDir = mkdtempSync(join(tmpdir(), "sandbox-sim-"));
const bundled = await Bun.build({ entrypoints: [join(import.meta.dir, "sim.ts")], outdir: simDir, target: "bun" });
if (!bundled.success) throw new AggregateError(bundled.logs, "Could not build the simulation.");
const SIM = bundled.outputs[0]!.path;
// The heartbeat thread a simulation starts on Windows (shareBeat in sim.ts) loads from beside the bundle.
cpSync(join(import.meta.dir, "beat.ts"), join(simDir, "beat.ts"));
process.on("exit", () => rmSync(simDir, { recursive: true, force: true }));

/** Every simulation has the same isolated child-process lifetime. */
type Channel = { send(msg: object): void; retire(now?: boolean): Promise<void>; pid: number | null };

function spawnSimulation(dbDir: string, mods: RunningMod[], scratch: string, trial: boolean, ipc: (msg: unknown) => void) {
  mkdirSync(join(dirname(dbDir), "build"), { recursive: true });
  const reason = boxRefusal();
  if (reason) {
    if (mods.some((mod) => mod.server !== null && !mod.trusted)) throw new Error(reason);
    return Bun.spawn([process.execPath, "--no-env-file", SIM], {
      cwd: scratch,
      env: { HOME: scratch, TMPDIR: scratch, PATH: dirname(process.execPath), ...(process.env.SYSTEMROOT && { SYSTEMROOT: process.env.SYSTEMROOT }) },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", ipc,
    });
  }
  return box({
    cmd: [process.execPath, SIM], scratch,
    read: [simDir, join(dirname(dbDir), "build"), ...[join(dirname(dbDir), "world", "node_modules")].filter(existsSync), ...(trial ? [dbDir] : [])],
    write: trial ? [] : [dbDir],
    ipc,
  });
}

async function drain(stream: ReadableStream<Uint8Array>, log?: (text: string) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    if (log) log(decoder.decode(value, { stream: true }).slice(0, 4096));
  }
}

function processChannel(dbDir: string, mods: RunningMod[], scratch: string, receive: (msg: object) => void, exited: (code: number | string) => void, log: (text: string) => void): Channel {
  let retiring = false;
  const broker = createBroker((msg) => proc.send(msg));
  const proc = spawnSimulation(dbDir, mods, scratch, false, (msg) => {
    if (broker.receive(msg)) return;
    if (msg && typeof msg === "object") {
      if ("t" in msg && msg.t === "closed") proc.kill("SIGKILL");
      else receive(msg);
    }
  });
  void drain(proc.stderr as ReadableStream<Uint8Array>, log);
  void drain(proc.stdout as ReadableStream<Uint8Array>, log);
  proc.exited.then((code) => {
    broker.close();
    if (!retiring) exited(proc.signalCode ?? code);
  });
  return {
    send: (msg) => {
      try {
        proc.send(msg);
      } catch {}
    },
    retire(now) {
      retiring = true;
      if (now) proc.kill("SIGKILL");
      else {
        setTimeout(() => proc.kill("SIGKILL"), 500);
        try {
          proc.send({ t: "close" });
        } catch {}
      }
      return proc.exited.then(() => {});
    },
    pid: proc.pid,
  };
}

export class SimHost {
  entities = new Map<number, Entity>();
  nextId = 1;
  perf: Perf | null = null;
  players = new Map<string, Player>();
  watchers = new Set<string>();
  /** Which mod spawned each entity, kept across restarts. */
  creators = new Map<number, string>();
  corrections: Correction[] = [];
  private channel: Channel | null = null;
  private scratch = mkdtempSync(join(tmpdir(), "sandbox-beat-"));
  /**
   * The file the simulation's process writes its heartbeat to: ticks so far, and the mod running right now.
   * It lies in the sandbox's writable folder, where a mod could put a link to another file in its place, so this process opens it once, here, and never by name again.
   */
  private beatFile = join(this.scratch, "heartbeat");
  private beat = openSync(this.beatFile, "w+");
  private beatBytes = Buffer.alloc(8);
  /** Until the simulation has loaded its mods, only a much longer silence counts as hanging. */
  private ready = false;
  private startedAt = 0;
  private applying = new Map<string, (error: string | null) => void>();
  /** Set while a crashed game waits out its backoff; it counts as running, so nothing starts it early from its save. */
  private restarting?: Timer;
  /** The last simulation, until it has closed its databases; the next one opens them only after. */
  private closing: Promise<void> | null = null;
  /** A start waiting for the last simulation to close; it counts as running. */
  private waiting: Promise<void> | null = null;
  /** Players who entered while the game was down, by id: they arrive, with their mods' hooks, once the next process has loaded. */
  private arriving = new Map<string, object>();

  constructor(
    private dbDir: string,
    private mods: () => RunningMod[],
    private on: {
      tick(outs: Record<string, string>, diff: Diff): void;
      log(mod: string, level: string, text: string): void;
      fault(mod: string, error: string): void;
      unavailable?(reason: string): void;
      /** A mod asked with world.enter to move a player. */
      enter?(player: string, game: string | null): void;
      /** A mod to blame when the process dies with none running, like one reloaded just before. */
      crashSuspect?(): string | undefined;
    },
    /** The game this host runs, in a process of its own; null for the world's own hub. */
    readonly game: string | null = null,
    private games: () => string[] = () => [],
  ) {
    process.on("exit", () => {
      closeSync(this.beat);
      rmSync(this.scratch, { recursive: true, force: true });
    });
    let lastBeat = -1;
    let lastChange = Date.now();
    setInterval(() => {
      const b = this.heartbeat()[0]!;
      if (b !== lastBeat || !this.channel) {
        lastBeat = b;
        lastChange = Date.now();
        return;
      }
      if (Date.now() - lastChange < (this.ready ? HANG_MS : TRIAL_START_MS)) return;
      const culprit = this.culprit();
      this.retireChannel(true);
      if (culprit) this.on.fault(culprit.name, `froze the server for over ${HANG_MS / 1000} s`);
      this.start();
      lastChange = Date.now();
    }, 250);
  }

  get running() {
    return !!this.channel || !!this.restarting || !!this.waiting;
  }

  get pid() {
    return this.channel?.pid ?? null;
  }

  /** Read, not mapped, since Bun can't map a file on Windows; whatever a mod cut off the file reads as zero. */
  private heartbeat() {
    this.beatBytes.fill(0);
    readSync(this.beat, this.beatBytes, 0, 8, 0);
    return [this.beatBytes.readInt32LE(0), this.beatBytes.readInt32LE(4)];
  }

  private culprit() {
    const id = this.heartbeat()[1];
    return this.mods().find((m) => m.id === id);
  }

  private retireChannel(now?: boolean) {
    if (this.channel) {
      const closing: Promise<void> = this.channel.retire(now).then(() => {
        if (this.closing === closing) this.closing = null;
      });
      this.closing = closing;
    }
    this.channel = null;
  }

  start() {
    clearTimeout(this.restarting);
    this.restarting = undefined;
    if (this.waiting) return;
    if (this.closing) {
      const wait: Promise<void> = this.closing.then(() => {
        if (this.waiting !== wait) return;
        this.waiting = null;
        this.start();
      });
      this.waiting = wait;
      return;
    }
    ftruncateSync(this.beat);
    writeSync(this.beat, new Uint8Array(8), 0, 8, 0);
    this.ready = false;
    this.startedAt = Date.now();
    const receive = (msg: any) => channel === this.channel && this.receive(msg);
    const channel = processChannel(this.dbDir, this.mods(), this.scratch, receive, (code) => channel === this.channel && this.crashed(code), (text) => this.on.log("engine", "error", text));
    this.channel = channel;
    channel.send({
      t: "init",
      beatFile: this.beatFile,
      game: this.game,
      games: this.games(),
      entities: Object.fromEntries(this.entities),
      nextId: this.nextId,
      players: [...this.players.values()].filter((p) => !this.arriving.has(p.id)),
      watchers: [...this.watchers],
      creators: Object.fromEntries(this.creators),
      mods: this.mods(),
      dbDir: this.dbDir,
    });
    for (const join of this.arriving.values()) channel.send(join);
    this.arriving.clear();
    // Questions the last process never answered go to this one.
    for (const [id, { msg }] of this.asking) channel.send({ ...msg, id });
  }

  /** The mod running when the process died is blamed, as for a freeze, else one reloaded within the last minute; the game restarts from the last state it sent. */
  private crashed(code: number | string) {
    // Exit 125 is the sandbox failing only when the box's fresh probe, run before this, found it broken; a mod that exits with it just crashed.
    const reason = code === 125 ? boxRefusal() : null;
    if (reason) {
      this.channel = null;
      this.ready = false;
      this.on.log("engine", "error", reason);
      this.on.unavailable?.(reason);
      for (const finish of this.applying.values()) finish(reason);
      return;
    }
    const culprit = this.culprit()?.name;
    const suspect = culprit ? undefined : this.on.crashSuspect?.();
    this.on.log("engine", "error", `game ${this.game}'s process stopped (${code})${culprit ? ` in ${culprit}` : ""}; restarting it${suspect ? ` without the last change to ${suspect}` : ""}`);
    if (culprit) this.on.fault(culprit, `crashed its game's process (${code})`);
    else if (suspect) this.on.fault(suspect, `its game's process crashed (${code}) within a minute of this reload, so it was undone. Its files still have the change: find what crashed it before reloading it again.`);
    this.channel = null;
    const soon = Date.now() - this.startedAt < 5000;
    // Whatever arrives meanwhile waits for the new process instead of starting one early.
    this.restarting = setTimeout(() => this.start(), soon ? CRASH_BACKOFF_MS : 0);
  }

  /** Stops the simulation and forgets its world; whoever stops it saves the world first. */
  stop() {
    this.retireChannel();
    this.waiting = null;
    clearTimeout(this.restarting);
    this.restarting = undefined;
    this.arriving.clear();
    this.ready = false;
    this.perf = null;
    this.entities.clear();
    this.creators.clear();
    this.players.clear();
  }

  private receive(msg: any) {
    if (msg.t === "tick") {
      const d: Diff = msg.diff;
      for (const [id, set] of Object.entries(d.set)) this.entities.set(Number(id), { ...this.entities.get(Number(id)), ...set });
      for (const [id, keys] of Object.entries(d.unset)) {
        const e = this.entities.get(Number(id));
        if (e) for (const k of keys) delete e[k];
      }
      for (const [id, mod] of Object.entries(msg.made as Record<string, string>)) this.creators.set(Number(id), mod);
      for (const id of d.removed) {
        this.entities.delete(id);
        this.creators.delete(id);
      }
      this.nextId = msg.nextId;
      this.on.tick(msg.outs, d);
    } else if (msg.t === "log") this.on.log(msg.mod, msg.level, msg.text);
    else if (msg.t === "perf") this.perf = msg;
    else if (msg.t === "ready") this.ready = true;
    else if (msg.t === "fault") this.on.fault(msg.mod, msg.error);
    else if (msg.t === "applied") this.applying.get(msg.name)?.(msg.error);
    else if (msg.t === "enter") this.on.enter?.(msg.player, msg.game);
    else if (msg.t === "correction") {
      const { t, ...c } = msg;
      if (this.corrections.push(c) > 500) this.corrections.shift();
    } else if (msg.t === "answer") {
      this.asking.get(msg.id)?.resolve(msg.value);
      this.asking.delete(msg.id);
    }
  }

  private asking = new Map<number, { resolve: (value: any) => void; msg: object }>();
  private askSeq = 0;
  private ask<T>(msg: object) {
    const id = ++this.askSeq;
    return new Promise<T>((resolve) => {
      this.asking.set(id, { resolve, msg });
      this.channel?.send({ ...msg, id });
    });
  }

  /** Timelapse ticks cut down to what one player may see under the live mods' rules. */
  visibleTo(player: string, ticks: Tick[]) {
    return this.ask<Tick[]>({ t: "see", player, ticks });
  }

  /** Walks a test body from one feet position toward another under the live physics; says whether it arrived and what stopped it. */
  walk(from: number[], to: number[], body?: object) {
    return this.ask<object>({ t: "walk", from, to, body });
  }

  resync(id: string) {
    this.channel?.send({ t: "resync", id });
  }

  /** Replaces the world wholesale: a fresh simulation loads every mod against the new entities. */
  restart() {
    this.retireChannel();
    this.start();
  }

  send(msg: any) {
    if (msg.t === "join") this.players.set(msg.player.id, msg.player);
    if (msg.t === "leave") {
      this.players.delete(msg.id);
      this.arriving.delete(msg.id);
    }
    if (msg.t === "watch") this.watchers.add(msg.id);
    if (msg.t === "unwatch") this.watchers.delete(msg.id);
    if (this.channel) this.channel.send(msg);
    // A player entering a game that is down arrives in its next process; anything else sent meanwhile is stale by then, and a player leaving is left out of it.
    else if (msg.t === "join") this.arriving.set(msg.player.id, msg);
  }

  /** Swaps a mod into the live simulation; resolves once its load hook ran, with that hook's error if any. */
  apply(mod: RunningMod): Promise<string | null> {
    const reason = boxRefusal();
    if (reason && mod.server !== null && !mod.trusted) return Promise.resolve(reason);
    if (!this.channel) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), HANG_MS);
      const done = (error: string | null) => {
        clearTimeout(timer);
        this.applying.delete(mod.name);
        resolve(error);
      };
      this.applying.set(mod.name, done);
      this.send({ t: "mod", ...mod });
    });
  }

  /** Runs every live mod, with the candidate swapped in, against a copy of the world; resolves to the candidate's error or null. */
  trial(mod: RunningMod): Promise<string | null> {
    const mods = [...this.mods().filter((m) => m.name !== mod.name), mod];
    const reason = boxRefusal();
    if (reason && mods.some((candidate) => candidate.server !== null && !candidate.trusted)) return Promise.resolve(reason);
    return new Promise((resolve) => {
      let timer: Timer;
      let finished = false;
      const done = (error: string | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        proc.kill("SIGKILL");
        resolve(error);
      };
      const broker = createBroker((msg) => proc.send(msg));
      const scratch = mkdtempSync(join(tmpdir(), "sandbox-trial-"));
      const proc = spawnSimulation(this.dbDir, mods, scratch, true, (msg) => {
        if (broker.receive(msg) || !msg || typeof msg !== "object" || !("t" in msg)) return;
        if (msg.t === "trial" && "error" in msg) done(typeof msg.error === "string" ? msg.error : null);
        else if (msg.t === "ticking") {
          clearTimeout(timer);
          timer = setTimeout(() => done(`did not finish 20 test ticks within ${HANG_MS / 1000} s (infinite loop?)`), HANG_MS);
        }
      });
      timer = setTimeout(() => done(`did not load within ${TRIAL_START_MS / 1000} s (infinite loop at import?)`), TRIAL_START_MS);
      proc.exited.then((code) => {
        broker.close();
        rmSync(scratch, { recursive: true, force: true });
        // As for a crash: 125 is a refusal only when the box's fresh probe found the sandbox broken, and never a pass.
        done((code === 125 ? boxRefusal() : null) ?? `the test run crashed (exit ${proc.signalCode ?? code})`);
      });
      void drain(proc.stderr as ReadableStream<Uint8Array>);
      void drain(proc.stdout as ReadableStream<Uint8Array>);
      proc.send({
        t: "init",
        game: this.game,
        games: this.games(),
        entities: Object.fromEntries(this.entities),
        nextId: this.nextId,
        players: [],
        watchers: [],
        mods,
        trial: mod.name,
        dbDir: this.dbDir,
      });
    });
  }
}
