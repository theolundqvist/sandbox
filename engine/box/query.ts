import { Database } from "bun:sqlite";

const [path, sql] = process.argv.slice(2);
if (!path || !sql) throw new Error("A database and query are required.");
const statement = sql.replace(/^(?:[\s;]|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)*/, "");
if (/^(?:attach|vacuum)\b/i.test(statement)) throw new Error("query_db cannot attach or copy databases.");
const db = new Database(path, { readonly: true });
try {
  db.run("pragma busy_timeout = 2000; pragma query_only = on");
  const rows = db.query(sql).all();
  process.stdout.write(JSON.stringify(rows.slice(0, 100), null, 1) + (rows.length > 100 ? `\n(${rows.length} rows, first 100 shown)` : ""));
} finally {
  db.close();
}
