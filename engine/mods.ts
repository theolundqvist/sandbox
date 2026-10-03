import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { boxRefusal } from "./box";
import { buildMod, buildSeed, type BuildSpent } from "./box/build";
import { Checker, type Overlay, type Spent } from "./box/checker";
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
const SEEDS = join(import.meta.dir, "seed/mods");
/** Reloads of different mods that run at once; each test run loads every server mod in its own process. */
const PARALLEL_RELOADS = 2;
/** The last line of a reload's report when its typecheck waited for the checker to start or warm up, as the first reload after the world starts does. */
const WARMING = "Warming up the type checker, first reload takes a few seconds";
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
/**
 * How the engine runs git on a world's history. A world may be a stranger's and bring its own .git, which import cuts down to history alone; on top of that, no hooks, no fsmonitor,
 * and none of this computer's git config, whose filters, attributes or programs a world's .gitattributes could otherwise set off.
 */
export const GIT = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.symlinks=false"];
export const GIT_ENV = { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0", ...(process.env.SYSTEMROOT && { SYSTEMROOT: process.env.SYSTEMROOT }) };
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
  /**
   * Why mod code can't run in the sandbox on this computer, or null when it can; then only the engine's unchanged seed mods run.
   * Asked afresh each time: a sandbox that fails partway stays failed, and every reload after that gets the same sentence.
   */
  private get refusal() {
    return boxRefusal();
  }
  /** Server builds this process made from the engine's own seed files, the only ones a computer without the sandbox runs. */
  private trusted = new Set<string>();
  /** The world's typecheck, kept running from its warm-up or first reload until close. */
  private checker: Checker;
  private closed = false;
  private warmUpStarted = false;

  constructor(
    private root: string,
    private buildDir: string,
    private statePath: string,
    private events: ModEvents,
  ) {
    this.checker = new Checker(root);
  }

  /** Stops the world's typecheck; reloads after this are refused. */
  close() {
    this.closed = true;
    return this.checker.close();
  }

  /**
   * Brings the world's typecheck up to date with every mod and package, starting it afresh after an install replaced the packages; resolves once it is warm, so the next reload doesn't pay for that.
   * Rejects when it couldn't start or check, its config included; the mods' own errors don't count.
   */
  warm() {
    return this.refusal ? Promise.resolve() : this.checker.warm();
  }

  /**
   * Starts the typecheck's warm-up in the background, the first time only; the server calls this when the hub first ticks, so the world opens and players join before the checker takes the CPU.
   * One that can't warm up is reported and the world runs anyway: every reload's check runs it again and is refused while it can't, and a mod can't keep its world down.
   * A warm-up the world's own stop cut short is no news, and none starts after it.
   */
  startWarmUp() {
    if (this.warmUpStarted || this.closed) return;
    this.warmUpStarted = true;
    void this.warm().catch((e) => {
      if (!this.closed) this.events.feed(`The typecheck couldn't start; each reload tries it again and is refused until it runs:\n${e instanceof Error ? e.message : String(e)}`, "error");
    });
  }

  list(): RunningMod[] {
    return [...this.running].map(([name, m]) => this.runAs(name, m.id, m.build));
  }

  /** A build as the simulations run it, marked trusted only when this process built it from the engine's seed files. */
  private runAs(name: string, id: number, build: Build | undefined): RunningMod {
    const server = build?.server ?? null;
    return { name, id, server, game: build?.game ?? null, ...(server !== null && this.trusted.has(server) && { trusted: true as const }) };
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

  /**
   * Restores exactly the builds that were live at shutdown; a fresh world builds its seed mods.
   * A saved build is used only when its server file is a plain file inside build/; any other (an imported world with doctored state) is built again from the mod's files.
   * Without the sandbox only the engine's unchanged seed mods load, built afresh from the engine's own files, since the saved builds are the world's.
   * Neither waits for the typecheck: the world opens and players join at once, its warm-up starts when the hub first ticks (startWarmUp), and the first reload waits for the warm-up and says so.
   */
  async loadAll(owners: Record<string, string>) {
    const refusal = this.refusal;
    if (refusal) this.events.feed(refusal, "error");
    await this.restore(owners, refusal);
  }

  private async restore(owners: Record<string, string>, refusal: string | null) {
    if (!existsSync(this.statePath)) {
      for (const name of this.names()) {
        if (refusal && !this.unchangedSeed(name)) continue;
        const result = await this.build(name);
        if (typeof result === "string") this.events.feed(`${name} failed to load: ${result}`, "error");
        else this.running.set(name, { id: this.nextId++, author: owners[name] ?? "world", version: 1, build: result, previous: [], source: scan(join(this.root, "mods", name)) });
      }
      this.save();
      return;
    }
    const saved: Record<string, Mod> = JSON.parse(readFileSync(this.statePath, "utf8"));
    const entries = Object.entries(saved).filter(([name, m]) => MOD_NAME.test(name) && typeof m?.id === "number" && typeof m.build === "object" && m.build);
    this.nextId = Math.max(0, ...entries.map(([, m]) => m.id)) + 1;
    let rebuilt = false;
    for (const [name, m] of entries) {
      const build = refusal ? null : this.restored(m.build);
      const previous = refusal || !Array.isArray(m.previous) ? [] : m.previous.flatMap((b) => this.restored(b) ?? []);
      if (build) {
        this.running.set(name, { ...m, build, previous, source: m.source ?? scan(join(this.root, "mods", name)) });
        continue;
      }
      if (refusal && !this.unchangedSeed(name)) continue;
      rebuilt = true;
      const result = await this.build(name);
      if (typeof result === "string") this.events.feed(`${name} failed to load: ${result}`, "error");
      else this.running.set(name, { ...m, build: result, previous, source: scan(join(this.root, "mods", name)) });
    }
    if (rebuilt) this.save();
  }

  /** A saved build the simulations may be given: its server a plain file inside build/, named by its real path (an imported world names it relative to build/), and its client a /build/ path. Null for anything else. */
  private restored(build: Build): Build | null {
    const { server, client } = build;
    if (client !== null && (typeof client !== "string" || !client.startsWith("/build/") || client.split("/").includes(".."))) return null;
    if (build.game !== undefined && typeof build.game !== "string") return null;
    if (server === null) return build;
    if (typeof server !== "string") return null;
    try {
      const path = realpathSync(resolve(this.buildDir, server));
      return path.startsWith(realpathSync(this.buildDir) + sep) && lstatSync(path).isFile() ? { ...build, server: path } : null;
    } catch {
      return null;
    }
  }

  /** Whether a mod's folder is one of the engine's seed mods exactly, file for file and byte for byte. What the world's own seeded.json says doesn't count. */
  private unchangedSeed(name: string) {
    const seed = join(SEEDS, name);
    const mine = join(this.root, "mods", name);
    if (!MOD_NAME.test(name) || !existsSync(seed) || !existsSync(mine) || !lstatSync(mine).isDirectory()) return false;
    const theirs = readdirSync(seed, { recursive: true, encoding: "utf8" }).sort();
    const ours = readdirSync(mine, { recursive: true, encoding: "utf8" }).sort();
    return (
      theirs.length === ours.length &&
      theirs.every((file, i) => {
        if (file !== ours[i]) return false;
        const stat = lstatSync(join(mine, file));
        return lstatSync(join(seed, file)).isDirectory() ? stat.isDirectory() : stat.isFile() && readFileSync(join(seed, file)).equals(readFileSync(join(mine, file)));
      })
    );
  }

  private save() {
    // Without the sandbox the world runs a cut-down set of mods; its saved state stays as it was, for a computer that has one.
    if (this.refusal) return;
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
    // Where the typecheck's and the build's time went, for the reload's record; the typecheck's also tells whether it waited for the checker to warm up.
    const checked: Spent = { wait: 0, run: 0, ipc: 0, warming: false };
    const built: BuildSpent = { boot: 0, bundle: 0, box: 0 };
    const reject = (stage: string, report: string) => {
      if (ms[stage] === undefined) lap(stage);
      this.events.record("reload", who, { mod: name, ok: false, stage, ms: { ...ms, total: Math.round(performance.now() - started) }, report: report.slice(0, 500) });
      // A reload that waited for the typecheck to warm up says so, whatever came of it; a refusal stays the one sentence.
      return this.fail(name, who, checked.warming && stage !== "sandbox" ? `${report}\n${WARMING}` : report);
    };
    // A sandbox that fails partway refuses this reload, and every later one but an unchanged seed mod's, with the same sentence as one that never worked.
    const refused = () => {
      const refusal = this.refusal;
      return refusal && !this.unchangedSeed(name) ? reject("sandbox", refusal) : null;
    };
    const refusedNow = refused();
    if (refusedNow) return refusedNow;
    // Which game a mod belongs to is read from its files, so a bad or unknown one fails before anything builds.
    const named = this.gameNamedBy(name);
    if ("error" in named) return reject("game", `${named.error} Nothing changed.`);
    if (named.game && !this.sims.hasGame(named.game))
      return reject("game", `${name} names the game ${named.game}, which doesn't exist. Create it with create_game first (list_games shows the games); nothing changed.`);
    // The typecheck runs alongside the build and the test run, and gates going live all the same.
    const typecheck = this.typecheck(name, checked).then((result) => {
      Object.assign(ms, { typecheck: Math.round(performance.now() - started), checkWait: Math.round(checked.wait), checkRun: Math.round(checked.run), checkIpc: Math.round(checked.ipc) });
      return result;
    });
    const typeErrors = async () => {
      const { own, dependents, error } = await typecheck;
      if (error) return refused() ?? reject("typecheck", `The typecheck couldn't run, nothing changed:\n${error}`);
      if (own) return reject("typecheck", `Type errors, nothing changed:\n${own}`);
      if (dependents)
        return reject(
          "typecheck",
          `This change breaks live mods that use ${name}, nothing changed. Keep ${name}'s exports compatible, or fix those mods in the same change and reload them after this one:\n${dependents}`,
        );
    };
    const source = scan(dir);
    const build = await this.build(name, built);
    if (typeof build === "string") return refused() ?? (await typeErrors()) ?? reject("build", `Build failed, nothing changed:\n${build}`);
    const game = build.game ?? null;
    const moved = game !== (current?.build.game ?? null);
    // Players' games keep the client they have, and the simulation the server it runs, when this change leaves it byte for byte the same.
    if (build.client && current?.build.client && sameFile(join(this.buildDir, build.client.slice("/build/".length)), join(this.buildDir, current.build.client.slice("/build/".length)))) build.client = current.build.client;
    if (build.server && current?.build.server && sameFile(build.server, current.build.server)) build.server = current.build.server;
    lap("build");
    Object.assign(ms, { buildBoot: Math.round(built.boot), buildBundle: Math.round(built.bundle), buildBox: Math.round(built.box) });

    const id = current?.id ?? this.nextId++;
    // A mod that moved to another game runs in other simulations, so it is tried and swapped even when its server is the same.
    const serverChanged = build.server !== current?.build.server || moved;
    const trialStarted = performance.now();
    const trial = build.server && serverChanged ? this.sims.trial(this.runAs(name, id, build)).then((error) => ((ms.trialRun = Math.round(performance.now() - trialStarted)), error)) : null;
    const typeError = await typeErrors();
    if (typeError) return typeError;
    const error = await trial;
    if (error) return refused() ?? reject("trial", `Test run against a copy of the live world failed, nothing changed:\n${error}`);
    lap("trial");

    const version = (current?.version ?? 0) + 1;
    this.running.set(name, { id, author: current?.author ?? author, version, build, previous: current ? [...current.previous, current.build].slice(-5) : [], keys: current?.keys, source, at: Date.now() });
    this.save();
    const loadError = serverChanged ? await this.sims.apply(this.runAs(name, id, build)) : null;
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
    return {
      ok: true,
      report: `${name} v${version} is live ${game ? `in the game ${game}` : "for everyone"} (${total} ms).${warning}${this.overlaps(name)}\nWatch \`logs\` for runtime errors: a mod that keeps throwing, is slow, or freezes the server gets reverted automatically.${checked.warming ? `\n${WARMING}` : ""}`,
    };
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
    void this.sims.apply({ ...this.runAs(name, mod.id, build), game });
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

  /** Type errors in the mod itself, and new ones its change causes in live mods that use it (a type import of its files or a use("<name>") call); error when the typecheck couldn't check them. Its time is added to spent. */
  private async typecheck(name: string, spent: Spent): Promise<{ own: string; dependents: string; error?: string }> {
    // Without the sandbox only the engine's seed mods run, which were checked with the engine.
    if (this.refusal) return { own: "", dependents: "" };
    const users = this.users(name);
    const errorsIn = (diagnostics: string[], mods: string[]) => diagnostics.filter((d) => mods.some((mod) => d.startsWith(`mods/${mod}/`)));
    try {
      const diagnostics = await this.checker.check([name, ...users], undefined, spent);
      let dependents = errorsIn(diagnostics, users);
      // Errors those mods have without this change, like their own unfinished edits, are not this change's doing.
      if (dependents.length) {
        const old = new Set(errorsIn(await this.checker.check(users, await this.accepted(name), spent), users));
        dependents = dependents.filter((d) => !old.has(d));
      }
      return { own: errorsIn(diagnostics, [name]).join("\n"), dependents: dependents.join("\n") };
    } catch (e) {
      return { own: "", dependents: "", error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** This mod's code as it was last accepted, which a typecheck sees in place of its folder: none without a history. */
  private async accepted(name: string): Promise<Overlay> {
    const files: Record<string, string> = {};
    if (!hasGit) return { mod: name, files };
    // History may be a stranger's, so only its plain .ts files come out.
    const git = async (args: string[]) => {
      const proc = Bun.spawn([...GIT, ...args], { cwd: this.root, env: GIT_ENV, stdout: "pipe", stderr: "ignore" });
      const out = await new Response(proc.stdout).bytes();
      await proc.exited;
      return new TextDecoder().decode(out);
    };
    const listing = await git(["ls-tree", "-r", "-z", "HEAD", "--", `mods/${name}`]);
    for (const row of listing.split("\0")) {
      const [, mode, type, hash, path] = row.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s) ?? [];
      if (type !== "blob" || (mode !== "100644" && mode !== "100755") || !path?.endsWith(".ts") || !path.startsWith(`mods/${name}/`) || path.split("/").includes("..")) continue;
      files[path] = await git(["cat-file", "blob", hash!]);
    }
    return { mod: name, files };
  }

  users(name: string) {
    return [...this.running].filter(([other, m]) => other !== name && m.source?.uses.includes(name)).map(([other]) => other);
  }

  /**
   * Bundles a mod in the sandbox, filling in spent. An unchanged seed mod builds here instead, from the engine's own copy, which is all its build reads: the world's files only count as equal to it.
   * Without the sandbox only those build, and their server builds are the one kind this process trusts. Whether the sandbox works is read once, so a build is never trusted, nor a changed mod built as its seed, when it fails partway.
   */
  private async build(name: string, spent?: BuildSpent): Promise<Build | string> {
    const dir = join(this.root, "mods", name);
    if (!existsSync(join(dir, "server.ts")) && !existsSync(join(dir, "client.ts"))) return `mods/${name}/ needs a server.ts or a client.ts`;
    const refusal = this.refusal;
    const seed = this.unchangedSeed(name);
    if (refusal && !seed) return refusal;
    const out = join(this.buildDir, name, `${Date.now().toString(36)}`);
    const built = seed ? await buildSeed(join(SEEDS, name), out) : await buildMod(this.root, dir, out, spent);
    if (typeof built === "string") return built;
    const result: Build = { server: built.server ?? null, client: built.client ? `/build/${relative(this.buildDir, built.client).split(sep).join("/")}` : null };
    if (refusal && result.server) this.trusted.add(result.server);
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
    const git = (...args: string[]) => Bun.spawn([...GIT, ...args], { cwd: this.root, env: GIT_ENV, stdout: "ignore", stderr: "ignore" }).exited;
    const done = this.commits.then(async () => {
      await git("add", "-A", `mods/${name}`);
      await git("commit", "-q", "-m", message, `--author=${who} <${who}@sandbox>`, "--", `mods/${name}`);
    });
    this.commits = done;
    return done;
  }
}
