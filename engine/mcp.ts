import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Mods } from "./mods";
import type { SimHost } from "./simhost";

/** The shared Claude that runs events, challenges and bosses for the whole world. */
export const GAME_MASTER = "gamemaster";
export type Task = { title: string; status: string; percent?: number; state: "working" | "done" | "blocked"; at: number };
const speaker = (who: string) => (who === GAME_MASTER ? "Game master" : `${who}'s Claude`);

export type McpContext = {
  root: string;
  dbDir: string;
  rules: () => "open" | "additive";
  owners: Record<string, string>;
  saveOwners(): void;
  mods: Mods;
  sim: SimHost;
  logs: { at: number; mod: string; level: string; text: string; player?: string }[];
  feed(text: string, kind?: string): void;
  chat(from: string, text: string, how?: "claudes"): void;
  chatLog: { seq: number; from: string; text: string; spoken?: boolean; claudes?: boolean }[];
  nextChat(): Promise<void>;
  presence(who: string, state: "listening" | "working" | "offline"): void;
  setTask(who: string, task: Task): void;
  announce(a: { mod: string; by: string; title: string; text: string; color: string }): void;
  status(): object;
  perf(): object;
  screenshot(who: string): Promise<string>;
};

const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 12);

const tools = [
  {
    name: "status",
    description: "World name, rules, who is online, running mods with authors and versions, and recent activity. Start here.",
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
      "Put a mod live for every player without disconnecting anyone: typechecks it, builds it, test-runs it against a copy of the live world, then hot-swaps server and client code. If any step fails nothing changes and you get the error. Pass announce to introduce what changed to every player with an on-screen banner; new mods get a banner with their name if you leave it out, updates without it only show in the feed.",
    inputSchema: {
      type: "object",
      properties: {
        mod: { type: "string" },
        announce: {
          type: "object",
          description: "The banner every player sees when this goes live.",
          properties: {
            title: { type: "string", description: "1 to 4 words, like a game mode name: LOW GRAVITY, THE FLOOR IS LAVA." },
            text: { type: "string", description: "One short line telling players what to try or watch out for." },
            color: { type: "string", description: "A #hex colour that fits the mod's mood." },
          },
          required: ["title"],
        },
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
    description: "Recent console output and errors from server mods and from every player's game (their client mods' console.log/warn/error and crashes). Filter by mod, or by player to see one game, e.g. your own player's.",
    inputSchema: { type: "object", properties: { mod: { type: "string" }, player: { type: "string" }, limit: { type: "number" } } },
  },
  {
    name: "perf",
    description: "Why is the game slow? Server cost per mod (ms per 50 ms tick) and, for every player's game, fps, slowest frames, ms per frame spent in each client mod and in drawing, draw calls, triangles, scene objects, network ping and download rate, memory and GPU. Games report every 2 seconds.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "query_world",
    description: "Read live entities that have all the given components, e.g. [\"player\", \"pos\"].",
    inputSchema: { type: "object", properties: { components: { type: "array", items: { type: "string" } }, limit: { type: "number" } } },
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
    description: "See exactly what your player sees right now, 3D view and HTML overlays (they must have the game open). Use it to check your visuals and UI.",
    inputSchema: { type: "object", properties: {} },
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
      "Wait until your player says something in the in-game chat, or someone mentions your player's name, or another Claude's message to claudes names your player, claudes or everyone, then return all chat since your last call. Call it whenever you have nothing else to do: players ask their Claudes for things in chat. New chat is also appended to every other tool result.",
    inputSchema: { type: "object", properties: { seconds: { type: "number", description: "How long to wait, default 60, max 240." } } },
  },
  {
    name: "task",
    description:
      "Show every player what you are building: the Builders board in the game menu and the HUD list each Claude's current task. Call it when you start something, as it progresses, and when it is done or blocked.",
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
    name: "say",
    description:
      "Post a short message in the in-game chat, shown as your player's Claude: what you just built, or an answer to someone. To coordinate with other Claudes (API contracts, hashes, who builds what), pass to: \"claudes\" instead: players don't see it in chat, other Claudes get it with their chat and it wakes their wait_for_chat when it names their player, claudes or everyone.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, to: { type: "string", enum: ["claudes"], description: "claudes: only other Claudes read it (and players who open the Builders tab)." } },
      required: ["text"],
    },
  },
];

export const instructions = `This is a live multiplayer game that the players build together while playing. Every player's Claude edits the same shared file tree on the game server.
Workflow: call status, read GUIDE.md and api.ts, then write or edit files under mods/<your-mod>/ and call reload to put them live for everyone. Nothing you write affects the game until reload succeeds.
Other Claudes are editing at the same time: always re-read a file right before changing it, and keep each feature in its own mod folder.
Mods can hide entities per player, send one-off events, call each other's exports, fetch any HTTP or MCP API asynchronously, load models or sounds added with add_asset, and import npm packages added with add_package. Use screenshot to see what your player sees, and wait_for_chat between builds to hear what players want; GUIDE.md shows how.`;

class ToolError extends Error {}

export function createMcp(ctx: McpContext) {
  function resolvePath(path: string) {
    const abs = resolve(ctx.root, path);
    const rel = relative(ctx.root, abs);
    if (rel.startsWith("..") || rel.startsWith(".git")) throw new ToolError(`${path} is outside the world tree.`);
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
      if (name === ".git" || name === "node_modules") return [];
      const abs = join(dir, name);
      return statSync(abs).isDirectory() ? list(abs) : [relative(ctx.root, abs)];
    });
  }

  async function git(...args: string[]) {
    const proc = Bun.spawn(["git", ...args], { cwd: ctx.root, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code) throw new ToolError(err.trim());
    return out;
  }

  async function call(name: string, args: any, who: string): Promise<string | { image: string }> {
    switch (name) {
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
        if (!readdirSync(dirname(abs)).length) rmSync(dirname(abs), { recursive: true });
        return `Deleted ${rel}.`;
      }
      case "add_asset": {
        if (!/^[\w.-]{1,64}$/.test(args.name ?? "") || args.name.startsWith(".")) throw new ToolError("name must be a plain file name like dragon.glb.");
        const { abs, rel } = writable(`mods/${args.mod}/assets/${args.name}`, who);
        let bytes: Uint8Array;
        if (args.url) {
          const res = await fetch(args.url).catch((e) => {
            throw new ToolError(`Download failed: ${e.message}`);
          });
          if (!res.ok) throw new ToolError(`Download failed: HTTP ${res.status}`);
          bytes = new Uint8Array(await res.arrayBuffer());
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
        const owner = ctx.owners[mod];
        if (ctx.rules() === "additive" && owner && owner !== who && owner !== "world") throw new ToolError(`This world is additive: ${mod} belongs to ${owner}.`);
        claim(mod, who);
        const isNew = !ctx.mods.running.has(mod);
        const result = await ctx.mods.reload(mod, who, ctx.owners[mod]!, args.force === true);
        if (!result.ok) throw new ToolError(result.report);
        const a = args.announce;
        if (a || isNew)
          ctx.announce({
            mod,
            by: who,
            title: String(a?.title ?? mod).slice(0, 40),
            text: String(a?.text ?? "").slice(0, 160),
            color: /^#[0-9a-f]{3,8}$/i.test(a?.color) ? a.color : "#ffb547",
          });
        return result.report;
      }
      case "logs": {
        const lines = ctx.logs.filter((l) => (!args.mod || l.mod === args.mod) && (!args.player || l.player === args.player)).slice(-(args.limit ?? 50));
        return lines.map((l) => `${new Date(l.at).toISOString().slice(11, 19)} [${l.mod}] ${l.level}: ${l.text}`).join("\n") || "No logs yet.";
      }
      case "perf":
        return JSON.stringify(ctx.perf(), null, 2);
      case "query_world": {
        const components: string[] = args.components ?? [];
        const found = [...ctx.sim.entities].filter(([, e]) => components.every((c) => c in e));
        return JSON.stringify(Object.fromEntries(found.slice(0, args.limit ?? 50))) + `\n(${found.length} matching entities)`;
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
      case "screenshot":
        return {
          image: await ctx.screenshot(who).catch((e) => {
            throw new ToolError(e.message);
          }),
        };
      case "add_package": {
        const spec = String(args.name);
        if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*-]+)?$/.test(spec)) throw new ToolError("Give an npm package name, optionally with @version.");
        const proc = Bun.spawn([process.execPath, "add", spec], { cwd: ctx.root, stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_BE_BUN: "1" } });
        const timer = setTimeout(() => proc.kill(), 120_000);
        const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        clearTimeout(timer);
        if (code) throw new ToolError(`bun add ${spec} failed:\n${(err || out).trim().slice(-2000)}`);
        await git("add", "package.json", "bun.lock");
        await git("commit", "-qm", `add package ${spec}`, `--author=${who} <${who}@sandbox>`).catch(() => {});
        ctx.feed(`${speaker(who)} added the ${spec} package`, "info");
        return `${out.trim().split("\n").slice(-3).join("\n")}\nImport it from any mod, then reload that mod.`;
      }
      case "wait_for_chat": {
        const until = Date.now() + Math.min(Number(args.seconds) || 60, 240) * 1000;
        const called = who === GAME_MASTER ? /\b(gm|game ?master)\b/i : { test: (text: string) => text.toLowerCase().includes(who) };
        const forMe = () => unseenChat(who).some((c) => c.from === who || called.test(c.text) || (c.claudes && /\b(claudes|everyone)\b/i.test(c.text)));
        while (!forMe() && Date.now() < until) await Promise.race([ctx.nextChat(), Bun.sleep(until - Date.now())]);
        return forMe() ? "New chat:" : who === GAME_MASTER ? "Nobody called for the game master. Check how play feels and tune one small thing if it needs it." : `Nothing for you from ${who} yet.`;
      }
      case "say":
        if (args.to !== undefined && args.to !== "claudes") throw new ToolError(`to can only be "claudes"; leave it out to talk in the players' chat.`);
        ctx.chat(speaker(who), String(args.text).slice(0, 300), args.to);
        return args.to ? "Sent to the other Claudes." : "Said.";
      case "task": {
        const state = ["done", "blocked"].includes(args.state) ? args.state : "working";
        const percent = Number.isFinite(args.percent) ? Math.max(0, Math.min(100, Math.round(args.percent))) : undefined;
        ctx.setTask(who, { title: String(args.title).slice(0, 60), status: String(args.status ?? "").slice(0, 120), percent, state, at: Date.now() });
        return "Shown on the Builders board.";
      }
    }
    throw new ToolError(`Unknown tool ${name}`);
  }

  // An unknown key still completes the handshake: a 401 reads as "log in" to MCP clients and hides this message.
  const STALE = "This connection's key isn't valid for the world running now: the host switched worlds or removed this player. Ask your player to open the game, join, copy the new connect command from the game menu, and restart Claude Code with it.";
  const chatSeen = new Map<string, number>();
  const unseenChat = (who: string) => ctx.chatLog.filter((c) => c.seq > (chatSeen.get(who) ?? 0) && c.from !== speaker(who));
  /** Everything said since this Claude last looked, however long it was busy; a Claude new to the world gets the recent conversation. */
  function takeChat(who: string) {
    const cursor = chatSeen.get(who);
    const all = unseenChat(who);
    const unseen = cursor === undefined ? all.slice(-30) : all;
    const oldest = ctx.chatLog[0]?.seq ?? 0;
    const lost = cursor !== undefined && cursor < oldest - 1 ? `(${oldest - 1 - cursor} older lines are no longer kept)\n` : "";
    const lines = unseen.map((c) => `${c.claudes ? "[claudes] " : ""}${c.from}${c.spoken ? " (said aloud)" : ""}: ${c.text}`);
    chatSeen.set(who, ctx.chatLog.at(-1)?.seq ?? 0);
    const spoken = unseen.some((c) => c.spoken) ? "\n(said aloud) lines are what a player said into their microphone (hold T or open chat): often talk between players, not orders. See GUIDE.md, Listening to players." : "";
    return lines.length ? [{ type: "text", text: `In-game chat since your last look, oldest first:\n${lost}${lines.join("\n")}${spoken}` }] : [];
  }

  async function handle(msg: any, who: string | null) {
    const reply = (result: object) => ({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "sandbox", version: "1.0.0" },
          instructions,
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools });
      case "tools/call":
        if (!who) return reply({ content: [{ type: "text", text: STALE }], isError: true });
        try {
          const result = await call(msg.params.name, msg.params.arguments ?? {}, who);
          return reply({ content: [typeof result === "string" ? { type: "text", text: result } : { type: "image", data: result.image, mimeType: "image/jpeg" }, ...takeChat(who)] });
        } catch (e: any) {
          if (!(e instanceof ToolError)) console.error(e);
          return reply({ content: [{ type: "text", text: e.message }, ...takeChat(who)], isError: true });
        }
    }
    if (msg.id === undefined) return null;
    return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } };
  }

  const usage = (tool: (typeof tools)[number]) => {
    const props: Record<string, any> = tool.inputSchema.properties;
    const required: string[] = (tool.inputSchema as any).required ?? [];
    return [tool.name, ...Object.entries(props).map(([k, v]) => (required.includes(k) ? `${k}=<${v.type}>` : `[${k}=<${v.type}>]`))].join(" ");
  };

  /** The command line: the same tools as plain HTTP, for agents that would rather run a shell command than hold MCP tool schemas. */
  async function cli(req: Request, who: string | null, command: string, url: string | null, name: string | null) {
    if (!who) return new Response(`${STALE}
`, { status: 401 });
    if (command === "script") {
      if (!url || !name || !/^[a-z0-9-]{1,40}$/.test(name)) return new Response("Give ?url=<this world's public URL>&name=<command name>.\n", { status: 400 });
      return new Response(script(url, req.headers.get("authorization")!.slice(7), name), { headers: { "content-type": "text/x-shellscript" } });
    }
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
    const answer = async (): Promise<{ status: number; body: string | Blob; image?: boolean }> => {
      try {
        const result = await call(command, args, who);
        if (typeof result !== "string") return { status: 200, body: new Blob([Buffer.from(result.image, "base64")]), image: true };
        return { status: 200, body: [result, ...takeChat(who).map((c) => c.text)].join("\n\n") + "\n" };
      } catch (e: any) {
        if (!(e instanceof ToolError)) console.error(e);
        return { status: 422, body: [e.message, ...takeChat(who).map((c) => c.text)].join("\n\n") + "\n" };
      } finally {
        if (listening && !req.signal.aborted) ctx.presence(who, "working");
      }
    };
    if (!listening) {
      const { status, body, image } = await answer();
      return new Response(body, { status, headers: { "content-type": image ? "image/jpeg" : "text/plain; charset=utf-8" } });
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

  const http = async (req: Request, who: string | null) => {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const body = await req.json();
    const messages: any[] = Array.isArray(body) ? body : [body];
    const listening = messages.some((m) => m.params?.name === "wait_for_chat");
    if (who) {
      ctx.presence(who, listening ? "listening" : "working");
      // A Claude that quits mid-wait drops the request; one that finishes waiting goes on to work on what it heard.
      if (listening) req.signal.addEventListener("abort", () => ctx.presence(who, "offline"));
    }
    const answer = async () => {
      const replies = (await Promise.all(messages.map((m) => handle(m, who)))).filter(Boolean);
      if (who && listening && !req.signal.aborted) ctx.presence(who, "working");
      return Array.isArray(body) ? replies : replies[0];
    };
    if (messages.every((m) => m.id === undefined)) {
      await answer();
      return new Response(null, { status: 202 });
    }
    if (!req.headers.get("accept")?.includes("text/event-stream")) return Response.json(await answer());
    // Tunnels drop responses that stay silent for about 100 s, so slow calls like wait_for_chat stream keepalives until done.
    const encoder = new TextEncoder();
    let keepalive: Timer | undefined;
    return new Response(
      new ReadableStream({
        async start(stream) {
          keepalive = setInterval(() => stream.enqueue(encoder.encode(": keepalive\n\n")), 15_000);
          const reply = await answer();
          if (!keepalive) return;
          clearInterval(keepalive);
          stream.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(reply)}\n\n`));
          stream.close();
        },
        cancel() {
          clearInterval(keepalive);
          keepalive = undefined;
        },
      }),
      { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
    );
  };

  return { http, cli };
}

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** The command a player installs: POSIX sh and curl, so it runs on any Mac or Linux box without installing anything. */
const script = (url: string, key: string, name: string) => `#!/bin/sh
# Sandbox world ${name} from the command line. Run it alone for the tools and how to call them.
URL=${quote(url)}
KEY=${quote(key)}
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
    @*) set -- "$@" -F "$name=@\${value#@}" ;;
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
