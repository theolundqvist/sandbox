import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Entity, Game } from "./api";
import type { Seat } from "./client/games";
import { cardError, GameRegistry, Seats, type GameCard, type Vec3 } from "./games";
import { SimHost, type Correction, type Perf, type RunningMod } from "./simhost";
import { openStore, type Diff } from "./world";

/** A game's simulation, its save, and the timer that stops it once nobody is in it. */
type GameRun = { host: SimHost; store: ReturnType<typeof openStore>; idle: Timer | null };

/** How long a game nobody is in keeps running, so someone popping out and back finds it as they left it. */
const IDLE_MS = Number(process.env.SANDBOX_GAME_IDLE_MS ?? 60_000);
/** A switch whose new game never sends its first tick lifts the cover anyway. */
const SWITCH_MS = 20_000;

export type SimsEvents = {
  /** One player's or spectator's tick stream. */
  deliver(id: string, text: string): void;
  /** A message to one player's game. */
  notify(id: string, msg: object): void;
  /** The client builds a player in this game loads: the shared mods and the game's own. */
  clientMods(game: string | null): { name: string; url: string }[];
  log(mod: string, level: string, text: string): void;
  fault(mod: string, error: string): void;
  unavailable(reason: string): void;
  /** The mod whose reload a game's process crashed right after, which is undone as a crashed world's would be. */
  reloadedJustBefore(game: string): string | undefined;
  /** The hub's changes, which the world's own save and timelapse record. */
  hubTick(diff: Diff): void;
  /** The games, or who is in which, changed. */
  changed(): void;
};

const isVec = (v: unknown): v is number[] => Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(Number.isFinite);

/** The world's simulations: the hub, which runs the shared mods for players in no game, and one process per game with players in it. */
export class Sims {
  readonly hub: SimHost;
  readonly games: GameRegistry;
  readonly seats: Seats;
  private runs = new Map<string, GameRun>();
  /** The game each connected player is in; null is the hub. */
  private at = new Map<string, string | null>();
  /** Players on their way to a game, until its first tick reaches them or the switch times out. */
  private switching = new Map<string, { game: string | null; timer: Timer }>();

  constructor(
    private data: string,
    private dbDir: string,
    private mods: () => RunningMod[],
    private on: SimsEvents,
  ) {
    this.games = new GameRegistry(join(data, "games.json"));
    this.seats = new Seats(join(data, "seats.json"));
    this.hub = this.host(null);
    setInterval(() => {
      for (const run of this.running()) run.store.save(run.host);
    }, 5000);
    // Recording moments keeps each save's pending changes from growing while nobody reads a game's timelapse.
    setInterval(() => {
      for (const run of this.running()) run.store.record(run.host, []);
    }, 2000);
  }

  private host(game: string | null) {
    return new SimHost(
      this.dbDir,
      () => this.mods().filter((m) => !m.game || m.game === game),
      {
        tick: (outs, diff) => {
          if (game === null) this.on.hubTick(diff);
          else this.runs.get(game)?.store.track(diff);
          for (const [id, text] of Object.entries(outs)) {
            // Ticks still in flight from a game the player just left never reach them.
            if ((this.at.get(id) ?? null) !== game) continue;
            this.on.deliver(id, text);
            if (this.switching.get(id)?.game === game) this.arrived(id);
          }
        },
        log: (mod, level, text) => this.on.log(mod, level, text),
        fault: (mod, error) => this.on.fault(mod, error),
        unavailable: (reason) => this.on.unavailable(reason),
        // A mod's request from a game the player already left is stale: they are elsewhere now.
        enter: (player, to) => void (this.at.has(player) && this.at.get(player) === game && this.enter(player, to)),
        crashSuspect: () => (game === null ? undefined : this.on.reloadedJustBefore(game)),
      },
      game,
      () => this.games.list().map((g) => g.id),
    );
  }

  private running() {
    return [...this.runs.values()].filter((run) => run.host.running);
  }

  private run(game: string) {
    let run = this.runs.get(game);
    if (!run) {
      const dir = join(this.data, "games", game);
      mkdirSync(dir, { recursive: true });
      run = { host: this.host(game), store: openStore(join(dir, "world.sqlite")), idle: null };
      this.runs.set(game, run);
    }
    return run;
  }

  /** A game's simulation, started from its save when nobody was in it; a crashed one waiting out its backoff starts on its own. */
  private wake(game: string) {
    const run = this.run(game);
    if (run.idle) clearTimeout(run.idle);
    run.idle = null;
    if (!run.host.running) {
      run.store.load(run.host);
      run.host.start();
    }
    return run.host;
  }

  /** A game nobody is in saves and stops after a while; anyone entering before then finds it running. */
  private idleCheck(game: string | null) {
    const run = game === null ? undefined : this.runs.get(game);
    if (!run?.host.running || run.host.players.size || run.idle) return;
    run.idle = setTimeout(() => {
      run.idle = null;
      if (run.host.players.size) return;
      run.store.save(run.host);
      run.host.stop();
      this.on.changed();
    }, IDLE_MS);
  }

  private hostOf(game: string | null) {
    return game === null ? this.hub : this.wake(game);
  }

  /** Where a player appears in a game: where they left it, else its spawn, else wherever its mods put them. */
  private placement(id: string, game: string | null): Vec3 | undefined {
    return game === null ? undefined : (this.seats.get(id).lastPos[game] ?? this.games.get(game)?.spawn);
  }

  /** Keeps where a player's avatar stood in the game they are leaving. */
  private remember(id: string, game: string | null, host: SimHost) {
    if (game === null) return;
    for (const e of host.entities.values())
      if (e.player === id && isVec(e.pos)) return this.seats.update(id, (seat) => void (seat.lastPos[game] = [e.pos[0], e.pos[1], e.pos[2]]));
  }

  private arrived(id: string) {
    const { game, timer } = this.switching.get(id)!;
    clearTimeout(timer);
    this.switching.delete(id);
    this.on.notify(id, { t: "gameSwitch", game, phase: "done" });
  }

  // ---------- players ----------
  /** A player opened the world: they go back into the game they were last in. */
  join(id: string) {
    const game = this.gameOf(id);
    this.at.set(id, game);
    this.hostOf(game).send({ t: "join", player: { id, name: id, game }, at: this.placement(id, game) });
    this.on.changed();
  }

  leave(id: string) {
    const game = this.at.get(id);
    if (game === undefined) return;
    this.at.delete(id);
    clearTimeout(this.switching.get(id)?.timer);
    this.switching.delete(id);
    const host = this.hostOf(game);
    this.remember(id, game, host);
    host.send({ t: "leave", id });
    this.idleCheck(game);
    this.on.changed();
  }

  message(id: string, mod: string, msg: unknown) {
    const game = this.at.get(id);
    if (game !== undefined) this.hostOf(game).send({ t: "msg", id, mod, msg });
  }

  resync(id: string) {
    this.hostOf(this.at.get(id) ?? null).resync(id);
  }

  /** The game a player is in, or was in when they left and goes back to when they join. */
  gameOf(id: string): string | null {
    if (this.at.has(id)) return this.at.get(id)!;
    const seated = this.seats.get(id).game;
    return seated && this.games.get(seated) ? seated : null;
  }

  /**
   * Moves a connected player into a game, or with null into the hub: the old game's mods see them go, the new one's see them come,
   * and their screen swaps mods under a cover until the new game's first tick. Returns why it couldn't, or null.
   */
  enter(id: string, to: string | null): string | null {
    const from = this.at.get(id);
    if (from === undefined) return `${id} isn't in the world.`;
    if (to !== null && !this.games.get(to)) return `There is no game ${to}.`;
    if (this.switching.has(id)) return `${id} is already on the way to another game.`;
    if (to === from) {
      this.on.notify(id, { t: "gameSwitch", game: to, phase: "done" });
      return null;
    }
    this.on.notify(id, { t: "gameSwitch", game: to, phase: "start", mods: this.on.clientMods(to) });
    const old = this.hostOf(from);
    this.remember(id, from, old);
    old.send({ t: "leave", id, switched: true });
    this.at.set(id, to);
    this.seats.update(id, (seat) => void (seat.game = to));
    // The timeout goes with this switch, so it never ends a later one.
    this.switching.set(id, { game: to, timer: setTimeout(() => this.arrived(id), SWITCH_MS) });
    this.hostOf(to).send({ t: "join", player: { id, name: id, game: to }, switched: true, at: this.placement(id, to) });
    this.idleCheck(from);
    this.on.changed();
    return null;
  }

  players(game: string | null) {
    return [...this.at].filter(([, g]) => g === game).map(([id]) => id);
  }

  /** Every player the world remembers or has online, and the game each is in. */
  seatList(): Seat[] {
    const names = new Set([...this.seats.players(), ...this.at.keys()]);
    return [...names].sort().map((name) => ({ player: name, name, game: this.gameOf(name), online: this.at.has(name) }));
  }

  // ---------- games ----------
  createGame(card: GameCard, who: string): Game | string {
    const error = cardError(card, false);
    if (error) return error;
    if (this.games.get(card.id)) return `There is already a game ${card.id}; change it with edit_game.`;
    const game = this.games.create(card, who);
    this.gamesChanged();
    return game;
  }

  editGame(id: string, fields: Partial<GameCard>): Game | string {
    if (!this.games.get(id)) return `There is no game ${id}.`;
    const error = cardError(fields, true);
    if (error) return error;
    const game = this.games.edit(id, fields);
    this.on.changed();
    return game;
  }

  /** Only a game no live mod names can go; whoever is in it goes back to the hub, and its save goes with it. */
  deleteGame(id: string): string | null {
    if (!this.games.get(id)) return `There is no game ${id}.`;
    const naming = this.mods().filter((m) => m.game === id).map((m) => m.name);
    if (naming.length) return `Live mods name the game ${id}: ${naming.join(", ")}. Remove them or move them to another game first.`;
    for (const player of this.players(id)) {
      clearTimeout(this.switching.get(player)?.timer);
      this.switching.delete(player);
      this.enter(player, null);
    }
    const run = this.runs.get(id);
    if (run) {
      if (run.idle) clearTimeout(run.idle);
      run.host.stop();
      run.store.close();
      this.runs.delete(id);
    }
    rmSync(join(this.data, "games", id), { recursive: true, force: true });
    this.games.remove(id);
    this.seats.forget(id);
    this.gamesChanged();
    return null;
  }

  private gamesChanged() {
    const ids = this.games.list().map((g) => g.id);
    for (const host of [this.hub, ...this.running().map((r) => r.host)]) host.send({ t: "games", ids });
    this.on.changed();
  }

  /** Each game's card with its mods, who is in it, and its process while it runs. */
  summary() {
    return this.games.list().map((g) => {
      const host = this.runs.get(g.id)?.host;
      return { ...g, mods: this.mods().filter((m) => m.game === g.id).map((m) => m.name), players: this.players(g.id), running: !!host?.running, pid: host?.pid ?? null };
    });
  }

  // ---------- mods ----------
  hasGame(id: string) {
    return !!this.games.get(id);
  }

  /** Test-runs a mod against the worlds it will run in: its game's, or for a shared mod the hub's and every running game's. */
  async trial(mod: RunningMod): Promise<string | null> {
    if (mod.game) return this.withWorld(mod.game, (host) => host.trial(mod));
    const games = [...this.runs].filter(([, run]) => run.host.running);
    const errors = await Promise.all([this.hub.trial(mod), ...games.map(([game, run]) => run.host.trial(mod).then((e) => e && `in the game ${game}: ${e}`))]);
    return errors.find((e) => e) ?? null;
  }

  /** Swaps a mod in wherever it runs now and out of every simulation it no longer belongs in; a stopped game loads it when it wakes. Resolves to its load hook's first error. */
  async apply(mod: RunningMod): Promise<string | null> {
    const hosts = [this.hub, ...this.running().map((r) => r.host)];
    const errors = await Promise.all(
      hosts.map((host) => {
        if (!mod.game || mod.game === host.game) return host.apply(mod);
        host.send({ t: "mod", ...mod, server: null });
        return null;
      }),
    );
    // The picker shows which games have mods yet.
    if (this.games.list().length) this.on.changed();
    return errors.find((e) => e) ?? null;
  }

  /** Runs fn against a game's live simulation, or, while nobody is in it, against its save loaded for the call. */
  private async withWorld<T>(game: string, fn: (host: SimHost) => Promise<T>) {
    const run = this.run(game);
    if (run.host.running) return fn(run.host);
    run.store.load(run.host);
    try {
      return await fn(run.host);
    } finally {
      if (!run.host.running) {
        run.host.entities.clear();
        run.host.creators.clear();
      }
    }
  }

  // ---------- tools ----------
  /** The live entities of a game or the hub; a game nobody is in answers from its save. */
  entities(game: string | null): Map<number, Entity> {
    if (game === null) return this.hub.entities;
    const run = this.run(game);
    if (run.host.running) return run.host.entities;
    const saved = { entities: new Map<number, Entity>(), nextId: 1 };
    run.store.load(saved);
    return saved.entities;
  }

  /** A running simulation of a game or the hub, woken for a tool that needs its physics; it stops again once idle. */
  awake(game: string | null) {
    const host = this.hostOf(game);
    this.idleCheck(game);
    return host;
  }

  corrections(): Correction[] {
    return [this.hub, ...[...this.runs.values()].map((r) => r.host)].flatMap((h) => h.corrections).sort((a, b) => a.at - b.at);
  }

  /** Tick times of each running game. */
  perfByGame(): Record<string, Perf | null> {
    return Object.fromEntries([...this.runs].filter(([, run]) => run.host.running).map(([game, run]) => [game, run.host.perf]));
  }

  saveAll() {
    for (const run of this.running()) run.store.save(run.host);
  }
}
