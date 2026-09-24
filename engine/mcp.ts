import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Mods } from "./mods";
import type { SimHost } from "./simhost";

export type McpContext = {
  root: string;
  dbDir: string;
  rules: () => "open" | "additive";
  owners: Record<string, string>;
  saveOwners(): void;
  mods: Mods;
  sim: SimHost;
  logs: { at: number; mod: string; level: string; text: string }[];
  feed(text: string, kind?: string): void;
  chat(from: string, text: string): void;
  status(): object;
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
      "Put a mod live for every player without disconnecting anyone: typechecks it, builds it, test-runs it against a copy of the live world, then hot-swaps server and client code. If any step fails nothing changes and you get the error.",
    inputSchema: { type: "object", properties: { mod: { type: "string" } }, required: ["mod"] },
  },
  {
    name: "logs",
    description: "Recent console output and errors from server and client mods (client errors are reported by every player's game).",
    inputSchema: { type: "object", properties: { mod: { type: "string" }, limit: { type: "number" } } },
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
    description: "See the 3D view your player sees right now (they must have the game open; HTML overlays are not included). Use it to check your visuals.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "add_package",
    description:
      "Install an npm package (e.g. \"@dimforge/rapier3d-compat\", \"simplex-noise@4\") so any mod can import it on the server or client. Packages are shared by every mod and cannot be removed.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "say",
    description: "Post a short message in the in-game chat, shown as your player's Claude. Tell people what you just built.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];

export const instructions = `This is a live multiplayer game that the players build together while playing. Every player's Claude edits the same shared file tree on the game server.
Workflow: call status, read GUIDE.md and api.ts, then write or edit files under mods/<your-mod>/ and call reload to put them live for everyone. Nothing you write affects the game until reload succeeds.
Other Claudes are editing at the same time: always re-read a file right before changing it, and keep each feature in its own mod folder.
Mods can hide entities per player, send one-off events, call each other's exports, fetch any HTTP or MCP API asynchronously, load models or sounds added with add_asset, and import npm packages added with add_package. Use screenshot to see what your player sees; GUIDE.md shows how.`;

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
    ctx.feed(`${who}'s Claude is editing ${rel.replace(/^mods\//, "")}`, "info");
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
        const result = await ctx.mods.reload(mod, who, ctx.owners[mod]!);
        if (!result.ok) throw new ToolError(result.report);
        return result.report;
      }
      case "logs": {
        const lines = ctx.logs.filter((l) => !args.mod || l.mod === args.mod).slice(-(args.limit ?? 50));
        return lines.map((l) => `${new Date(l.at).toISOString().slice(11, 19)} [${l.mod}] ${l.level}: ${l.text}`).join("\n") || "No logs yet.";
      }
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
        ctx.feed(`${who}'s Claude added the ${spec} package`, "info");
        return `${out.trim().split("\n").slice(-3).join("\n")}\nImport it from any mod, then reload that mod.`;
      }
      case "say":
        ctx.chat(`${who}'s Claude`, String(args.text).slice(0, 300));
        return "Said.";
    }
    throw new ToolError(`Unknown tool ${name}`);
  }

  async function handle(msg: any, who: string) {
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
        try {
          const result = await call(msg.params.name, msg.params.arguments ?? {}, who);
          return reply({ content: [typeof result === "string" ? { type: "text", text: result } : { type: "image", data: result.image, mimeType: "image/jpeg" }] });
        } catch (e: any) {
          if (!(e instanceof ToolError)) console.error(e);
          return reply({ content: [{ type: "text", text: e.message }], isError: true });
        }
    }
    if (msg.id === undefined) return null;
    return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } };
  }

  return async (req: Request, who: string) => {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const body = await req.json();
    const replies = (await Promise.all((Array.isArray(body) ? body : [body]).map((m) => handle(m, who)))).filter(Boolean);
    if (!replies.length) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(body) ? replies : replies[0]);
  };
}
