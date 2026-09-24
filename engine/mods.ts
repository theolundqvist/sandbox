import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { RunningMod, SimHost } from "./simhost";

type Build = { server: string | null; client: string | null };
type Mod = { id: number; author: string; version: number; build: Build; previous: Build[] };

export type ModEvents = {
  client(name: string, url: string | null): void;
  feed(text: string, kind?: "ok" | "error" | "info"): void;
};

const MOD_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const TSC = join(import.meta.dir, "../node_modules/.bin/tsc");

export class Mods {
  running = new Map<string, Mod>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  sim!: SimHost;

  constructor(
    private root: string,
    private buildDir: string,
    private statePath: string,
    private events: ModEvents,
  ) {}

  list(): RunningMod[] {
    return [...this.running].map(([name, m]) => ({ name, id: m.id, server: m.build.server }));
  }

  names() {
    const dir = join(this.root, "mods");
    return existsSync(dir) ? readdirSync(dir).filter((n) => MOD_NAME.test(n)).sort() : [];
  }

  /** Restores exactly the builds that were live at shutdown; a fresh world builds its seed mods. */
  async loadAll(owners: Record<string, string>) {
    if (existsSync(this.statePath)) {
      this.running = new Map(Object.entries(JSON.parse(readFileSync(this.statePath, "utf8"))));
      this.nextId = Math.max(0, ...[...this.running.values()].map((m) => m.id)) + 1;
      return;
    }
    for (const name of this.names()) {
      const result = await this.build(name);
      if (typeof result === "string") this.events.feed(`${name} failed to load: ${result}`, "error");
      else this.running.set(name, { id: this.nextId++, author: owners[name] ?? "world", version: 1, build: result, previous: [] });
    }
    this.save();
  }

  private save() {
    writeFileSync(this.statePath, JSON.stringify(Object.fromEntries(this.running), null, 2));
  }

  reload(name: string, who: string, author: string) {
    const run = this.queue.then(() => this.doReload(name, who, author));
    this.queue = run.catch(() => {});
    return run;
  }

  private async doReload(name: string, who: string, author: string): Promise<{ ok: boolean; report: string }> {
    if (!MOD_NAME.test(name)) return { ok: false, report: `Mod names are lowercase letters, digits and dashes: ${MOD_NAME}` };
    const dir = join(this.root, "mods", name);
    const current = this.running.get(name);

    if (!existsSync(dir)) {
      if (!current) return { ok: false, report: `No mod folder mods/${name}/ exists.` };
      this.running.delete(name);
      this.save();
      this.sim.send({ t: "mod", name, id: current.id, server: null });
      this.events.client(name, null);
      await this.commit(name, `remove ${name}`, who);
      this.events.feed(`${who} removed ${name}`, "info");
      return { ok: true, report: `Unloaded ${name} for everyone.` };
    }

    const started = performance.now();
    const typeErrors = await this.typecheck(name);
    if (typeErrors) return this.fail(name, who, `Type errors, nothing changed:\n${typeErrors}`);
    const build = await this.build(name);
    if (typeof build === "string") return this.fail(name, who, `Build failed, nothing changed:\n${build}`);

    const id = current?.id ?? this.nextId++;
    if (build.server) {
      const error = await this.sim.trial({ name, id, server: build.server });
      if (error) return this.fail(name, who, `Test run against a copy of the live world failed, nothing changed:\n${error}`);
    }

    const version = (current?.version ?? 0) + 1;
    this.running.set(name, { id, author: current?.author ?? author, version, build, previous: current ? [...current.previous, current.build].slice(-5) : [] });
    this.save();
    const loadError = await this.sim.apply({ name, id, server: build.server });
    this.events.client(name, build.client);
    await this.commit(name, `${name} v${version}`, who);
    const ms = Math.round(performance.now() - started);
    this.events.feed(`${who} reloaded ${name} v${version}`, "ok");
    const warning = loadError ? `\nBut its load hook threw on the live world:\n${loadError}` : "";
    return { ok: true, report: `${name} v${version} is live for everyone (${ms} ms).${warning}\nWatch \`logs\` for runtime errors: a mod that keeps throwing, is slow, or freezes the server gets reverted automatically.` };
  }

  private fail(name: string, who: string, report: string) {
    this.events.feed(`${who}'s reload of ${name} was rejected`, "error");
    return { ok: false, report };
  }

  /** Called when a live mod misbehaves: fall back to its previous build, or unload it. */
  revert(name: string, error: string) {
    const mod = this.running.get(name);
    if (!mod) return;
    const previous = mod.previous.pop();
    if (previous) {
      mod.build = previous;
      mod.version++;
      this.sim.send({ t: "mod", name, id: mod.id, server: previous.server });
      this.events.client(name, previous.client);
      this.events.feed(`${name} reverted to its previous version: ${error.split("\n")[0]}`, "error");
    } else {
      this.running.delete(name);
      this.sim.send({ t: "mod", name, id: mod.id, server: null });
      this.events.client(name, null);
      this.events.feed(`${name} was unloaded: ${error.split("\n")[0]}`, "error");
    }
    this.save();
  }

  private async typecheck(name: string) {
    const proc = Bun.spawn([TSC, "-p", this.root, "--pretty", "false"], { cwd: this.root, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out
      .split("\n")
      .filter((line) => line.startsWith(`mods/${name}/`))
      .join("\n");
  }

  private async build(name: string): Promise<Build | string> {
    const dir = join(this.root, "mods", name);
    const out = join(this.buildDir, name, `${Date.now().toString(36)}`);
    const result: Build = { server: null, client: null };
    for (const side of ["server", "client"] as const) {
      const entry = join(dir, `${side}.ts`);
      if (!existsSync(entry)) continue;
      const built = await Bun.build({
        entrypoints: [entry],
        outdir: join(out, side),
        target: side === "server" ? "bun" : "browser",
        format: "esm",
        external: side === "client" ? ["three", "three/*"] : [],
        throw: false,
      });
      if (!built.success) return built.logs.map((l) => String(l)).join("\n");
      const file = built.outputs[0]!.path;
      result[side] = side === "server" ? file : `/build/${relative(this.buildDir, file)}`;
    }
    if (!result.server && !result.client) return `mods/${name}/ needs a server.ts or a client.ts`;
    return result;
  }

  private async commit(name: string, message: string, who: string) {
    const git = (...args: string[]) => Bun.spawn(["git", ...args], { cwd: this.root, stdout: "ignore", stderr: "ignore" }).exited;
    await git("add", "-A", `mods/${name}`);
    await git("commit", "-q", "-m", message, `--author=${who} <${who}@sandbox>`, "--", `mods/${name}`);
  }
}
