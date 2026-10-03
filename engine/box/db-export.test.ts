import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { boxReason } from "./index";
import { readModDatabase } from "./db-export";

const base = join(import.meta.dir, "../../.scratch/test-tmp");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, "db-export-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const data = join(root, "world-data");
const dbDir = join(data, "db");
const outside = join(root, "fake-home/private.sqlite");
const canary = `SYNTHETIC-OUTSIDE-${crypto.randomUUID()}`;
mkdirSync(dbDir, { recursive: true });
mkdirSync(join(root, "fake-home"));
writeFileSync(join(data, "config.json"), JSON.stringify({ name: "Garden", start: "blank", rules: "open", hostKey: "synthetic-host-key", invite: "synthetic-invite" }));
const secret = new Database(outside);
secret.run("create table hidden(value text)");
secret.query("insert into hidden values (?)").run(canary);
secret.close();
const garden = new Database(join(dbDir, "garden.sqlite"));
garden.run("create table notes(note text, image blob, count integer)");
garden.query("insert into notes values (?, ?, ?)").run("the well is north", Buffer.from([0, 1, 255]), 4);
garden.close();

async function pack(dir: string, publicWorld = false) {
  const worker = new Worker(new URL("../archive.ts", import.meta.url));
  const { promise, resolve, reject } = Promise.withResolvers<{ zip?: Uint8Array; error?: string }>();
  worker.onmessage = ({ data }) => resolve(data);
  worker.onerror = (error) => reject(new Error(error.message));
  worker.postMessage({ t: "pack", dir, community: publicWorld });
  try { return await promise; } finally { worker.terminate(); }
}

test("a legitimate mod database exports its schema, rows and blobs, with the world's keys scrubbed", async () => {
  expect(boxReason()).toBeNull();
  const writer = new Database(join(dbDir, "garden.sqlite"));
  writer.query("insert into notes values (?, ?, ?)").run("contains synthetic-host-key", Bun.gzipSync("also synthetic-invite"), 6);
  writer.close();
  const exported = await pack(data);
  expect(exported.error).toBeUndefined();
  const archived = unzipSync(exported.zip!);
  expect(Object.values(archived).some((bytes) => Buffer.from(bytes).includes(Buffer.from("synthetic-host-key")) || Buffer.from(bytes).includes(Buffer.from("synthetic-invite")))).toBe(false);
  const copy = join(root, "archive-garden.sqlite");
  writeFileSync(copy, archived["db/garden.sqlite"]!);
  const db = new Database(copy, { readonly: true });
  try {
    expect(db.query("select note, image, count from notes where count = 4").get()).toEqual({ note: "the well is north", image: new Uint8Array([0, 1, 255]), count: 4 });
    const scrubbed = db.query("select note, image from notes where count = 6").get() as { note: string; image: Uint8Array };
    expect(scrubbed.note).toBe("contains [secret]");
    expect(new TextDecoder().decode(Bun.gunzipSync(Buffer.from(scrubbed.image)))).toBe("also [secret]");
  } finally { db.close(); }
});

test("Community checks compressed mod and world database cells before publishing", async () => {
  expect(boxReason()).toBeNull();
  const dir = join(root, "public-data");
  mkdirSync(join(dir, "db"), { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name: "Garden", hostKey: "synthetic-host-canary", invite: "synthetic-invite-canary" }));
  const mod = new Database(join(dir, "db/garden.sqlite"));
  mod.run("create table notes (content blob)");
  const token = "sk_voice_0123456789abcdefghij";
  mod.query("insert into notes values (?)").run(Bun.gzipSync(`synthetic ${token}`));
  mod.close();
  const modLeak = await pack(dir, true);
  expect(modLeak.zip).toBeUndefined();
  expect(modLeak.error).toContain("mod database");
  expect(modLeak.error).not.toContain(token);
  const cleanMod = new Database(join(dir, "db/garden.sqlite"));
  cleanMod.run("delete from notes");
  cleanMod.close();
  const world = new Database(join(dir, "world.sqlite"));
  world.run("create table moments (content blob)");
  world.query("insert into moments values (?)").run(Bun.gzipSync(`synthetic ${token}`));
  world.close();
  const worldLeak = await pack(dir, true);
  expect(worldLeak.zip).toBeUndefined();
  expect(worldLeak.error).toContain("world database");
  const cleanWorld = new Database(join(dir, "world.sqlite"));
  cleanWorld.run("delete from moments");
  cleanWorld.close();
  const safe = await pack(dir, true);
  expect(safe.error).toBeUndefined();
  expect(unzipSync(safe.zip!)["db/garden.sqlite"]).toBeDefined();
});

test("Community removes recorded chat inside boxed mod snapshots without changing private exports or source data", async () => {
  const dir = join(root, "privacy-data");
  mkdirSync(join(dir, "db"), { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name: "Garden" }));
  const path = join(dir, "db/garden.sqlite");
  const source = new Database(path);
  const feed = { t: "feed", text: "the garden grew" };
  const chat = { t: "chat", text: "SYNTHETIC-PRIVATE-CHAT" };
  source.run("create table timelapse (activity text)");
  source.query("insert into timelapse values (?)").run(JSON.stringify([feed, chat]));
  source.close();
  for (const community of [false, true]) {
    const exported = await pack(dir, community);
    expect(exported.error).toBeUndefined();
    const bytes = unzipSync(exported.zip!)["db/garden.sqlite"]!;
    const copy = join(root, `privacy-${community}.sqlite`);
    writeFileSync(copy, bytes);
    const db = new Database(copy, { readonly: true });
    try {
      const row = db.query("select activity from timelapse").get() as { activity: string };
      expect(JSON.parse(row.activity)).toEqual(community ? [feed] : [feed, chat]);
      expect(Buffer.from(bytes).includes(Buffer.from(chat.text))).toBe(!community);
    } finally { db.close(); }
  }
  const unchanged = new Database(path, { readonly: true });
  try {
    expect(unchanged.query("select activity from timelapse").get()).toEqual({ activity: JSON.stringify([feed, chat]) });
  } finally { unchanged.close(); }
});

test("an extra file in a mod's db folder never becomes an export, even when it points outside", async () => {
  symlinkSync(outside, join(dbDir, "bait.txt"));
  const exported = await pack(data);
  expect(exported.error).toBeUndefined();
  const archived = unzipSync(exported.zip!);
  expect(archived["db/bait.txt"]).toBeUndefined();
  expect(Object.values(archived).some((bytes) => Buffer.from(bytes).includes(Buffer.from(canary)))).toBe(false);
});

test("a mod database symlink to a synthetic outside SQLite is never opened by the exporter", async () => {
  expect(boxReason()).toBeNull();
  symlinkSync(outside, join(dbDir, "hostile.sqlite"));
  const direct = await readModDatabase(dbDir, "hostile", []).then(() => null, (e: Error) => e.message);
  expect(typeof direct).toBe("string");
  expect(direct!.includes(canary)).toBe(false);
  const exported = await pack(data);
  expect(typeof exported.error).toBe("string");
  expect(exported.zip).toBeUndefined();
  expect(exported.error!.includes(canary)).toBe(false);
  expect(existsSync(outside) && readFileSync(outside).includes(Buffer.from(canary))).toBe(true);
}, 30_000);
