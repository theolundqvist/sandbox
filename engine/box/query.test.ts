import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { box, boxReason } from "./index";

const root = mkdtempSync(join(tmpdir(), "sandbox-query-"));
const dbDir = join(root, "db");
mkdirSync(dbDir);
const path = join(dbDir, "notes.sqlite");
const db = new Database(path);
db.run("create table notes (text); insert into notes values ('public note')");
db.close();
const outside = join(root, "world.sqlite");
const secret = new Database(outside);
secret.run("create table secret (value); insert into secret values ('CANARY-SQL-SECRET')");
secret.close();
const runner = join(import.meta.dir, "query.ts");
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function query(sql: string, database = path) {
  const proc = box({ cmd: [process.execPath, runner, database, sql], read: [runner, dbDir] });
  const [out, err, code] = await Promise.all([new Response(proc.stdout as ReadableStream<Uint8Array>).text(), new Response(proc.stderr as ReadableStream<Uint8Array>).text(), proc.exited]);
  expect((out + err).includes("CANARY-SQL-SECRET")).toBe(false);
  return { out, err, code };
}

test("read-only mod queries cannot attach, copy, mutate, or follow a database symlink outside their box", async () => {
  expect(boxReason()).toBeNull();
  const read = await query("with chosen as (select text from notes) select * from chosen");
  expect(read.code).toBe(0);
  expect(JSON.parse(read.out)).toEqual([{ text: "public note" }]);
  for (const sql of [
    `; -- leading empty statement\n /* comment */ AtTaCh DATABASE '${outside}' AS other`,
    `/* export */ VACUUM INTO '${join(root, "copied.sqlite")}'`,
    "attach database ':memory:' as other",
    "delete from notes",
  ]) expect((await query(sql)).code).not.toBe(0);
  expect(existsSync(join(root, "copied.sqlite"))).toBe(false);
  symlinkSync(outside, join(dbDir, "alias.sqlite"));
  expect((await query("select value from secret", join(dbDir, "alias.sqlite"))).code).not.toBe(0);
  expect(JSON.parse((await query("select text from notes")).out)).toEqual([{ text: "public note" }]);
}, 15_000);
