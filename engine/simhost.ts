import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entity, Player } from "./api";
import type { Diff, Tick } from "./world";

/** `game` is the game the mod belongs to, or null for a mod every game shares. */
export type RunningMod = { name: string; id: number; server: string | null; game: string | null };
/** The server put a player somewhere other than where their own game or another mod had just moved them. */
export type Correction = { at: number; mod: string; hook: string; player: string; entity: number; overruled: string; from: number[]; to: number[]; wanted: number[] | null; repeats: number };
export type Perf = { msPerTick: number; p50: number; p95: number; max: number; mods: Record<string, number>; modTicks: Record<string, { p95: number; max: number }> };

const HANG_MS = 2000;
/** Starting a trial loads every server mod, which takes seconds on a busy machine; only its ticks count as hanging. */
const TRIAL_START_MS = 15_000;
/** A game whose process keeps dying at start waits this long before the next try, so it can't spin. */
const CRASH_BACKOFF_MS = 1000;
const SIM = new URL("./sim.ts", import.meta.url);

/** How a host reaches its simulation: a worker in this process for the hub, a child process for a game. */
type Channel = { send(msg: object): void; retire(now?: boolean): Promise<void>; pid: number | null };

/**
 * Closes a worker's databases before terminating it, since Bun never frees what a terminated worker left open and
 * terminating it while it closes them crashes the process. Resolves once it is gone; one too stuck to answer is terminated after 2 s.
 */
function retire(worker: Worker) {
  return new Promise<void>((resolve) => {
    const gone = () => {
      clearTimeout(timer);
      worker.terminate();
      resolve();
    };
    const timer = setTimeout(gone, 2000);
    worker.addEventListener("message", ({ data }) => data.t === "closed" && gone());
    try {
      worker.postMessage({ t: "close" });
    } catch {
      gone();
    }
  });
}

function workerChannel(receive: (msg: any) => void, log: (text: string) => void): Channel {
  const worker = new Worker(SIM);
  worker.onerror = (e) => log(`simulation worker: ${e.message}`);
  worker.onmessage = ({ data }) => receive(data);
  return { send: (msg) => worker.postMessage(msg), retire: () => retire(worker), pid: null };
}

/** A game's own process: a busy or crashing mod stops only that game, and its exit frees everything it loaded. */
function processChannel(receive: (msg: any) => void, exited: (code: number | string) => void): Channel {
  let retiring = false;
  const proc = Bun.spawn([process.execPath, SIM.pathname], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
    ipc: (msg) => (msg.t === "closed" ? proc.kill("SIGKILL") : receive(msg)),
  });
  proc.exited.then((code) => retiring || exited(proc.signalCode ?? code));
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
  private beat: Int32Array;
  private beatFile: string | null = null;
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
      /** A mod asked with world.enter to move a player. */
      enter?(player: string, game: string | null): void;
      /** A mod to blame when the process dies with none running, like one reloaded just before. */
      crashSuspect?(): string | undefined;
    },
    /** The game this host runs, in a process of its own; null for the world's own hub. */
    readonly game: string | null = null,
    private games: () => string[] = () => [],
  ) {
    if (game === null) this.beat = new Int32Array(new SharedArrayBuffer(8));
    else {
      // Processes share no memory, so the heartbeat goes through a file both map.
      const file = (this.beatFile = join(tmpdir(), `sandbox-beat-${process.pid}-${game}`));
      writeFileSync(file, new Uint8Array(8));
      const mapped = Bun.mmap(file);
      this.beat = new Int32Array(mapped.buffer, mapped.byteOffset, 2);
      process.on("exit", () => rmSync(file, { force: true }));
    }
    let lastBeat = -1;
    let lastChange = Date.now();
    setInterval(() => {
      const b = Atomics.load(this.beat, 0);
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

  private culprit() {
    return this.mods().find((m) => m.id === Atomics.load(this.beat, 1));
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
    Atomics.store(this.beat, 1, 0);
    this.ready = false;
    this.startedAt = Date.now();
    const receive = (msg: any) => channel === this.channel && this.receive(msg);
    const channel: Channel =
      this.game === null ? workerChannel(receive, (text) => this.on.log("engine", "error", text)) : processChannel(receive, (code) => channel === this.channel && this.crashed(code));
    this.channel = channel;
    channel.send({
      t: "init",
      beat: this.game === null ? this.beat.buffer : undefined,
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
    return new Promise((resolve) => {
      let timer = setTimeout(() => done(`did not load within ${TRIAL_START_MS / 1000} s (infinite loop at import?)`), TRIAL_START_MS);
      let finished = false;
      const done = (error: string | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        proc.kill("SIGKILL");
        resolve(error);
      };
      // A child process rather than a worker: its exit frees everything the test run loaded, which a terminated worker never does.
      const proc = Bun.spawn([process.execPath, SIM.pathname], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        ipc: (msg) => {
          if (msg.t === "trial") done(msg.error);
          else if (msg.t === "ticking") {
            clearTimeout(timer);
            timer = setTimeout(() => done(`did not finish 20 test ticks within ${HANG_MS / 1000} s (infinite loop?)`), HANG_MS);
          }
        },
      });
      proc.exited.then((code) => done(`the test run crashed (exit ${proc.signalCode ?? code})`));
      proc.send({
        t: "init",
        game: this.game,
        games: this.games(),
        entities: Object.fromEntries(this.entities),
        nextId: this.nextId,
        players: [],
        watchers: [],
        mods: [...this.mods().filter((m) => m.name !== mod.name), mod],
        trial: mod.name,
        dbDir: this.dbDir,
      });
    });
  }
}
