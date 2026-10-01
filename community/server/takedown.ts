// Moderation from the box: `bun takedown.ts` lists the most reported worlds, `bun takedown.ts <id>` deletes one and its files.
import { sql, takeDown } from "./server";

const id = process.argv[2];
if (!id) console.table(await sql`select id, title, author, visibility, reports, created_at from worlds where zip_key is not null order by reports desc, created_at desc limit 20`);
else {
  const [row] = await sql`select * from worlds where id = ${id}`;
  if (!row) throw new Error(`There is no world ${id}.`);
  await takeDown(row);
  console.log(`Took down ${id} (${row.title} by ${row.author}).`);
}
await sql.close();
