// Keeps one world's typecheck (checker.child.ts) running in the mod sandbox: TypeScript loaded, and the world's incremental program with every file's errors, carried from one check to the next.
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_MODULES, worldGrants } from "./build";
import type { Answer, Ask, Overlay, Request } from "./checker.child";
import { box } from "./index";

export type { Overlay };
/**
 * Where checks' time went, added up over the checks it is given: waiting behind earlier requests, the program's own work in the sandbox, and the messages there and back.
 * warming is set when one of them waited for the program to start or warm up.
 */
export type Spent = { wait: number; run: number; ipc: number; warming: boolean };

const CHILD = join(import.meta.dir, "checker.child.ts");
const CHECK_MS = 120_000;
const MOD_NAME = /^[a-z][a-z0-9-]{0,31}$/;

type Asked = { id: number; resolve(diagnostics: string[], ms: number): void; reject(error: Error): void };
/** answered: the program has answered a request, so it has loaded TypeScript and read the whole world once. */
type Running = { proc: Bun.Subprocess<"ignore", "pipe", "pipe">; grants: string; asked: Asked | null; stderr: string; answered: boolean };

/**
 * One world's typecheck: a long-lived incremental program in the mod sandbox, asked one check at a time.
 * It starts again, cold, after it stops, and when the world's grants change underneath it: an install puts a new node_modules folder in place of the one it was granted.
 */
export class Checker {
  private running: Running | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private closed = false;
  /** Warm-ups asked for that haven't finished: a check asked for meanwhile waits for them. */
  private warmups = 0;

  constructor(private root: string) {}

  /**
   * Starts the program if it isn't running, as after an install, and has it check the whole world, resolving when it has, so the next reload finds it warm.
   * The mods' own errors don't count against it; it rejects when the program couldn't start or check, its config included, as a check would.
   */
  warm() {
    this.warmups++;
    return this.enqueue({ t: "warm" })
      .then(() => {})
      .finally(() => this.warmups--);
  }

  /**
   * Errors in these mods' files, each as tsc prints it relative to the world, with overlay's mod as it was last accepted instead of its folder on disk.
   * Rejects when the check couldn't run, so a check that never ran never passes. Its time is added to spent.
   */
  check(mods: string[], overlay?: Overlay, spent?: Spent): Promise<string[]> {
    if (![...mods, ...(overlay ? [overlay.mod] : [])].every((mod) => MOD_NAME.test(mod))) return Promise.reject(new Error("A typecheck names mods by their folder names."));
    if (overlay && mods.includes(overlay.mod)) return Promise.reject(new Error("A typecheck can't replace a mod it checks."));
    // Behind a warm-up, or with no program that has answered yet, this check waits for the program to load TypeScript and read the whole world.
    if (spent && (this.warmups || !this.running?.answered)) spent.warming = true;
    return this.enqueue({ t: "check", mods, overlay }, spent);
  }

  /** Stops the program; checks asked for after this are refused. */
  close() {
    this.closed = true;
    const running = this.running;
    this.running = null;
    if (!running) return Promise.resolve();
    running.proc.kill();
    return running.proc.exited.then(() => {});
  }

  private enqueue(request: Ask, spent?: Spent) {
    const queued = performance.now();
    const run = this.queue.then(() => {
      if (spent) spent.wait += performance.now() - queued;
      return this.ask(request, spent);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private ask(request: Ask, spent?: Spent) {
    if (this.closed) throw new Error("The world is stopping.");
    const running = this.start();
    // A program started for this request, as after an install or a crash, is cold.
    if (spent && !running.answered) spent.warming = true;
    return new Promise<string[]>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        running.asked?.reject(new Error(`The typecheck ran for over ${CHECK_MS / 1000} s and was stopped.`));
        this.stop(running);
      }, CHECK_MS);
      const settle = () => {
        clearTimeout(timer);
        running.asked = null;
      };
      const sent = performance.now();
      running.asked = {
        id,
        resolve: (diagnostics, ms) => {
          settle();
          if (spent) {
            spent.run += ms;
            spent.ipc += performance.now() - sent - ms;
          }
          resolve(diagnostics);
        },
        reject: (error) => (settle(), reject(error)),
      };
      try {
        running.proc.send({ ...request, id } satisfies Request);
      } catch {
        running.asked.reject(new Error("The typecheck stopped before it was asked."));
        this.stop(running);
      }
    });
  }

  /** The running program, started afresh when there is none or what the world's grants name is no longer what it was granted. */
  private start() {
    const { read, list } = worldGrants(this.root);
    // The sandbox grants a folder as it was when the program started; one put in its place is another folder.
    const grants = read.map((path) => `${path}:${statSync(path).dev}:${statSync(path).ino}`).join("\n");
    if (this.running?.grants === grants) return this.running;
    if (this.running) this.stop(this.running);
    const running: Running = { proc: null!, grants, asked: null, stderr: "", answered: false };
    running.proc = box({ cmd: [process.execPath, CHILD, realpathSync(this.root)], cwd: this.root, read: [CHILD, ENGINE_MODULES, ...read], list, ipc: (message) => this.receive(running, message) });
    this.running = running;
    void drain(running.proc.stdout, () => {});
    void drain(running.proc.stderr, (text) => (running.stderr = (running.stderr + text).slice(-2000)));
    running.proc.exited.then((code) => {
      if (this.running === running) this.running = null;
      running.asked?.reject(new Error(`The typecheck stopped (exit ${running.proc.signalCode ?? code})${running.stderr.trim() ? `:\n${running.stderr.trim()}` : "."}`));
    });
    return running;
  }

  private stop(running: Running) {
    if (this.running === running) this.running = null;
    running.proc.kill("SIGKILL");
  }

  private receive(running: Running, message: unknown) {
    const answer = message as Answer | null;
    const asked = running.asked;
    if (!asked || answer?.id !== asked.id) return;
    running.answered = true;
    if (answer.t === "checked" && Array.isArray(answer.diagnostics) && answer.diagnostics.every((d) => typeof d === "string")) asked.resolve(answer.diagnostics, Number.isFinite(answer.ms) ? answer.ms : 0);
    else asked.reject(new Error(answer.t === "failed" && typeof answer.error === "string" ? answer.error : "The typecheck answered with something that isn't a check."));
  }
}

async function drain(stream: ReadableStream<Uint8Array>, take: (text: string) => void) {
  const decoder = new TextDecoder();
  for await (const chunk of stream) take(decoder.decode(chunk, { stream: true }));
}
