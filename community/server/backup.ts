// Hourly: the whole database, dumped and compressed into the backups bucket, then old dumps thinned. `bun backup.ts once` runs one now.
import { bucketFromEnv, client } from "./r2";
import { expired } from "./retention";

const backups = client(bucketFromEnv(process.env.R2_BACKUP_BUCKET!));

async function backup() {
  const dump = Bun.spawn(["sh", "-o", "pipefail", "-c", 'pg_dump --no-owner -h /var/run/postgresql -U "$POSTGRES_USER" "$POSTGRES_DB" | zstd -q -10'], { env: { ...process.env, PGPASSWORD: process.env.POSTGRES_PASSWORD }, stdout: "pipe", stderr: "inherit" });
  const bytes = await new Response(dump.stdout).bytes();
  if (await dump.exited) throw new Error(`pg_dump exited ${dump.exitCode}`);
  const key = `pg/${new Date().toISOString()}.sql.zst`;
  await backups.write(key, bytes, { type: "application/zstd" });
  if ((await backups.stat(key)).size !== bytes.length) throw new Error(`${key} didn't land whole`);
  console.log(`backed up ${key} (${bytes.length} bytes)`);
  // Thinning only ever follows a backup that landed.
  const keys: string[] = [];
  for (let token: string | undefined; ; ) {
    const page = await backups.list({ prefix: "pg/", continuationToken: token });
    keys.push(...(page.contents ?? []).map((o) => o.key));
    if (!page.isTruncated) break;
    token = page.nextContinuationToken;
  }
  for (const old of expired(keys, Date.now())) await backups.delete(old);
}

if (process.argv[2] === "once") await backup();
else
  for (;;) {
    await backup().catch((e) => console.error("backup failed", e));
    await Bun.sleep(3600_000);
  }
