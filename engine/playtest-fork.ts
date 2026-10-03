// A playtest's world: copies the live world into its own folder, lets in only the playtest's player, then runs the game server there.
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyWorld } from "./archive";

const from = process.env.SANDBOX_PLAYTEST_FROM!;
const into = process.env.SANDBOX_DATA!;
const live = JSON.parse(await Bun.file(join(from, "config.json")).text());
await copyWorld(from, into);
const token = () => crypto.randomUUID().replaceAll("-", "");
// Open rules, so the playtest reloads any mod; nobody else's key works here, and no invite is ever handed out.
writeFileSync(join(into, "config.json"), JSON.stringify({ name: live.name, rules: "open", start: live.start, invite: token(), hostKey: token() }));
writeFileSync(join(into, "keys.json"), JSON.stringify({ [process.env.SANDBOX_PLAYTEST_KEY!]: process.env.SANDBOX_PLAYTEST_PLAYER! }));
// The live world's packages, read in place: nothing the copy runs installs packages.
if (existsSync(join(from, "world", "node_modules"))) symlinkSync(join(from, "world", "node_modules"), join(into, "world", "node_modules"), "dir");
await import("./server");
