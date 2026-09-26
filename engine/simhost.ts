import type { Entity, Player } from "./api";
import type { Diff, Tick } from "./world";


export type RunningMod = { name: string; id: number; server: string | null };
/** The server put a player somewhere other than where their own game or another mod had just moved them. */
export type Correction = { at: number; mod: string; hook: string; player: string; entity: number; overruled: string; from: number[]; to: number[]; wanted: number[] | null; repeats: number };

const HANG_MS = 2000;
/** Starting a trial loads every server mod, which takes seconds on a busy machine; only its ticks count as hanging. */
const TRIAL_START_MS = 15_000;

/** Closes a worker's databases before terminating it, since Bun never frees what a terminated worker left open; one too stuck to answer is terminated anyway. */
function retire(worker: Worker) {
  const timer = setTimeout(() => worker.terminate(), 500);
  worker.addEventListener("message", ({ data }) => {
    if (data.t !== "closed") return;
    clearTimeout(timer);
    worker.terminate();
  });
  worker.postMessage({ t: "close" });
}

export class SimHost {
  entities = new Map<number, Entity>();
  nextId = 1;
  perf: { msPerTick: number; p50: number; p95: number; max: number; mods: Record<string, number>; modTicks: Record<string, { p95: number; max: number }> } | null = null;
  players = new Map<string, Player>();
  watchers = new Set<string>();
  /** Which mod spawned each entity, kept across worker restarts. */
  creators = new Map<number, string>();
  corrections: Correction[] = [];
  private worker!: Worker;
  private beat = new Int32Array(new SharedArrayBuffer(8));
  private applying = new Map<string, (error: string | null) => void>();

  constructor(
    private dbDir: string,
    private mods: () => RunningMod[],
    private on: {
      tick(outs: Record<string, string>, diff: Diff): void;
      log(mod: string, level: string, text: string): void;
      fault(mod: string, error: string): void;
    },
  ) {
    let lastBeat = -1;
    let lastChange = Date.now();
    setInterval(() => {
      const b = Atomics.load(this.beat, 0);
      if (b !== lastBeat) {
        lastBeat = b;
        lastChange = Date.now();
        return;
      }
      if (Date.now() - lastChange < HANG_MS) return;
      const culprit = this.mods().find((m) => m.id === Atomics.load(this.beat, 1));
      retire(this.worker);
      if (culprit) this.on.fault(culprit.name, `froze the server for over ${HANG_MS / 1000} s`);
      this.start();
      lastChange = Date.now();
    }, 250);
  }

  start() {
    Atomics.store(this.beat, 1, 0);
    const worker = (this.worker = new Worker(new URL("./sim.ts", import.meta.url)));
    this.worker.onerror = (e) => this.on.log("engine", "error", `simulation worker: ${e.message}`);
    this.worker.onmessage = ({ data: msg }) => {
      if (worker !== this.worker) return;
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
      else if (msg.t === "fault") this.on.fault(msg.mod, msg.error);
      else if (msg.t === "applied") this.applying.get(msg.name)?.(msg.error);
      else if (msg.t === "correction") {
        const { t, ...c } = msg;
        if (this.corrections.push(c) > 500) this.corrections.shift();
      } else if (msg.t === "answer") {
        this.asking.get(msg.id)?.(msg.value);
        this.asking.delete(msg.id);
      }
    };
    this.worker.postMessage({
      t: "init",
      beat: this.beat.buffer,
      entities: Object.fromEntries(this.entities),
      nextId: this.nextId,
      players: [...this.players.values()],
      watchers: [...this.watchers],
      creators: Object.fromEntries(this.creators),
      mods: this.mods(),
      dbDir: this.dbDir,
    });
  }

  private asking = new Map<number, (value: any) => void>();
  private askSeq = 0;
  private ask<T>(msg: object) {
    const id = ++this.askSeq;
    return new Promise<T>((resolve) => {
      this.asking.set(id, resolve);
      this.worker.postMessage({ ...msg, id });
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
    this.worker.postMessage({ t: "resync", id });
  }

  /** Replaces the world wholesale: a fresh worker loads every mod against the new entities. */
  restart() {
    retire(this.worker);
    this.start();
  }

  send(msg: any) {
    if (msg.t === "join") this.players.set(msg.player.id, msg.player);
    if (msg.t === "leave") this.players.delete(msg.id);
    if (msg.t === "watch") this.watchers.add(msg.id);
    if (msg.t === "unwatch") this.watchers.delete(msg.id);
    this.worker.postMessage(msg);
  }

  /** Swaps a mod into the live simulation; resolves once its load hook ran, with that hook's error if any. */
  apply(mod: RunningMod): Promise<string | null> {
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
      const proc = Bun.spawn([process.execPath, new URL("./sim.ts", import.meta.url).pathname], {
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
