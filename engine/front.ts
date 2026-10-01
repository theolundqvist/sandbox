import { join } from "node:path";

const CLIENT = join(import.meta.dir, "client");

/** The files of the front end shared by the main menu, the join screen and the in-game menu. Both the launcher and a world server serve them, so a world run on its own looks the same. */
export async function frontFile(path: string): Promise<Response | undefined> {
  if (path === "/front.js" || path === "/front.css") return new Response(Bun.file(join(CLIENT, path)));
  const [, dir, name = ""] = path.match(/^\/(stills|fonts|agents)\/(.*)$/) ?? [];
  if (!dir) return;
  const file = Bun.file(join(CLIENT, dir, name));
  return /^[\w-]+\.(webp|woff2|svg)$/.test(name) && (await file.exists()) ? new Response(file, { headers: { "cache-control": "max-age=86400" } }) : new Response("not found", { status: 404 });
}
