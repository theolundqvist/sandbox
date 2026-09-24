import type { Entity, Player } from "./api";
import type { Diff } from "./world";

export type RunningMod = { name: string; id: number; server: string | null };

const HANG_MS = 2000;

export class SimHost {
  entities = new Map<number, Entity>();
  nextId = 1;
  players = new Map<string, Player>();
  private worker!: Worker;
  private beat = new Int32Array(new SharedArrayBuffer(8));
  private applying = new Map<string, (error: string | null) => void>();

  constructor(
    private dbDir: string,
    private mods: () => RunningMod[],
    private on: {
      tick(outs: Record<string, string>): void;
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
      this.worker.terminate();
      if (culprit) this.on.fault(culprit.name, `froze the server for over ${HANG_MS / 1000} s`);
      this.start();
      lastChange = Date.now();
    }, 250);
  }

  start() {
    Atomics.store(this.beat, 1, 0);
    this.worker = new Worker(new URL("./sim.ts", import.meta.url));
    this.worker.onerror = (e) => this.on.log("engine", "error", `simulation worker: ${e.message}`);
    this.worker.onmessage = ({ data: msg }) => {
      if (msg.t === "tick") {
        const d: Diff = msg.diff;
        for (const [id, set] of Object.entries(d.set)) this.entities.set(Number(id), { ...this.entities.get(Number(id)), ...set });
        for (const [id, keys] of Object.entries(d.unset)) {
          const e = this.entities.get(Number(id));
          if (e) for (const k of keys) delete e[k];
        }
        for (const id of d.removed) this.entities.delete(id);
        this.nextId = msg.nextId;
        this.on.tick(msg.outs);
      } else if (msg.t === "log") this.on.log(msg.mod, msg.level, msg.text);
      else if (msg.t === "fault") this.on.fault(msg.mod, msg.error);
      else if (msg.t === "applied") this.applying.get(msg.name)?.(msg.error);
    };
    this.worker.postMessage({
      t: "init",
      beat: this.beat.buffer,
      entities: Object.fromEntries(this.entities),
      nextId: this.nextId,
      players: [...this.players.values()],
      mods: this.mods(),
      dbDir: this.dbDir,
    });
  }

  resync(id: string) {
    this.worker.postMessage({ t: "resync", id });
  }

  send(msg: any) {
    if (msg.t === "join") this.players.set(msg.player.id, msg.player);
    if (msg.t === "leave") this.players.delete(msg.id);
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
    const worker = new Worker(new URL("./sim.ts", import.meta.url));
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(`did not finish 20 test ticks within ${HANG_MS / 1000} s (infinite loop?)`), HANG_MS);
      const done = (error: string | null) => {
        clearTimeout(timer);
        worker.terminate();
        resolve(error);
      };
      worker.onmessage = ({ data: msg }) => {
        if (msg.t === "trial") done(msg.error);
      };
      worker.onerror = (e) => done(String(e.message));
      worker.postMessage({
        t: "init",
        beat: new SharedArrayBuffer(8),
        entities: Object.fromEntries(this.entities),
        nextId: this.nextId,
        players: [],
        mods: [...this.mods().filter((m) => m.name !== mod.name), mod],
        trial: mod.name,
        dbDir: this.dbDir,
      });
    });
  }
}
