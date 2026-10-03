import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { install } from "./box/packages";
import { download, EgressError } from "./egress";
import { GIT, GIT_ENV, hasGit, type Mods } from "./mods";
import { brief, type Recorder } from "./record";
import type { GameCard } from "./games";
import type { Sims } from "./sims";
import { PlaytestError, type playtests } from "./playtest";
import { communityClient } from "./modshare";

export type Task = { title: string; status: string; percent?: number; state: "working" | "done" | "blocked"; at: number };
const speaker = (who: string) => `${who}'s agent`;

export type CliContext = {
  /** The world's folder: its config, players, mods' databases and the tree under root. */
  data: string;
  root: string;
  dbDir: string;
  rules: () => "open" | "additive";
  owners: Record<string, string>;
  saveOwners(): void;
  mods: Mods;
  sims: Sims;
  logs: { at: number; mod: string; level: string; text: string; player?: string }[];
  feed(text: string, kind?: string): void;
  chat(from: string, text: string, how?: "claudes"): void;
  chatLog: { seq: number; from: string; text: string; spoken?: boolean; claudes?: boolean; game?: string }[];
  nextChat(): Promise<void>;
  presence(who: string, state: "listening" | "working" | "offline"): void;
  setTask(who: string, task: Task): void;
  announce(a: { mod: string; by: string; title: string; text: string; color: string; vote: boolean }): void;
  status(): object;
  perf(): object;
  screenshot(who: string): Promise<string>;
  playtest: ReturnType<typeof playtests>;
  /** Sends a message to the player's open game; false if they don't have it open. */
  sendToGame(who: string, msg: object): boolean;
  record: Recorder;
};

/** Longest chat line a Claude may show players: 95% of what Claudes said to players in a busy session fit. */
const SAY_MAX = 400;
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 12);

const GAME_PARAM = { type: "string", description: "Which game's simulation: a game id, or empty (game=) for the world's own hub. Default: the game your player is in." };
/** One entry per field a Claude sets, checked against the Game type so a new field can't be left out. */
const GAME_CARD: Record<Exclude<keyof GameCard, "id">, object> = {
  title: { type: "string", description: "At most 40 characters." },
  tagline: { type: "string", description: "One line under the title, at most 160 characters." },
  color: { type: "string", description: "The card's base CSS colour, e.g. #1d6b4f." },
  accent: { type: "string", description: "A second CSS colour for the card." },
  status: { type: "string", enum: ["live", "early", "building"], description: "LIVE, EARLY ACCESS or BEING BUILT on the card; default building." },
  order: { type: "number", description: "Picker order, lowest first, then by title." },
  spawn: { type: "array", items: { type: "number" }, description: "Where a player first appears in the game, [x, y, z]; afterwards they come back where they left it." },
  art: { type: "string", description: "A client mod whose default export has paintCard(canvas, t) to paint the card; t is seconds." },
};
const CARD_FIELDS = Object.keys(GAME_CARD) as (keyof typeof GAME_CARD)[];

const BANNER = {
  title: { type: "string", description: "1 to 4 words, like a game mode name: LOW GRAVITY, THE FLOOR IS LAVA." },
  text: { type: "string", description: "One short line telling players what to try or watch out for." },
  color: { type: "string", description: "A #hex colour that fits the mod's mood." },
};

const tools = [
  {
    name: "status",
    description: "World name, rules, who is online, running mods with authors, versions and who uses them, which mods hold each key and menu tab, and recent activity. Start here, and check it again before building anything that touches a system that exists.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_files",
    description: "List every file in the shared world tree with its hash. GUIDE.md explains how mods work; api.ts is the mod API.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_file",
    description: "Read a file. The first line is `hash: <hash>`; pass that hash as base_hash when you change the file.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file under mods/<mod>/. Other players' Claudes edit the same tree, so overwriting an existing file needs the base_hash you read; if someone changed it since, the write is rejected and you must re-read. Changes go live only when you call reload.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" }, base_hash: { type: "string", description: "Hash from read_file. Omit only for new files." } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace one exact occurrence of old_string with new_string in a file under mods/<mod>/, guarded by base_hash like write_file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        base_hash: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string", "base_hash"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file under mods/<mod>/, guarded by base_hash. Delete a mod's whole folder contents, then reload it, to remove the mod.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, base_hash: { type: "string" } }, required: ["path", "base_hash"] },
  },
  {
    name: "add_asset",
    description:
      "Add a model, texture, sound or other file to mods/<mod>/assets/<name>, from a url the server downloads or from base64. It is live immediately: client code loads it from ctx.asset(\"<name>\") (or \"<other-mod>/<name>\"). Max 20 MB.",
    inputSchema: {
      type: "object",
      properties: { mod: { type: "string" }, name: { type: "string", description: "File name, e.g. dragon.glb" }, url: { type: "string" }, base64: { type: "string" } },
      required: ["mod", "name"],
    },
  },
  {
    name: "reload",
    description:
      "Put a mod live for every player without disconnecting anyone: typechecks it, builds it, test-runs it against a copy of the live world, then hot-swaps server and client code. If any step fails nothing changes and you get the error. Reloads of a mod asked for while one runs go live together as one reload of the latest files; read logs rather than reloading to look. Pass announce only for a new thing to play that you already checked; otherwise reload without it and call announce once the task is done. Fixes and tweaks go without it and show in the feed. New mods get a banner with their name if you leave it out.",
    inputSchema: {
      type: "object",
      properties: {
        mod: { type: "string" },
        announce: { type: "object", description: "The banner every player sees when this goes live.", properties: BANNER, required: ["title"] },
        force: {
          type: "boolean",
          description: "Only for removing a mod whose files you deleted: unload it even though live mods still use it. Tell their owners first.",
        },
      },
      required: ["mod"],
    },
  },
  {
    name: "logs",
    description: "Recent console output and errors from server mods and from every player's game (their client mods' console.log/warn/error and crashes). Filter by mod, or by player to see one game, e.g. your own player's. Check it after every reload, before you mark anything done.",
    inputSchema: { type: "object", properties: { mod: { type: "string" }, player: { type: "string" }, limit: { type: "number" } } },
  },
  {
    name: "perf",
    description: "Why is the game slow? Server cost per mod (average, p95 and slowest ms per 50 ms tick) and, for every player's game, fps, slowest frames, ms per frame spent in each client mod and in drawing, draw calls, triangles, scene objects, the geometries and textures each mod created and has not disposed, network ping and download rate, memory and GPU. Games report every 2 seconds. joins has each player's last wait for the first frame and the mods that took longest to start.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "corrections",
    description:
      "Invisible walls and snap-backs: every time a server mod put a player somewhere other than where their own game or another mod had just moved them (clamped to bounds, pushed back, teleported), with the mod and hook responsible, newest last. repeats counts further corrections of that player by that mod within the second before.",
    inputSchema: { type: "object", properties: { player: { type: "string" }, mod: { type: "string" }, limit: { type: "number" } } },
  },
  {
    name: "walk_test",
    description:
      "Can a player walk from A to B? Walks a test body in a straight line at 4 m/s with gravity through the live server physics, from one feet position toward another, and says whether it arrived, fell, or where it got stopped and by what: the solid entity (its box, whether it has a mesh, which mod spawned it) or a mod's terrain. Only solid entities and physics.ground terrain block it; a mod that moves players its own way is not simulated, so check corrections for those.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "array", items: { type: "number" }, description: "Feet position [x, y, z]." },
        to: { type: "array", items: { type: "number" }, description: "Feet position [x, y, z], at most 500 m away." },
        body: { type: "object", description: "radius, height and step of the walker; defaults 0.35, 1.8 and 0.45." },
        game: GAME_PARAM,
      },
      required: ["from", "to"],
    },
  },
  {
    name: "colliders",
    description: "Show or hide the solid boxes players collide with, as wireframes in your player's game: red for boxes nothing draws (invisible walls), green for drawn ones. Terrain from physics.ground is not shown.",
    inputSchema: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] },
  },
  {
    name: "activity",
    description:
      "What happened in this world, from its record kept for 14 days: every Claude's tool calls, all chat, players joining, leaving and what they did, reloads with typecheck, build and test timings, errors, and server and game performance every 10 seconds. By default a digest: slowest tool calls, reload times, error counts, tick and frame times. summary: false returns the rows, newest last.",
    inputSchema: {
      type: "object",
      properties: {
        minutes: { type: "number", description: "How far back, default 60." },
        who: { type: "string", description: "One player or Claude." },
        kind: { type: "string", description: "Comma list of tool, chat, claude, session, action, reload, error, server, client, proxy, exit." },
        summary: { type: "boolean" },
        limit: { type: "number", description: "Rows when summary is false, default 200." },
      },
    },
  },
  {
    name: "query_world",
    description: "Read live entities that have all the given components, e.g. [\"player\", \"pos\"]. solidWithoutModel counts the solid entities nothing draws, by mod: players see them as orange wireframes.",
    inputSchema: {
      type: "object",
      properties: {
        components: { type: "array", items: { type: "string" } },
        limit: { type: "number" },
        wait: { type: "number", description: "Seconds to wait for the answer to change, at most 60, instead of asking again and again: returns as soon as it differs from what it was when you called." },
        game: GAME_PARAM,
      },
    },
  },
  {
    name: "list_games",
    description: "The games played inside this world, each with its picker card, the live mods that belong to it and who is in it. A world with no games is one game of its own.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_game",
    description:
      "Add a game to the world's games picker. Players pick it and play it in its own simulation, with its own save, running the shared mods (those without a game field) plus the mods whose default export says game: \"<id>\" in server.ts and/or client.ts. It shows as COMING SOON until it has mods or a status other than building.",
    inputSchema: {
      type: "object",
      properties: {
        ...GAME_CARD,
        id: { type: "string", description: "Lowercase letters, digits and dashes, starting with a letter; never changes. Mods name it with game: \"<id>\"." },
      },
      required: ["id", "title", "tagline", "color"],
    },
  },
  {
    name: "edit_game",
    description: "Change a game's picker card: pass only the fields to change. Any Claude can edit any game.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, ...GAME_CARD }, required: ["id"] },
  },
  {
    name: "delete_game",
    description: "Remove a game and its save. Refused while live mods name it: remove or move them first. Players in it go back to the world's own hub.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "query_db",
    description: "Read-only SQL against a mod's own SQLite database (world.db inside that mod). Without sql, shows its schema.",
    inputSchema: { type: "object", properties: { mod: { type: "string" }, sql: { type: "string" } }, required: ["mod"] },
  },
  {
    name: "history",
    description: "Every accepted reload of a mod, newest first, with who made it.",
    inputSchema: { type: "object", properties: { mod: { type: "string" } }, required: ["mod"] },
  },
  {
    name: "restore",
    description: "Put a mod's files back to a commit from history (does not reload; call reload after).",
    inputSchema: { type: "object", properties: { mod: { type: "string" }, commit: { type: "string" } }, required: ["mod", "commit"] },
  },
  {
    name: "screenshot",
    description:
      "See exactly what your player sees right now, at most 1280 px wide: the scene, mod layers and HTML overlays (they must have the game open; a background tab shows only the scene). While a playtest runs, it shows your view in the playtest instead. Look before you mark it done.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "playtest",
    description:
      "Try a change yourself without touching anyone's game: starts a hidden copy of the world as it is now (code, entities and databases) on the host's computer, with you in it as your player, and keeps it running for play and screenshot. mod reloads that mod in the copy from its current files, reloaded live or not, so you can see a change work before or after it goes live. Nothing done in the copy reaches the live world. Needs the host's Sandbox desktop app.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop"], description: "start (default) starts one or reuses the one running; stop ends it and deletes the copy." },
        mod: { type: "string", description: "A mod to reload in the copy from its current files." },
      },
    },
  },
  {
    name: "play",
    description: "Play in the running playtest as your player: hold keys for ms milliseconds, move the mouse to look around, click. Says where you moved; then screenshot shows it.",
    inputSchema: {
      type: "object",
      properties: {
        keys: { type: "string", description: "Comma list of keys held together: w, a, s, d, space, shift, up, KeyE, Digit1." },
        ms: { type: "number", description: "How long to hold them, default 500, at most 10000." },
        look: { type: "string", description: "Mouse movement dx,dy in pixels, like 300,0 to turn right." },
        click: { type: "string", enum: ["left", "right"] },
      },
    },
  },
  {
    name: "add_package",
    description:
      "Install an npm package (e.g. \"@dimforge/rapier3d-compat\", \"simplex-noise@4\") so any mod can import it on the server or client. Packages are shared by every mod and cannot be removed.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "wait_for_chat",
    description:
      "Wait until your player says something in the in-game chat, or someone mentions your player's name, or another Claude's message to claudes names your player, claudes or everyone, then return all chat since your last call. Call it whenever you have nothing else to do, for the whole session: players ask their Claudes for things in chat. New chat is also appended to every other tool result.",
    inputSchema: { type: "object", properties: { seconds: { type: "number", description: "How long to wait, default 60, max 240." } } },
  },
  {
    name: "task",
    description:
      "Show every player what you are building: the Builders board in the game menu and the HUD list each Claude's current task. This, not chat, is how players follow your work: call it when you start something, as it progresses, and when it is done (every check you can run passes; put what to try in status) or blocked (the reason in status).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What you are building, 1 to 5 words: Tide pools." },
        status: { type: "string", description: "One short line on the current step: Fitting the model, Adding engine sound." },
        percent: { type: "number" },
        state: { type: "string", enum: ["working", "done", "blocked"], description: "Default working." },
      },
      required: ["title"],
    },
  },
  {
    name: "announce",
    description:
      "Reveal a new thing to play with a banner every player sees, the same one reload's announce shows: call it when a task goes done and players can try something new, saying what to try. Fixes and tweaks go without it; a mod gets at most one banner a minute.",
    inputSchema: { type: "object", properties: { mod: { type: "string", description: "The live mod it is part of." }, ...BANNER }, required: ["mod", "title"] },
  },
  {
    name: "say",
    description:
      "Post a short message (at most 400 characters) in the in-game chat, shown as your player's Claude. Chat belongs to the players: use it once, for a greeting like Hey everyone when you connect, so they see you are in, and never again; progress and results go through task, reveals through announce. To coordinate with other Claudes (who owns what, the exact export you need, who builds what), pass to: \"claudes\" instead, with no length limit: players don't see it in chat, other Claudes get it with their chat and it wakes their wait_for_chat when it names their player, claudes or everyone.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, to: { type: "string", enum: ["claudes"], description: "claudes: only other Claudes read it (and players who open the Builders tab)." } },
      required: ["text"],
    },
  },
  {
    name: "search_mods",
    description:
      "Search Community mods: systems other worlds built and published, ready to add here (an inventory, day and night, vehicles, a shop). Before building a common system, search here first. Each result has the mod's id, name, author, how many worlds use it, a one-line description and a preview image URL.",
    inputSchema: { type: "object", properties: { q: { type: "string", description: "Words to find in a mod's title, name, description or README; empty lists the most used." }, sort: { type: "string", enum: ["top", "new"], description: "top: most used first (default); new: newest first." } } },
  },
  {
    name: "read_mod",
    description: "A Community mod's README and the API it exports to other mods, with the npm packages and other mods it needs.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "The mod's id from search_mods, or its link." } }, required: ["id"] },
  },
  {
    name: "add_mod",
    description:
      "Install a Community mod in this world as mods/<name>/, with the npm packages it needs, then reload it live for everyone. Afterwards it is a normal mod: edit and reload it like your own. mods/<name>/community.json records where it came from.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "The mod's id from search_mods, or its link." }, as: { type: "string", description: "Another folder name, when mods/<name>/ is taken." } }, required: ["id"] },
  },
];

const instructions = `This is a live multiplayer game that the players build together while playing. Every player's Claude edits the same shared file tree on the game server, and anything you reload goes live for everyone at once.
Workflow: call status, read GUIDE.md and the mods that touch what you are about to build, then write or edit files under mods/<your-mod>/ and call reload. Nothing is live until reload succeeds.
A world can hold several games: check list_games before you build, and put a game's mods in it with game: "<id>" (GUIDE.md, Games).
One game, not a pile of mods: every shared system (movement, ground and sky, lighting, economy, shop, inventory, progression, map, HUD, each key) has one owner mod, which names it in its server.ts with export const owns = ["inventory"] so status lists it. Extend it through its exports or wrap, or ask its owner with say to "claudes"; never build a second one. Hook new things into what players already earn, press and see. Before building a common system from scratch, search_mods: another world may have published one to add.
Before you tell anyone something works, see it work: logs for your player stay clean, screenshot shows it, the input reaches the server (query_world, with wait when you expect state to change; never poll it in a loop). Only then mark your task done. Chat belongs to the players: say one greeting when you connect and nothing more there; players follow your work through task, and when a task goes done and they can try something new, call announce with what to try.
Other Claudes edit at the same time: re-read a file right before changing it. Between builds call wait_for_chat, for the whole session: players ask for things in the in-game chat, which is also appended to every tool result.`;

class ToolError extends Error {}

/** A path in the world tree as agents and the mod rules see it, with / on every platform. */
const treePath = (root: string, abs: string) => relative(root, abs).split(sep).join("/");

export function createCli(ctx: CliContext) {
  const mods = communityClient(process.env.SANDBOX_SECRETS, () => JSON.parse(readFileSync(join(ctx.data, "config.json"), "utf8")).telemetry);
  const refuse = (e: Error): never => {
    throw new ToolError(e.message);
  };
  function resolvePath(path: string) {
    const abs = resolve(ctx.root, path);
    const rel = treePath(ctx.root, abs);
    // On Windows a path on another drive stays absolute.
    if (rel.startsWith("..") || rel.startsWith(".git") || isAbsolute(rel)) throw new ToolError(`${path} is outside the world tree.`);
    return { abs, rel };
  }

  function writable(path: string, who: string) {
    const { abs, rel } = resolvePath(path);
    const mod = rel.match(/^mods\/([a-z][a-z0-9-]{0,31})\/./)?.[1];
    if (!mod) throw new ToolError("You can only write inside mods/<mod-name>/ (lowercase letters, digits, dashes). Everything else is the protected engine.");
    const owner = ctx.owners[mod];
    if (ctx.rules() === "additive" && owner && owner !== who)
      throw new ToolError(`This world is additive: ${mod} belongs to ${owner}, so you can't change it. Build your own mod next to it instead.`);
    return { abs, rel, mod };
  }

  const BANNER_GAP = 60_000;
  const bannered = new Map<string, number>();
  function checkBanner(a: any, prefix: string, outcome: string) {
    for (const [field, max] of [["title", 40], ["text", 160]] as const)
      if (String(a?.[field] ?? "").length > max) throw new ToolError(`${prefix}${field} is ${String(a[field]).length} characters and the banner shows at most ${max}. Shorten it; ${outcome}.`);
  }
  /** vote is false for a reveal of a mod that is already live: players voted on it when it arrived. */
  function banner(mod: string, who: string, a: any, vote: boolean) {
    bannered.set(mod, Date.now());
    ctx.announce({ mod, by: who, title: String(a.title), text: String(a.text ?? ""), color: /^#[0-9a-f]{3,8}$/i.test(a.color) ? a.color : "#ffb547", vote });
  }

  function claim(mod: string, who: string) {
    if (ctx.owners[mod]) return;
    ctx.owners[mod] = who;
    ctx.saveOwners();
  }

  function checkBase(abs: string, rel: string, base?: string) {
    const exists = existsSync(abs);
    if (exists && !base) throw new ToolError(`${rel} already exists. read_file it and pass its hash as base_hash.`);
    if (exists && hash(readFileSync(abs, "utf8")) !== base)
      throw new ToolError(`${rel} changed since you read it (someone else is editing too). read_file it again and redo your change on the new version.`);
    if (!exists && base) throw new ToolError(`${rel} no longer exists; someone deleted it.`);
  }

  const recentEdits = new Map<string, number>();
  function announceEdit(who: string, rel: string) {
    const key = `${who}:${rel}`;
    if (Date.now() - (recentEdits.get(key) ?? 0) < 20_000) return;
    recentEdits.set(key, Date.now());
    ctx.feed(`${speaker(who)} is editing ${rel.replace(/^mods\//, "")}`, "info");
  }

  function list(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const abs = join(dir, name);
      if (!statSync(abs).isDirectory()) return [treePath(ctx.root, abs)];
      return name.startsWith(".") || name === "node_modules" ? [] : list(abs);
    });
  }

  async function git(...args: string[]) {
    if (!hasGit) throw new ToolError("Needs Git, which this computer doesn't have. On a Mac, xcode-select --install adds it; on Windows, the installer at git-scm.com. Then restart the world.");
    const proc = Bun.spawn([...GIT, ...args], { cwd: ctx.root, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code) throw new ToolError(err.trim());
    return out;
  }

  /** Runs a tool and records who called it, how long it took, how much it returned and any error. */
  async function call(name: string, args: any, who: string) {
    const started = performance.now();
    let result: string | { image: string } | undefined;
    let error: string | undefined;
    try {
      return (result = await run(name, args, who));
    } catch (e: any) {
      error = String(e.message).slice(0, 300);
      throw e instanceof PlaytestError ? new ToolError(e.message) : e;
    } finally {
      ctx.record.add("tool", who, { tool: name, args: brief(args), ms: Math.round(performance.now() - started), bytes: typeof result === "string" ? result.length : result?.image.length, error });
    }
  }

  /** The game a tool looks at: the one asked for (empty for the hub), else the caller's player's. */
  function gameFor(args: { game?: string }, who: string) {
    if (args.game === undefined) return ctx.sims.gameOf(who);
    if (args.game === "") return null;
    if (!ctx.sims.hasGame(args.game)) throw new ToolError(`There is no game ${args.game}; list_games shows them.`);
    return args.game;
  }

  const card = (args: Record<string, unknown>) => Object.fromEntries(CARD_FIELDS.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

  async function run(name: string, args: any, who: string): Promise<string | { image: string }> {
    switch (name) {
      case "list_games":
        return JSON.stringify(ctx.sims.summary(), null, 2);
      case "create_game": {
        const game = ctx.sims.createGame({ ...card(args), id: String(args.id ?? "") } as GameCard, who);
        if (typeof game === "string") throw new ToolError(game);
        ctx.feed(`${speaker(who)} created the game ${game.title}`, "info");
        return `Created the game ${game.id} (${game.status}). Mods join it with game: "${game.id}" on the default export of their server.ts and client.ts.`;
      }
      case "edit_game": {
        const game = ctx.sims.editGame(String(args.id), card(args));
        if (typeof game === "string") throw new ToolError(game);
        ctx.feed(`${speaker(who)} changed the game ${game.title}`, "info");
        return JSON.stringify(game, null, 2);
      }
      case "delete_game": {
        const title = ctx.sims.games.get(String(args.id))?.title;
        const refused = ctx.sims.deleteGame(String(args.id));
        if (refused) throw new ToolError(refused);
        ctx.feed(`${speaker(who)} deleted the game ${title}`, "info");
        return `Deleted the game ${args.id} and its save.`;
      }
      case "status":
        return JSON.stringify(ctx.status(), null, 2);
      case "list_files":
        return list(ctx.root)
          .sort()
          .map((f) => `${f}  ${hash(readFileSync(join(ctx.root, f), "utf8"))}`)
          .join("\n");
      case "read_file": {
        const { abs, rel } = resolvePath(args.path);
        if (!existsSync(abs) || statSync(abs).isDirectory()) throw new ToolError(`${rel} does not exist.`);
        if (/^mods\/[^/]+\/assets\//.test(rel)) return `${rel} is a binary asset (${statSync(abs).size} bytes), served at /${rel.replace(/^mods\/([^/]+)\/assets/, "assets/$1")}.`;
        const text = readFileSync(abs, "utf8");
        return `hash: ${hash(text)}\n${text}`;
      }
      case "write_file": {
        const { abs, rel, mod } = writable(args.path, who);
        checkBase(abs, rel, args.base_hash);
        claim(mod, who);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, args.content);
        announceEdit(who, rel);
        return `Wrote ${rel}. New hash: ${hash(args.content)}. Call reload with mod "${mod}" when ready.`;
      }
      case "edit_file": {
        const { abs, rel, mod } = writable(args.path, who);
        checkBase(abs, rel, args.base_hash);
        const text = readFileSync(abs, "utf8");
        const count = text.split(args.old_string).length - 1;
        if (count === 0) throw new ToolError("old_string was not found.");
        if (count > 1 && !args.replace_all) throw new ToolError(`old_string occurs ${count} times; add context or set replace_all.`);
        const next = args.replace_all ? text.replaceAll(args.old_string, args.new_string) : text.replace(args.old_string, () => args.new_string);
        writeFileSync(abs, next);
        announceEdit(who, rel);
        return `Edited ${rel}. New hash: ${hash(next)}. Call reload with mod "${mod}" when ready.`;
      }
      case "delete_file": {
        const { abs, rel } = writable(args.path, who);
        checkBase(abs, rel, args.base_hash);
        rmSync(abs);
        // Empty folders go up to the mod's own, so deleting a mod's last asset still lets reload remove the mod.
        for (let dir = dirname(abs), r = dirname(rel); r !== "mods" && !readdirSync(dir).length; dir = dirname(dir), r = dirname(r)) rmSync(dir, { recursive: true });
        return `Deleted ${rel}.`;
      }
      case "add_asset": {
        if (!/^[\w.-]{1,64}$/.test(args.name ?? "") || args.name.startsWith(".")) throw new ToolError("name must be a plain file name like dragon.glb.");
        const { abs, rel } = writable(`mods/${args.mod}/assets/${args.name}`, who);
        let bytes: Uint8Array;
        if (args.url) {
          bytes = await download(args.url, 20 << 20).catch((e) => {
            throw e instanceof EgressError ? new ToolError(e.message) : e;
          });
        } else if (args.base64) bytes = Buffer.from(args.base64, "base64");
        else throw new ToolError("Pass url or base64.");
        if (bytes.length > 20 << 20) throw new ToolError(`${bytes.length} bytes is over the 20 MB limit.`);
        claim(args.mod, who);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, bytes);
        announceEdit(who, rel);
        return `Saved ${rel} (${bytes.length} bytes). Load it in client code with ctx.asset("${args.name}").`;
      }
      case "reload": {
        const mod = String(args.mod);
        const a = args.announce;
        checkBanner(a, "announce.", "nothing was reloaded");
        const owner = ctx.owners[mod];
        if (ctx.rules() === "additive" && owner && owner !== who && owner !== "world") throw new ToolError(`This world is additive: ${mod} belongs to ${owner}.`);
        claim(mod, who);
        const isNew = !ctx.mods.running.has(mod);
        const result = await ctx.mods.reload(mod, who, ctx.owners[mod]!, args.force === true);
        if (!result.ok) throw new ToolError(result.report);
        if (a || isNew) banner(mod, who, a ?? { title: mod }, true);
        return result.report;
      }
      case "announce": {
        const mod = String(args.mod);
        if (!ctx.mods.running.has(mod)) throw new ToolError(`${mod} isn't live; reload it first.`);
        checkBanner(args, "", "nothing was shown");
        const wait = (bannered.get(mod) ?? 0) + BANNER_GAP - Date.now();
        if (wait > 0) throw new ToolError(`${mod} gets at most one banner a minute; nothing was shown. Call announce again in ${Math.ceil(wait / 1000)} s.`);
        banner(mod, who, args, false);
        return "Shown to every player.";
      }
      case "logs": {
        const lines = ctx.logs.filter((l) => (!args.mod || l.mod === args.mod) && (!args.player || l.player === args.player)).slice(-(args.limit ?? 50));
        return lines.map((l) => `${new Date(l.at).toISOString().slice(11, 19)} [${l.mod}] ${l.level}: ${l.text}`).join("\n") || "No logs yet.";
      }
      case "perf":
        return JSON.stringify(ctx.perf(), null, 2);
      case "activity":
        return JSON.stringify(ctx.record.activity(args), null, 1);
      case "corrections": {
        const found = ctx.sims.corrections().filter((c) => (!args.player || c.player === args.player) && (!args.mod || c.mod === args.mod)).slice(-(args.limit ?? 50));
        return found.map((c) => JSON.stringify({ ...c, at: new Date(c.at).toISOString().slice(11, 19) })).join("\n") || "No player has been corrected since the world started.";
      }
      case "walk_test": {
        const point = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
        if (!point(args.from) || !point(args.to)) throw new ToolError("from and to are feet positions like [x, y, z].");
        if (Math.hypot(args.to[0] - args.from[0], args.to[2] - args.from[2]) > 500) throw new ToolError("from and to are over 500 m apart; test the walk in shorter legs.");
        return JSON.stringify(await ctx.sims.awake(gameFor(args, who)).walk(args.from, args.to, args.body));
      }
      case "colliders":
        if (!ctx.sendToGame(who, { t: "colliders", on: !!args.on })) throw new ToolError(`${who} doesn't have the game open.`);
        return args.on ? "Colliders are showing in your player's game: red boxes are ones nothing draws." : "Colliders are hidden.";
      case "query_world": {
        const components: string[] = args.components ?? [];
        const game = gameFor(args, who);
        const query = () => {
          const found = [...ctx.sims.entities(game)].filter(([, e]) => components.every((c) => c in e));
          const games = Object.entries((ctx.perf() as { players: Record<string, { solidWithoutModel?: { count: number } }> }).players);
          const [player, report] = games.find(([name]) => name === who) ?? games[0] ?? [];
          const walls = report?.solidWithoutModel?.count ? `\nsolidWithoutModel: ${JSON.stringify(report.solidWithoutModel)} (solid entities nothing draws, orange wireframes in ${player}'s game)` : "";
          return JSON.stringify(Object.fromEntries(found.slice(0, args.limit ?? 50))) + `\n(${found.length} matching entities)` + walls;
        };
        const first = query();
        const until = Date.now() + Math.min(Number(args.wait) || 0, 60) * 1000;
        while (Date.now() < until) {
          await Bun.sleep(250);
          const now = query();
          if (now !== first) return now;
        }
        return first;
      }
      case "query_db": {
        if (!/^[a-z][a-z0-9-]{0,31}$/.test(args.mod)) throw new ToolError("Unknown mod.");
        const path = join(ctx.dbDir, `${args.mod}.sqlite`);
        if (!existsSync(path)) throw new ToolError(`${args.mod} has no database yet; it gets one the first time it uses world.db.`);
        const db = new Database(path, { readonly: true });
        db.run("pragma busy_timeout = 2000");
        try {
          const rows = db.query(args.sql ?? "select sql from sqlite_master where sql is not null").all();
          return JSON.stringify(rows.slice(0, 100), null, 1) + (rows.length > 100 ? `\n(${rows.length} rows, first 100 shown)` : "");
        } catch (e: any) {
          throw new ToolError(e.message);
        } finally {
          db.close();
        }
      }
      case "history":
        return (await git("log", "--format=%h %ad %an: %s", "--date=format:%m-%d %H:%M", "-n", "30", "--", `mods/${args.mod}`)) || "No history.";
      case "restore": {
        writable(`mods/${args.mod}/x`, who);
        if (!/^[0-9a-f]{4,40}$/.test(args.commit)) throw new ToolError("commit must be a hash from history.");
        await git("rm", "-rq", "--ignore-unmatch", "--", `mods/${args.mod}`);
        await git("checkout", args.commit, "--", `mods/${args.mod}`);
        await git("reset", "-q");
        return `Restored mods/${args.mod} to ${args.commit}. Call reload to put it live.`;
      }
      case "playtest":
        if (args.action !== undefined && args.action !== "start" && args.action !== "stop") throw new ToolError("action is start or stop.");
        return args.action === "stop" ? ctx.playtest.stop() : await ctx.playtest.start(who, args.mod);
      case "play":
        return await ctx.playtest.play(args);
      case "screenshot":
        return {
          image: await ctx.screenshot(who).catch((e) => {
            throw new ToolError(e.message);
          }),
        };
      case "add_package": {
        const spec = String(args.name);
        const out = await install(ctx.root, spec).catch((error: unknown) => {
          throw new ToolError(error instanceof Error ? error.message : String(error));
        });
        if (hasGit) {
          await git("add", "package.json", "bun.lock");
          await git("commit", "-qm", `add package ${spec}`, `--author=${who} <${who}@sandbox>`).catch(() => {});
        }
        const typecheckError = await ctx.mods.warm().then(() => "", (error: unknown) => error instanceof Error ? error.message : String(error));
        ctx.feed(`${speaker(who)} added the ${spec} package`, "info");
        return `${out.trim().split("\n").slice(-3).join("\n")}\n${typecheckError ? `The package is installed, but the typecheck couldn't start:\n${typecheckError}` : "Import it from any mod, then reload that mod."}`;
      }
      case "search_mods":
        return await mods.search(String(args.q ?? ""), String(args.sort ?? "top")).catch(refuse);
      case "read_mod":
        return await mods.read(args.id).catch(refuse);
      case "add_mod": {
        const added = await mods.add(args.id, args.as, ctx.root).catch(refuse);
        ctx.feed(`${speaker(who)} added ${added.mod.title} from Community`, "info");
        const reloaded = await run("reload", { mod: added.name }, who).catch((e) => `It didn't go live: ${e.message}\nThe files are in mods/${added.name}/: fix them and reload.`);
        return `Added ${added.mod.title} by ${added.mod.author} as mods/${added.name}/ (${added.files.join(", ")}${added.packages.length ? `; installed ${added.packages.join(", ")}` : ""}).${added.mod.needs.length ? ` It uses the mods ${added.mod.needs.join(", ")}: check status for them.` : ""}\n${typeof reloaded === "string" ? reloaded : ""}`;
      }
      case "wait_for_chat": {
        const until = Date.now() + Math.min(Number(args.seconds) || 60, 240) * 1000;
        const called = (text: string) => text.toLowerCase().includes(who);
        const forMe = () => unseenChat(who).some((c) => c.from === who || called(c.text) || (c.claudes && /\b(claudes|everyone)\b/i.test(c.text)));
        while (!forMe() && Date.now() < until) await Promise.race([ctx.nextChat(), Bun.sleep(until - Date.now())]);
        return forMe() ? "New chat:" : `Nothing for you from ${who} yet.`;
      }
      case "say": {
        if (args.to !== undefined && args.to !== "claudes") throw new ToolError(`to can only be "claudes"; leave it out to talk in the players' chat.`);
        const text = String(args.text);
        if (!args.to && text.length > SAY_MAX)
          throw new ToolError(`That is ${text.length} characters; a chat line for players holds at most ${SAY_MAX}. Nothing was said: shorten it or split it into several says, and send details for other Claudes with to: "claudes", which has no limit.`);
        ctx.chat(speaker(who), text, args.to);
        return args.to ? "Sent to the other Claudes." : "Said.";
      }
      case "task": {
        const state = ["done", "blocked"].includes(args.state) ? args.state : "working";
        const percent = Number.isFinite(args.percent) ? Math.max(0, Math.min(100, Math.round(args.percent))) : undefined;
        ctx.setTask(who, { title: String(args.title).slice(0, 60), status: String(args.status ?? "").slice(0, 120), percent, state, at: Date.now() });
        return "Shown on the Builders board.";
      }
    }
    throw new ToolError(`Unknown tool ${name}`);
  }

  const STALE = "This command's key isn't valid for the world running now: the host switched worlds or removed this player. Ask your player to run the new install command from the Agent page of the game menu.";
  /** Ends every result, so any agent keeps listening without a harness hook to stop it ending its turn. */
  const KEEP_LISTENING = "When you are done with this, call wait_for_chat again. Never end your turn.";
  const chatSeen = new Map<string, number>();
  const unseenChat = (who: string) => ctx.chatLog.filter((c) => c.seq > (chatSeen.get(who) ?? 0) && c.from !== speaker(who));
  /** Everything said since this Claude last looked, however long it was busy; a Claude new to the world gets the recent conversation. */
  function takeChat(who: string) {
    const cursor = chatSeen.get(who);
    const all = unseenChat(who);
    const unseen = cursor === undefined ? all.slice(-30) : all;
    const oldest = ctx.chatLog[0]?.seq ?? 0;
    const lost = cursor !== undefined && cursor < oldest - 1 ? `(${oldest - 1 - cursor} older lines are no longer kept)\n` : "";
    const lines = unseen.map((c) => `${c.claudes ? "[claudes] " : ""}${c.game ? `[${c.game}] ` : ""}${c.from}${c.spoken ? " (said aloud)" : ""}: ${c.text}`);
    chatSeen.set(who, ctx.chatLog.at(-1)?.seq ?? 0);
    const spoken = unseen.some((c) => c.spoken) ? "\n(said aloud) lines are what a player said into their microphone (hold T, open chat, or leave the always-on mic on): often talk between players, not orders. See GUIDE.md, Staying with your player." : "";
    return lines.length ? [`In-game chat since your last look, oldest first:\n${lost}${lines.join("\n")}${spoken}`] : [];
  }

  const usage = (tool: (typeof tools)[number]) => {
    const props: Record<string, any> = tool.inputSchema.properties;
    const required: string[] = (tool.inputSchema as any).required ?? [];
    return [tool.name, ...Object.entries(props).map(([k, v]) => (required.includes(k) ? `${k}=<${v.type}>` : `[${k}=<${v.type}>]`))].join(" ");
  };

  /** The command line every agent reaches the world through: a shell script it installs, calling the tools over plain HTTP. */
  async function cli(req: Request, who: string | null, command: string) {
    if (!who) return new Response(`${STALE}
`, { status: 401 });
    if (command === "help") {
      const list = tools.map((t) => `${usage(t)}\n    ${t.description}${Object.entries(t.inputSchema.properties as Record<string, any>).map(([k, v]) => (v.description ? `\n    ${k}: ${v.description}` : "")).join("")}`);
      return new Response(`${instructions}\n\nname=value sends text, name=@file sends a file (binary files work for add_asset base64), name=- reads stdin. Numbers, booleans and lists are JSON. New chat is appended to every result.\n\n${list.join("\n\n")}\n`);
    }
    const tool = tools.find((t) => t.name === command);
    if (!tool) return new Response(`Unknown tool ${command}. Run the command alone to list the tools.\n`, { status: 404 });
    const args: Record<string, any> = {};
    if (req.headers.get("content-type")?.startsWith("multipart/form-data"))
      for (const [key, value] of await req.formData()) {
        const type = (tool.inputSchema.properties as Record<string, any>)[key]?.type;
        const text = typeof value === "string" ? value : key === "base64" ? Buffer.from(await value.arrayBuffer()).toString("base64") : await value.text();
        try {
          args[key] = type && type !== "string" ? JSON.parse(text) : text;
        } catch {
          return new Response(`${key} must be JSON of type ${type}, got: ${text}\n`, { status: 400 });
        }
      }
    const listening = command === "wait_for_chat";
    ctx.presence(who, listening ? "listening" : "working");
    if (listening) req.signal.addEventListener("abort", () => ctx.presence(who, "offline"));
    const answer = async (): Promise<{ status: number; body: string | Blob; type?: string }> => {
      try {
        const result = await call(command, args, who);
        if (typeof result !== "string") return { status: 200, body: new Blob([Buffer.from(result.image, "base64")]), type: "image/jpeg" };
        if (command === "read_file") return { status: 200, body: result };
        return { status: 200, body: [result, ...takeChat(who), KEEP_LISTENING].join("\n\n") + "\n" };
      } catch (e: any) {
        if (!(e instanceof ToolError)) console.error(e);
        return { status: 422, body: [e.message, ...takeChat(who), KEEP_LISTENING].join("\n\n") + "\n" };
      } finally {
        if (listening && !req.signal.aborted) ctx.presence(who, "working");
      }
    };
    if (!listening) {
      const { status, body, type } = await answer();
      return new Response(body, { status, headers: { "content-type": type ?? "text/plain; charset=utf-8" } });
    }
    // Tunnels drop responses that stay silent for about 100 s, so a long wait sends newlines until it has an answer.
    let keepalive: Timer | undefined;
    return new Response(
      new ReadableStream({
        async start(stream) {
          keepalive = setInterval(() => stream.enqueue("\n"), 15_000);
          const { body } = await answer();
          if (!keepalive) return;
          clearInterval(keepalive);
          stream.enqueue(body);
          stream.close();
        },
        cancel() {
          clearInterval(keepalive);
          keepalive = undefined;
        },
      }),
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  return cli;
}

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sandbox";

/** The prompt a player pastes into any coding agent opened in the world's folder. It carries no key: the folder holds it. */
export const connectPrompt = (world: string) => `We're playing ${world} together. Read AGENTS.md in this folder and join as it says.`;

/** Single-use codes behind the Agent page's install command, each good for ten minutes. `now` is the clock, so tests can move it. */
export function joinCodes(now = Date.now) {
  const codes = new Map<string, { key: string; base: string; until: number }>();
  return {
    mint(key: string, base: string) {
      for (const [code, entry] of codes) if (entry.until < now()) codes.delete(code);
      const code = randomBytes(6).toString("hex");
      codes.set(code, { key, base, until: now() + 10 * 60_000 });
      return code;
    },
    take(code: string) {
      const entry = codes.get(code);
      codes.delete(code);
      return entry && entry.until > now() ? entry : null;
    },
  };
}

/** The Agent page's install command: a single-use code, so nothing a player copies or shares carries their key. */
export const joinCommand = (base: string, code: string, world: string) => ({ command: `curl -fsSL ${quote(`${base}/join/${code}`)} | sh`, folder: `~/${worldDir(world)}`, prompt: connectPrompt(world) });

const worldDir = (world: string) => `Sandbox/${slug(world)}`;

/** engine/skills/*.md: how-tos the world folder carries for its agent, each opening with a "When to use:" line. */
const SKILLS = readdirSync(join(import.meta.dir, "skills"))
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((f) => {
    const text = readFileSync(join(import.meta.dir, "skills", f), "utf8");
    return { name: f.slice(0, -3), text, when: text.match(/^When to use: (.+)$/m)![1]! };
  });

/** The world's folder under a player's home: this world's command, the key only it reads, the join request every agent opened there reads as the player's own instructions, each agent's allow rule for that one command, and the skills. Paths are relative to the folder. */
function worldFiles(world: string, base: string, me: string, key: string): [path: string, text: string, mode: number][] {
  const request = `# ${world}

I'm ${me} in ${world}, a live multiplayer game my friends and I build together while we play, each with our own coding agent. This folder connects you to it as me: \`./world\` here is the game's command. Run \`./world\` alone to list its tools, and call one as \`./world <tool> name=value\`, always from this folder.

When I ask you to join:

1. Run \`./world status\` and \`./world read_file path=GUIDE.md\`, and follow the guide.
2. Say hi in the game with \`./world say text="Hey everyone"\`. After that the chat is ours, so don't post there again.
3. While we play, listen for me in the game chat: run \`./world wait_for_chat seconds=240\` with a shell timeout of at least 300 seconds, build what I ask for, then listen again until I say stop. I talk to you only through the game, never in this terminal.

Before a task one of the skills in \`skills/\` covers, read that skill and start from its recipes: ${SKILLS.map((k) => `\`skills/${k.name}.md\``).join(", ")}.

Anything you reload goes live for everyone at once, so extend what the others built and see it work in play before calling it done. Show your progress with \`task\` and \`announce\` as the guide says, not in chat.
`;
  return [
    [".key", key, 0o600],
    ["world", script(base, slug(world)), 0o700],
    ["AGENTS.md", request, 0o644],
    ["CLAUDE.md", "@AGENTS.md\n", 0o644],
    [".claude/settings.json", `${JSON.stringify({ permissions: { allow: ["Bash(./world)", "Bash(./world *)"] } }, null, 2)}\n`, 0o644],
    [".codex/rules/world.rules", `prefix_rule(pattern = ["./world"], decision = "allow")\n`, 0o644],
    [".cursor/cli.json", `${JSON.stringify({ permissions: { allow: ["Shell(./world)"] } }, null, 2)}\n`, 0o644],
    ["opencode.json", `${JSON.stringify({ permission: { bash: { "./world": "allow", "./world *": "allow" } } }, null, 2)}\n`, 0o644],
    ...SKILLS.flatMap(({ name, text, when }): [string, string, number][] => [
      [`skills/${name}.md`, text, 0o644],
      [`.claude/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${JSON.stringify(when)}\n---\n\n${text}`, 0o644],
    ]),
  ];
}

/** Sets up ~/Sandbox/<world>/ under `home` for this player's key and returns the folder. */
export function setUpWorldFolder(home: string, world: string, base: string, me: string, key: string) {
  const folder = join(home, worldDir(world));
  for (const [path, text, mode] of worldFiles(world, base, me, key)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text, { mode });
    chmodSync(join(folder, path), mode);
  }
  return folder;
}

/** The same folder as setUpWorldFolder, as the script a join code runs on the player's computer. */
export function joinScript(world: string, base: string, me: string, key: string) {
  return `#!/bin/sh
set -e
cd
mkdir -p ${quote(worldDir(world))}
cd ${quote(worldDir(world))}
umask 077
${worldFiles(world, base, me, key)
  .map(([path, text, mode]) => `mkdir -p ${quote(dirname(path))} && printf '%s' ${quote(text)} > ${quote(path)} && chmod ${mode.toString(8)} ${quote(path)}`)
  .join("\n")}
echo ${quote(`Ready. Open ~/${worldDir(world)} in your agent and paste the prompt from the Agent page.`)}
`;
}

const script = (url: string, name: string) => `#!/bin/sh
# Sandbox world ${name} from the command line. Run it alone for the tools and how to call them.
URL=${quote(url)}
KEY=$(cat "$(dirname "$0")/.key")
auth="Authorization: Bearer $KEY"
if [ $# -eq 0 ] || [ "$1" = help ]; then exec curl -sS --fail-with-body -H "$auth" "$URL/cli/help"; fi
tool=$1
shift
for arg do
  shift
  case $arg in *=*) ;; *) echo "Arguments are name=value, got: $arg" >&2; exit 2 ;; esac
  name=\${arg%%=*}
  value=\${arg#*=}
  case $value in
    -) set -- "$@" -F "$name=@-" ;;
    @*) if [ -f "\${value#@}" ]; then set -- "$@" -F "$name=@\${value#@}"; else set -- "$@" --form-string "$name=$value"; fi ;; # @scope/package is text unless such a file exists
    *) set -- "$@" --form-string "$name=$value" ;;
  esac
done
if [ "$tool" = screenshot ]; then
  out="\${TMPDIR:-/tmp}/${name}-screenshot.jpg"
  curl -sS --fail-with-body -X POST -H "$auth" "$@" -o "$out" "$URL/cli/screenshot" && echo "$out"
  exit
fi
exec curl -sS --fail-with-body -X POST -H "$auth" "$@" "$URL/cli/$tool"
`;
