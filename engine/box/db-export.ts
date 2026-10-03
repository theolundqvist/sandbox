// A mod can replace its database with a symlink at any time. Open mod databases only in a box
// that can read the db directory, never the symlink target outside it. The world's keys stay
// with the host: it finds them in the cells the box reports, then sends back only redacted
// replacements and hashes so boxed SQLite, not the host, updates and vacuums the snapshot.
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runBoxed } from "./build";

type Kind = "snapshot" | "community" | "apply";
type Cell = { table: string; column: string; kind: "text" | "blob"; value: string };
type Change = { table: string; column: string; kind: Cell["kind"]; hash: string; replacement: string };
const MOD_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const STEP_MS = 120_000;
const MODULES = ["db-export.ts", "build.ts", "bundle.ts", "index.ts"].map((name) => join(import.meta.dir, name));
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const digest = (kind: Cell["kind"], bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(kind).update(bytes).digest("hex");

export function removeRecordedChat(db: Database) {
  if (!db.query("select 1 from pragma_table_info('timelapse') where name = 'activity'").get()) return 0;
  return db.run(`update timelapse set activity = (select json_group_array(json(value)) from json_each(timelapse.activity) where json_extract(value, '$.t') is not 'chat') where json_valid(activity) and exists (select 1 from json_each(timelapse.activity) where json_extract(value, '$.t') = 'chat')`).changes;
}

/** The raw text and compressed blobs in a snapshot, read only inside the box. */
function cells(db: Database): Cell[] {
  const out: Cell[] = [];
  const tables = db.query("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as { name: string }[];
  for (const { name: table } of tables) {
    const columns = db.query("select name from pragma_table_info(?)").all(table) as { name: string }[];
    for (const { name: column } of columns) {
      const col = quote(column);
      const tableSql = quote(table);
      for (const { value } of db.query(`select ${col} value from ${tableSql} where typeof(${col}) = 'text' or (typeof(${col}) = 'blob' and substr(${col}, 1, 2) = x'1f8b')`).all() as { value: string | Uint8Array }[])
        out.push({ table, column, kind: typeof value === "string" ? "text" : "blob", value: typeof value === "string" ? value : Buffer.from(value).toString("base64") });
    }
  }
  return out;
}

/** Keep the optional public-publish check in the trusted host, after boxed SQLite extracts cells but before any bytes leave as an archive. */
export async function readModDatabase(dbDir: string, mod: string, secrets: string[], community = false, verify?: (value: string) => void): Promise<Uint8Array<ArrayBufferLike>> {
  if (!MOD_NAME.test(mod)) throw new Error("Invalid mod database name.");
  const scratch = mkdtempSync(join(tmpdir(), "sandbox-db-export-"));
  try {
    const destination = join(scratch, "snapshot.sqlite");
    const run = async (kind: Kind, additional: string[] = []) => {
      const { code, err, timedOut } = await runBoxed({
        cmd: [process.execPath, import.meta.path, dbDir, mod, kind, destination, ...additional],
        cwd: scratch, scratch, read: kind === "apply" ? MODULES : [dbDir, ...MODULES],
      }, STEP_MS);
      if (timedOut || code) throw new Error(`The mod database couldn't be exported: ${timedOut ? "it timed out" : err.trim().slice(-500) || `exit code ${code}`}.`);
    };
    await run(community ? "community" : "snapshot");
    const scanned = JSON.parse(readFileSync(join(scratch, "cells.json"), "utf8")) as Cell[];
    const changes: Change[] = [];
    const scrub = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, "[secret]"), value);
    for (const cell of scanned) {
      const bytes = cell.kind === "text" ? Buffer.from(cell.value) : Buffer.from(cell.value, "base64");
      const text = cell.kind === "text" ? cell.value : new TextDecoder().decode(Bun.gunzipSync(bytes));
      verify?.(text);
      const clean = scrub(text);
      if (clean === text) continue;
      changes.push({ table: cell.table, column: cell.column, kind: cell.kind, hash: digest(cell.kind, bytes),
        replacement: cell.kind === "text" ? clean : Buffer.from(Bun.gzipSync(clean)).toString("base64") });
    }
    if (changes.length) {
      const path = join(scratch, "changes.json");
      writeFileSync(path, JSON.stringify(changes));
      await run("apply", [path]);
    }
    return readFileSync(destination);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [dbDir, mod, mode, destination, changesPath] = process.argv.slice(2);
  if (!dbDir || !mod || !MOD_NAME.test(mod) || !destination || !["snapshot", "community", "apply"].includes(mode ?? "")) throw new Error("Invalid mod database export.");
  if (mode === "apply") {
    if (!changesPath) throw new Error("No scrub changes provided.");
    const changes = JSON.parse(readFileSync(changesPath, "utf8")) as Change[];
    const changesByCell = new Map(changes.map((change) => [JSON.stringify([change.table, change.column, change.kind, change.hash]), change]));
    const db = new Database(destination);
    try {
      db.run("pragma trusted_schema = off");
      db.transaction(() => {
        for (const cell of cells(db)) {
          const original = cell.kind === "text" ? cell.value : Buffer.from(cell.value, "base64");
          const hash = digest(cell.kind, typeof original === "string" ? Buffer.from(original) : original);
          const change = changesByCell.get(JSON.stringify([cell.table, cell.column, cell.kind, hash]));
          if (!change) continue;
          const updated = change.kind === "text" ? change.replacement : Buffer.from(change.replacement, "base64");
          db.query(`update ${quote(cell.table)} set ${quote(cell.column)} = ? where ${quote(cell.column)} = ?`).run(updated, original);
        }
      })();
      db.run("vacuum");
    } finally { db.close(); }
  } else {
    const db = new Database(join(dbDir, `${mod}.sqlite`), { readonly: true });
    try {
      db.run("pragma trusted_schema = off");
      db.run("pragma busy_timeout = 5000");
      db.run("vacuum into ?", [destination]);
      const copy = new Database(destination, mode === "community" ? { readwrite: true } : { readonly: true });
      try {
        copy.run("pragma trusted_schema = off");
        if (mode === "community" && removeRecordedChat(copy)) copy.run("vacuum");
        await Bun.write(join(dirname(destination), "cells.json"), JSON.stringify(cells(copy)));
      } finally { copy.close(); }
    } finally { db.close(); }
  }
}
