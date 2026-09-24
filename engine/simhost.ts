import type { Entity, Player } from "./api";

export type RunningMod = { name: string; id: number; server: string | null };

const HANG_MS = 2000;

export class SimHost {
  entities = new Map<number, Entity>();
  nextId = 1;
  players = new Map<string, Player>();
  private worker!: Worker;
  private beat = new Int32Array(new SharedArrayBuffer(8));

  constructor(
    private mods: () => RunningMod[],
    private on: {
      delta(d: { set: Record<number, Entity>; removed: number[] }): void;
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
      if (msg.t === "delta") {
        for (const [id, e] of Object.entries(msg.set)) this.entities.set(Number(id), e as Entity);
        for (const id of msg.removed) this.entities.delete(id);
        this.nextId = msg.nextId;
        this.on.delta(msg);
      } else if (msg.t === "log") this.on.log(msg.mod, msg.level, msg.text);
      else if (msg.t === "fault") this.on.fault(msg.mod, msg.error);
    };
    this.worker.postMessage({
      t: "init",
      beat: this.beat.buffer,
      entities: Object.fromEntries(this.entities),
      nextId: this.nextId,
      players: [...this.players.values()],
      mods: this.mods(),
    });
  }

  send(msg: any) {
    if (msg.t === "join") this.players.set(msg.player.id, msg.player);
    if (msg.t === "leave") this.players.delete(msg.id);
    this.worker.postMessage(msg);
  }

  /** Runs one mod against a copy of the live world; resolves to an error message or null. */
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
        mods: [mod],
        trial: mod.name,
      });
    });
  }
}
