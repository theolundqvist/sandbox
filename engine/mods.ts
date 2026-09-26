import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { declaredGame } from "./modgame";
import type { RunningMod } from "./simhost";
import type { Sims } from "./sims";

/** `game` is the game this build's source names; absent for a mod every game shares. */
type Build = { server: string | null; client: string | null; game?: string };
type Key = { code: string; label: string };
/** Found in the mod's files when it went live: keys its client reads, menu tabs it fills, mods it uses, and systems its server claims with `export const owns`. */
type Source = { keys: string[]; menus: string[]; uses: string[]; owns: string[] };
/** `keys` are what its client declared with ctx.key, as players' games last reported them; `at` is when this version went live, which the launcher reads to undo a reload the world crashed right after. */
type Mod = { id: number; author: string; version: number; build: Build; previous: Build[]; keys?: Key[]; source?: Source; at?: number };
type Result = { ok: boolean; report: string };

export type ModEvents = {
  /** Returns whether any player who loads it (everyone for a shared mod, else those in its game) has the game open. */
  client(name: string, url: string | null, game: string | null): boolean;
  feed(text: string, kind?: "ok" | "error" | "info"): void;
  record(kind: "reload" | "error", who: string | null, data: object): void;
};

const MOD_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** Reloads of different mods that run at once; each test run loads every server mod in its own process. */
const PARALLEL_RELOADS = 2;
const KEY_CODE = /(?:[=!]==?\s*|\.has\(\s*|case\s+)["'`](Key[A-Z]|Digit[0-9]|F[0-9]{1,2}|Arrow(?:Up|Down|Left|Right)|Tab|Enter|Escape|Backquote|Backspace|CapsLock|Minus|Equal|Bracket(?:Left|Right)|Semicolon|Quote|Comma|Period|Slash|Backslash|Numpad\w+|(?:Control|Alt|Meta)(?:Left|Right)|Space|Shift(?:Left|Right)?)["'`]/g;
const MENU_TAB = /menuTab\(\s*["'`]([^"'`]+)["'`]/g;
const USES = /\buse(?:<.*?>)?\(\s*["'`]([a-z][a-z0-9-]{0,31})["'`]|["'`]\.\.\/([a-z][a-z0-9-]{0,31})\//g;
const OWNS = /export\s+const\s+owns\s*=\s*\[([^\]]*)\]/;
/** Keys the engine itself handles. */
export const ENGINE_KEYS: Record<string, string> = { Tab: "the game menu", Enter: "chat", KeyT: "push to talk", KeyE: "interact prompts from ctx.interact" };
/** Keys many mods read on purpose (moving, steering, closing their own window), so sharing them is not an overlap. */
const SHARED_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Shift", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "Escape"]);
/** Whether this machine has a real git. A Mac without the developer tools has only a stub at /usr/bin/git, which opens an install dialog every time it runs. */
export const hasGit = (() => {
  const git = Bun.which("git");
  if (process.platform === "darwin" && git === "/usr/bin/git") return Bun.spawnSync(["xcode-select", "-p"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  return !!git;
})();
const sameFile = (a: string, b: string) => existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));
const unique = (xs: Iterable<string>) => [...new Set(xs)];

function scan(dir: string): Source {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".ts")) : [];
  const text = Object.fromEntries(files.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
  const client = files.filter((f) => f !== "server.ts").map((f) => text[f]).join("\n");
  return {
    keys: unique([...client.matchAll(KEY_CODE)].map((m) => m[1]!)),
    menus: unique([...client.matchAll(MENU_TAB)].map((m) => m[1]!)),
    uses: unique(Object.values(text).flatMap((code) => [...code.matchAll(USES)].map((m) => (m[1] ?? m[2])!))),
    owns: unique([...(text["server.ts"]?.match(OWNS)?.[1] ?? "").matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!)),
  };
}
// Run by bun itself: its script asks for node, which players may not have.
const TSC = join(import.meta.dir, "../node_modules/typescript/bin/tsc");

/** Checks only these mods' files and what they import, which reports the same errors in them as checking the whole tree. */
async function tsc(root: string, mods: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-tsconfig-"));
  try {
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ extends: join(root, "tsconfig.json"), include: mods.map((mod) => join(root, "mods", mod, "**/*.ts")) }));
    const proc = Bun.spawn([process.execPath, TSC, "-p", join(dir, "tsconfig.json"), "--pretty", "false"], { cwd: root, stdout: "pipe", stderr: "pipe" });
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
  private inFlight = new Map<string, Promise<Result>>();
  private followUp = new Map<string, { who: string; author: string; force: boolean; run: Promise<Result> }>();
  private slots = PARALLEL_RELOADS;
  private waitingForSlot: (() => void)[] = [];
  private commits: Promise<unknown> = Promise.resolve();
  sims!: Pick<Sims, "trial" | "apply" | "hasGame">;
  private awaitingKeys = new Map<string, () => void>();

  constructor(
    private root: string,
    private buildDir: string,
    private statePath: string,
    private events: ModEvents,
  ) {}

  list(): RunningMod[] {
    return [...this.running].map(([name, m]) => ({ name, id: m.id, server: m.build.server, game: m.build.game ?? null }));
  }

  gameOf(name: string) {
    return this.running.get(name)?.build.game ?? null;
  }

  /** The mod running in this game (its own or a shared one) whose reload went live within a minute, as the launcher finds for a crashed world. */
  reloadedJustBefore(game: string) {
    const recent = [...this.running].filter(([, m]) => m.at && Date.now() - m.at < 60_000 && (!m.build.game || m.build.game === game));
    return recent.sort(([, a], [, b]) => b.at! - a.at!)[0]?.[0];
  }

  names() {
    const dir = join(this.root, "mods");
    return existsSync(dir) ? readdirSync(dir).filter((n) => MOD_NAME.test(n)).sort() : [];
  }

  /** Restores exactly the builds that were live at shutdown; a fresh world builds its seed mods. */
  async loadAll(owners: Record<string, string>) {
    if (existsSync(this.statePath)) {
      // An imported world names its server builds relative to build/, wherever it was exported from.
      const here = (b: Build) => ({ ...b, server: b.server && resolve(this.buildDir, b.server) });
      const saved: Record<string, Mod> = JSON.parse(readFileSync(this.statePath, "utf8"));
      this.running = new Map(Object.entries(saved).map(([name, m]) => [name, { ...m, build: here(m.build), previous: m.previous.map(here), source: m.source ?? scan(join(this.root, "mods", name)) }]));
      this.nextId = Math.max(0, ...[...this.running.values()].map((m) => m.id)) + 1;
      return;
    }
    for (const name of this.names()) {
      const result = await this.build(name);
      if (typeof result === "string") this.events.feed(`${name} failed to load: ${result}`, "error");
      else this.running.set(name, { id: this.nextId++, author: owners[name] ?? "world", version: 1, build: result, previous: [], source: scan(join(this.root, "mods", name)) });
    }
    this.save();
  }

  private save() {
    writeFileSync(this.statePath, JSON.stringify(Object.fromEntries(this.running), null, 2));
  }

  /** One reload of a mod runs at a time; reloads asked for meanwhile become one follow-up of the latest files, and all their callers get its result. */
  reload(name: string, who: string, author: string, force = false): Promise<Result> {
    const next = this.followUp.get(name);
    if (next) {
      Object.assign(next, { who, author, force });
      return next.run;
    }
    const current = this.inFlight.get(name);
    if (!current) return this.start(name, who, author, force);
    const followUp = { who, author, force, run: null as unknown as Promise<Result> };
    followUp.run = current.catch(() => {}).then(() => {
      this.followUp.delete(name);
      return this.start(name, followUp.who, followUp.author, followUp.force);
    });
    this.followUp.set(name, followUp);
    return followUp.run;
  }

  private start(name: string, who: string, author: string, force: boolean) {
    const run = this.inSlot(() => this.doReload(name, who, author, force)).finally(() => this.inFlight.delete(name));
    this.inFlight.set(name, run);
    return run;
  }

  private async inSlot<T>(work: () => Promise<T>) {
    if (!this.slots) await new Promise<void>((r) => this.waitingForSlot.push(r));
    else this.slots--;
    try {
      return await work();
    } finally {
      const next = this.waitingForSlot.shift();
      if (next) next();
      else this.slots++;
    }
  }

  private async doReload(name: string, who: string, author: string, force: boolean): Promise<Result> {
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
      const game = current.build.game ?? null;
      void this.sims.apply({ name, id: current.id, server: null, game });
      this.events.client(name, null, game);
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
      if (ms[stage] === undefined) lap(stage);
      this.events.record("reload", who, { mod: name, ok: false, stage, ms: { ...ms, total: Math.round(performance.now() - started) }, report: report.slice(0, 500) });
      return this.fail(name, who, report);
    };
    // Which game a mod belongs to is read from its files, so a bad or unknown one fails before anything builds.
    const named = this.gameNamedBy(name);
    if ("error" in named) return reject("game", `${named.error} Nothing changed.`);
    if (named.game && !this.sims.hasGame(named.game))
      return reject("game", `${name} names the game ${named.game}, which doesn't exist. Create it with create_game first (list_games shows the games); nothing changed.`);
    // The typecheck runs alongside the build and the test run, and gates going live all the same.
    const typecheck = this.typecheck(name).then((result) => ((ms.typecheck = Math.round(performance.now() - started)), result));
    const typeErrors = async () => {
      const { own, dependents } = await typecheck;
      if (own) return reject("typecheck", `Type errors, nothing changed:\n${own}`);
      if (dependents)
        return reject(
          "typecheck",
          `This change breaks live mods that use ${name}, nothing changed. Keep ${name}'s exports compatible, or fix those mods in the same change and reload them after this one:\n${dependents}`,
        );
    };
    const source = scan(dir);
    const build = await this.build(name);
    if (typeof build === "string") return (await typeErrors()) ?? reject("build", `Build failed, nothing changed:\n${build}`);
    const game = build.game ?? null;
    const moved = game !== (current?.build.game ?? null);
    // Players' games keep the client they have, and the simulation the server it runs, when this change leaves it byte for byte the same.
    if (build.client && current?.build.client && sameFile(join(this.buildDir, build.client.slice("/build/".length)), join(this.buildDir, current.build.client.slice("/build/".length)))) build.client = current.build.client;
    if (build.server && current?.build.server && sameFile(build.server, current.build.server)) build.server = current.build.server;
    lap("build");

    const id = current?.id ?? this.nextId++;
    // A mod that moved to another game runs in other simulations, so it is tried and swapped even when its server is the same.
    const serverChanged = build.server !== current?.build.server || moved;
    const trial = build.server && serverChanged ? this.sims.trial({ name, id, server: build.server, game }) : null;
    const typeError = await typeErrors();
    if (typeError) return typeError;
    const error = await trial;
    if (error) return reject("trial", `Test run against a copy of the live world failed, nothing changed:\n${error}`);
    lap("trial");

    const version = (current?.version ?? 0) + 1;
    this.running.set(name, { id, author: current?.author ?? author, version, build, previous: current ? [...current.previous, current.build].slice(-5) : [], keys: current?.keys, source, at: Date.now() });
    this.save();
    const loadError = serverChanged ? await this.sims.apply({ name, id, server: build.server, game }) : null;
    lap("apply");
    // A mod that moved to another game leaves the old one's players even when its client stayed the same.
    if ((build.client !== current?.build.client || moved) && this.events.client(name, build.client, game) && build.client) await Promise.race([new Promise<void>((r) => this.awaitingKeys.set(name, r)), Bun.sleep(3000)]);
    this.awaitingKeys.delete(name);
    lap("keys");
    await this.commit(name, `${name} v${version}`, who);
    lap("commit");
    const total = Math.round(performance.now() - started);
    this.events.record("reload", who, { mod: name, ok: true, version, ms: { ...ms, total }, loadError: loadError?.slice(0, 500) });
    this.events.feed(`${who} reloaded ${name} v${version}`, "ok");
    const warning = loadError ? `\nBut its load hook threw on the live world:\n${loadError}` : "";
    return { ok: true, report: `${name} v${version} is live for everyone (${total} ms).${warning}${this.overlaps(name)}\nWatch \`logs\` for runtime errors: a mod that keeps throwing, is slow, or freezes the server gets reverted automatically.` };
  }

  /** A player's game (re)loaded these mods, which declared these keys. */
  reportKeys(declared: Record<string, Key[]>) {
    for (const [name, keys] of Object.entries(declared)) {
      const mod = this.running.get(name);
      if (mod) mod.keys = keys;
      this.awaitingKeys.get(name)?.();
    }
    this.save();
  }

  /** Which live mods read which keys and fill which menu tabs, found in their client code, and the keys they declared. */
  controls() {
    const keys: Record<string, string[]> = {};
    const menus: Record<string, string[]> = {};
    const declared: Record<string, { mod: string; label: string }[]> = {};
    for (const [name, mod] of this.running) {
      for (const k of mod.keys ?? []) (declared[k.code] ??= []).push({ mod: name, label: k.label });
      for (const key of mod.source?.keys ?? []) (keys[key] ??= []).push(name);
      for (const title of mod.source?.menus ?? []) (menus[title] ??= []).push(name);
    }
    return { keys, menus, declared };
  }

  /** Which live mods claim which systems, like hunger or inventory. */
  systems() {
    const owners: Record<string, string[]> = {};
    for (const [name, mod] of this.running) for (const system of mod.source?.owns ?? []) (owners[system] ??= []).push(name);
    return owners;
  }

  /** Keys this mod reads or declares that the engine or another mod already uses, as advice for whoever just reloaded it. */
  private overlaps(name: string) {
    const lines: string[] = [];
    const { keys, declared } = this.controls();
    for (const [key, list] of Object.entries(declared)) keys[key] = [...new Set([...(SHARED_KEYS.has(key) ? [] : (keys[key] ?? [])), ...list.map((d) => d.mod)])];
    for (const [key, users] of Object.entries(keys)) {
      if (!users.includes(name) || (SHARED_KEYS.has(key) && !declared[key])) continue;
      // Mods of two different games never run in the same player's game, so their keys can't clash.
      const others = users.filter((u) => u !== name && (!this.gameOf(u) || !this.gameOf(name) || this.gameOf(u) === this.gameOf(name)));
      if (key === "KeyE") lines.push("- KeyE: the engine owns E. Offer the action with ctx.interact instead, so players get one prompt for the nearest thing and E never fires two mods.");
      else if (ENGINE_KEYS[key]) lines.push(`- ${key}: the engine uses it for ${ENGINE_KEYS[key]}. Pick another key.`);
      else if (others.length) lines.push(`- ${key}: also used by ${others.join(", ")}. Pick a free key (status lists every key in use), or share the feature through that mod's exports.`);
    }
    for (const [system, owners] of Object.entries(this.systems())) {
      const others = owners.filter((o) => o !== name);
      if (owners.includes(name) && others.length)
        lines.push(`- ${system}: ${others.map((o) => `${o} by ${this.running.get(o)!.author}`).join(", ")} already owns it. Agree with its author which mod keeps ${system}, and build on that mod's exports, so players never get two.`);
    }
    return lines.length ? `\nControls and systems that overlap, fix these:\n${lines.join("\n")}` : "";
  }

  private fail(name: string, who: string, report: string) {
    this.events.feed(`${who}'s reload of ${name} was rejected`, "error");
    return { ok: false, report };
  }

  /** Called when a live mod misbehaves: fall back to its previous build, or unload it. */
  revert(name: string, error: string) {
    const mod = this.rollBack(name, error);
    if (!mod) return;
    const build = this.running.get(name)?.build;
    // Rolled back, the mod holds the build it went back to, or the one it was unloaded from; either names the game it runs in.
    const game = mod.build.game ?? null;
    void this.sims.apply({ name, id: mod.id, server: build?.server ?? null, game });
    this.events.client(name, build?.client ?? null, game);
  }

  /** Reverts a mod in the saved state only, as at startup before the simulation loads any mod. */
  rollBack(name: string, error: string) {
    const mod = this.running.get(name);
    if (!mod) return;
    this.events.record("error", null, { mod: name, revert: true, text: error.slice(0, 500) });
    const previous = mod.previous.pop();
    delete mod.at;
    if (previous) {
      mod.build = previous;
      mod.version++;
      this.events.feed(`${name} reverted to its previous version: ${error.split("\n")[0]}`, "error");
    } else {
      this.running.delete(name);
      this.events.feed(`${name} was unloaded: ${error.split("\n")[0]}`, "error");
    }
    this.save();
    return mod;
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
    if (hasGit) {
      const archive = Bun.spawn(["git", "archive", "HEAD", "--", `mods/${name}`], { cwd: this.root, stdout: "pipe", stderr: "ignore" });
      await Bun.spawn(["tar", "-x", "-C", dir, "--wildcards", "*.ts"], { stdin: archive.stdout, stderr: "ignore" }).exited;
    }
    return dir;
  }

  users(name: string) {
    return [...this.running].filter(([other, m]) => other !== name && m.source?.uses.includes(name)).map(([other]) => other);
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
    const named = this.gameNamedBy(name);
    if ("error" in named) return named.error;
    if (named.game) result.game = named.game;
    return result;
  }

  /** The game a mod's server.ts and client.ts name on their default exports; either may name it, but not two different ones. */
  private gameNamedBy(name: string): { game: string | null } | { error: string } {
    const games = new Set<string>();
    for (const side of ["server", "client"]) {
      const path = join(this.root, "mods", name, `${side}.ts`);
      if (!existsSync(path)) continue;
      const found = declaredGame(readFileSync(path, "utf8"));
      if ("error" in found) return { error: `mods/${name}/${side}.ts: ${found.error}.` };
      if (found.game) games.add(found.game);
    }
    if (games.size > 1) return { error: `server.ts and client.ts name different games (${[...games].join(", ")}); a mod belongs to one game.` };
    return { game: [...games][0] ?? null };
  }

  /** One at a time: git holds one lock on the index. */
  private commit(name: string, message: string, who: string) {
    if (!hasGit) return;
    const git = (...args: string[]) => Bun.spawn(["git", ...args], { cwd: this.root, stdout: "ignore", stderr: "ignore" }).exited;
    const done = this.commits.then(async () => {
      await git("add", "-A", `mods/${name}`);
      await git("commit", "-q", "-m", message, `--author=${who} <${who}@sandbox>`, "--", `mods/${name}`);
    });
    this.commits = done;
    return done;
  }
}
