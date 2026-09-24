import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { RunningMod, SimHost } from "./simhost";

type Build = { server: string | null; client: string | null };
type Mod = { id: number; author: string; version: number; build: Build; previous: Build[] };

export type ModEvents = {
  client(name: string, url: string | null): void;
  feed(text: string, kind?: "ok" | "error" | "info"): void;
  record(kind: "reload" | "error", who: string | null, data: object): void;
};

const MOD_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const KEY_CODE = /(?:[=!]==?\s*|\.has\(\s*|case\s+)["'`](Key[A-Z]|Digit[0-9]|F[0-9]{1,2}|Arrow(?:Up|Down|Left|Right)|Tab|Enter|Escape|Backquote|Backspace|CapsLock|Minus|Equal|Bracket(?:Left|Right)|Semicolon|Quote|Comma|Period|Slash|Backslash|Numpad\w+|(?:Control|Alt|Meta)(?:Left|Right)|Space|Shift(?:Left|Right)?)["'`]/g;
const MENU_TAB = /menuTab\(\s*["'`]([^"'`]+)["'`]/g;
/** Keys the engine itself handles. */
export const ENGINE_KEYS: Record<string, string> = { Tab: "the game menu", Enter: "chat", KeyT: "push to talk", KeyE: "interact prompts from ctx.interact", Digit1: "love votes after a reload", Digit2: "undo votes after a reload" };
/** Keys many mods read on purpose (moving, steering, closing their own window), so sharing them is not an overlap. */
const SHARED_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Shift", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "Escape"]);
const TSC = join(import.meta.dir, "../node_modules/.bin/tsc");

/** Checks only these mods' files and what they import, which reports the same errors in them as checking the whole tree. */
async function tsc(root: string, mods: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-tsconfig-"));
  try {
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ extends: join(root, "tsconfig.json"), include: mods.map((mod) => join(root, "mods", mod, "**/*.ts")) }));
    const proc = Bun.spawn([TSC, "-p", join(dir, "tsconfig.json"), "--pretty", "false"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const lines = (await new Response(proc.stdout).text()).split("\n");
    await proc.exited;
    return lines;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

  reload(name: string, who: string, author: string, force = false) {
    const run = this.queue.then(() => this.doReload(name, who, author, force));
    this.queue = run.catch(() => {});
    return run;
  }

  private async doReload(name: string, who: string, author: string, force: boolean): Promise<{ ok: boolean; report: string }> {
    if (!MOD_NAME.test(name)) return { ok: false, report: `Mod names are lowercase letters, digits and dashes: ${MOD_NAME}` };
    const dir = join(this.root, "mods", name);
    const current = this.running.get(name);

    if (!existsSync(dir)) {
      if (!current) return { ok: false, report: `No mod folder mods/${name}/ exists.` };
      const users = this.users(name);
      if (users.length && !force)
        return this.fail(
          name,
          who,
          `Live mods use ${name}: ${users.join(", ")}. So ${name} stays live, although its files are gone from disk (restore puts them back). Update or remove those mods first, or tell their owners and reload with force: true.`,
        );
      this.running.delete(name);
      this.save();
      this.sim.send({ t: "mod", name, id: current.id, server: null });
      this.events.client(name, null);
      await this.commit(name, `remove ${name}`, who);
      this.events.feed(`${who} removed ${name}`, "info");
      return { ok: true, report: `Unloaded ${name} for everyone.` };
    }

    const started = performance.now();
    const ms: Record<string, number> = {};
    let mark = started;
    const lap = (stage: string) => {
      const now = performance.now();
      ms[stage] = Math.round(now - mark);
      mark = now;
    };
    const reject = (stage: string, report: string) => {
      lap(stage);
      this.events.record("reload", who, { mod: name, ok: false, stage, ms: { ...ms, total: Math.round(performance.now() - started) }, report: report.slice(0, 500) });
      return this.fail(name, who, report);
    };
    const { own, dependents } = await this.typecheck(name);
    if (own) return reject("typecheck", `Type errors, nothing changed:\n${own}`);
    if (dependents)
      return reject(
        "typecheck",
        `This change breaks live mods that use ${name}, nothing changed. Keep ${name}'s exports compatible, or fix those mods in the same change and reload them after this one:\n${dependents}`,
      );
    lap("typecheck");
    const build = await this.build(name);
    if (typeof build === "string") return reject("build", `Build failed, nothing changed:\n${build}`);
    lap("build");

    const id = current?.id ?? this.nextId++;
    if (build.server) {
      const error = await this.sim.trial({ name, id, server: build.server });
      if (error) return reject("trial", `Test run against a copy of the live world failed, nothing changed:\n${error}`);
      lap("trial");
    }

    const version = (current?.version ?? 0) + 1;
    this.running.set(name, { id, author: current?.author ?? author, version, build, previous: current ? [...current.previous, current.build].slice(-5) : [] });
    this.save();
    const loadError = await this.sim.apply({ name, id, server: build.server });
    this.events.client(name, build.client);
    lap("apply");
    await this.commit(name, `${name} v${version}`, who);
    lap("commit");
    const total = Math.round(performance.now() - started);
    this.events.record("reload", who, { mod: name, ok: true, version, ms: { ...ms, total }, loadError: loadError?.slice(0, 500) });
    this.events.feed(`${who} reloaded ${name} v${version}`, "ok");
    const warning = loadError ? `\nBut its load hook threw on the live world:\n${loadError}` : "";
    return { ok: true, report: `${name} v${version} is live for everyone (${total} ms).${warning}${this.overlaps(name)}\nWatch \`logs\` for runtime errors: a mod that keeps throwing, is slow, or freezes the server gets reverted automatically.` };
  }

  /** Which live mods read which keys and fill which menu tabs, found in their client code. */
  controls() {
    const keys: Record<string, string[]> = {};
    const menus: Record<string, string[]> = {};
    for (const name of this.running.keys()) {
      const dir = join(this.root, "mods", name);
      if (!existsSync(dir)) continue;
      const code = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "server.ts").map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
      for (const key of new Set([...code.matchAll(KEY_CODE)].map((m) => m[1]!))) (keys[key] ??= []).push(name);
      for (const title of new Set([...code.matchAll(MENU_TAB)].map((m) => m[1]!))) (menus[title] ??= []).push(name);
    }
    return { keys, menus };
  }

  /** Keys this mod reads that the engine or another mod already uses, as advice for whoever just reloaded it. */
  private overlaps(name: string) {
    const lines: string[] = [];
    for (const [key, users] of Object.entries(this.controls().keys)) {
      if (!users.includes(name) || SHARED_KEYS.has(key)) continue;
      const others = users.filter((u) => u !== name);
      if (key === "KeyE") lines.push("- KeyE: the engine owns E. Offer the action with ctx.interact instead, so players get one prompt for the nearest thing and E never fires two mods.");
      else if (ENGINE_KEYS[key]) lines.push(`- ${key}: the engine uses it for ${ENGINE_KEYS[key]}. Pick another key.`);
      else if (others.length) lines.push(`- ${key}: also used by ${others.join(", ")}. Pick a free key (status lists every key in use), or share the feature through that mod's exports.`);
    }
    return lines.length ? `\nControls that overlap, fix these:\n${lines.join("\n")}` : "";
  }

  private fail(name: string, who: string, report: string) {
    this.events.feed(`${who}'s reload of ${name} was rejected`, "error");
    return { ok: false, report };
  }

  /** Called when a live mod misbehaves: fall back to its previous build, or unload it. */
  revert(name: string, error: string) {
    const mod = this.running.get(name);
    if (!mod) return;
    this.events.record("error", null, { mod: name, revert: true, text: error.slice(0, 500) });
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

  /** Type errors in the mod itself, and new ones its change causes in live mods that use it (a type import of its files or a use("<name>") call). */
  private async typecheck(name: string) {
    const users = this.users(name);
    const errorsIn = (lines: string[], mods: string[]) => lines.filter((line) => mods.some((mod) => line.startsWith(`mods/${mod}/`)));
    const lines = await tsc(this.root, [name, ...users]);
    let dependents = errorsIn(lines, users);
    // Errors those mods have without this change, like their own unfinished edits, are not this change's doing.
    if (dependents.length) {
      const before = await this.withoutChange(name);
      try {
        const old = new Set(errorsIn(await tsc(before, users), users));
        dependents = dependents.filter((line) => !old.has(line));
      } finally {
        rmSync(before, { recursive: true, force: true });
      }
    }
    return { own: errorsIn(lines, [name]).join("\n"), dependents: dependents.join("\n") };
  }

  /** A scratch copy of the tree's code with this mod as it was last accepted. */
  private async withoutChange(name: string) {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-typecheck-"));
    for (const file of ["api.ts", "tsconfig.json", "package.json"]) if (existsSync(join(this.root, file))) cpSync(join(this.root, file), join(dir, file));
    if (existsSync(join(this.root, "node_modules"))) symlinkSync(join(this.root, "node_modules"), join(dir, "node_modules"));
    for (const file of new Bun.Glob("mods/**/*.ts").scanSync(this.root)) if (!file.startsWith(`mods/${name}/`)) cpSync(join(this.root, file), join(dir, file));
    const archive = Bun.spawn(["git", "archive", "HEAD", "--", `mods/${name}`], { cwd: this.root, stdout: "pipe", stderr: "ignore" });
    await Bun.spawn(["tar", "-x", "-C", dir, "--wildcards", "*.ts"], { stdin: archive.stdout, stderr: "ignore" }).exited;
    return dir;
  }

  users(name: string) {
    const uses = new RegExp(`\\buse(?:<.*?>)?\\(\\s*["'\`]${name}["'\`]|["'\`]\\.\\./${name}/`);
    return [...this.running.keys()].filter((other) => {
      const dir = join(this.root, "mods", other);
      return other !== name && existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".ts") && uses.test(readFileSync(join(dir, f), "utf8")));
    });
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
