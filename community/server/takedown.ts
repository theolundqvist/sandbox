// Moderation from the box: `bun takedown.ts` lists the most reported worlds, `bun takedown.ts <id>` takes one down for good, `bun takedown.ts ban <username>` bans an account, `bun takedown.ts comments` lists the most reported comments and `bun takedown.ts comment <id>` removes one.
import { sql, takeDown } from "./server";

const [first, second] = process.argv.slice(2);
if (!first) console.table(await sql`select id, title, author, visibility, reports, created_at from worlds where zip_key is not null order by reports desc, created_at desc limit 20`);
else if (first === "comments")
  console.table(await sql`select c.id, a.username, c.world, left(c.body, 80) as body, count(r.*)::int as reports from comments c join accounts a on a.id = c.account join reports r on r.kind = 'comment' and r.target = c.id::text
    where c.removed_at is null group by c.id, a.username order by reports desc limit 20`);
else if (first === "comment") {
  const [c] = await sql`update comments set removed_at = now(), removed_by = 'moderator', body = '' where id = ${Number(second) || 0} and removed_at is null returning id`;
  if (!c) throw new Error(`There is no comment ${second}.`);
  console.log(`Removed comment ${second}.`);
} else if (first === "ban") {
  // A banned account can't publish, comment or message, and its worlds leave discovery.
  const [account] = await sql`update accounts set banned_at = now() where username = ${second ?? ""} returning username`;
  if (!account) throw new Error(`There is no account ${second}.`);
  console.log(`Banned ${account.username}.`);
} else {
  const [row] = await sql`select * from worlds where id = ${first} and removed_at is null`;
  if (!row) throw new Error(`There is no world ${first}.`);
  await takeDown(row, "moderator");
  console.log(`Took down ${first} (${row.title} by ${row.author}).`);
}
await sql.close();
