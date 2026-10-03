// After a restore: `bun replay.ts <dump time>` redoes every removal logged since that dump.
import { bucketFromEnv, client } from "./r2";
import { removeAccount, sql, takeDown } from "./server";

const since = process.argv[2];
if (!since || Number.isNaN(Date.parse(since))) throw new Error("Give the restored dump's time, like 2026-10-03T12:00:00.000Z.");
const files = client(bucketFromEnv(process.env.R2_BUCKET!));
const keys: string[] = [];
for (let token: string | undefined; ; ) {
  const page = await files.list({ prefix: "deletions/", continuationToken: token });
  keys.push(...(page.contents ?? []).map((o) => o.key));
  if (!page.isTruncated) break;
  token = page.nextContinuationToken;
}
let replayed = 0;
for (const key of keys.sort()) {
  const [, at, kind, rest] = key.match(/^deletions\/(\S+?Z)-(world|account)-(.+)$/) ?? [];
  if (!at || at < new Date(since).toISOString()) continue;
  if (kind === "account") {
    await removeAccount(rest!);
  } else {
    const [by, id] = rest!.split("-") as ["owner" | "account" | "moderator", string];
    const [row] = await sql`select * from worlds where id = ${id} and removed_at is null`;
    if (row) await takeDown(row, by, false);
  }
  replayed++;
}
console.log(`Replayed ${replayed} removals since ${since}.`);
await sql.close();
