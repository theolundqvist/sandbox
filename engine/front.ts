import { readdirSync } from "node:fs";
import { join } from "node:path";

const CLIENT = join(import.meta.dir, "client");

/** The files of the front end shared by the main menu, the join screen and the in-game menu. Both the launcher and a world server serve them, so a world run on its own looks the same. */
export async function frontFile(path: string): Promise<Response | undefined> {
  if (path === "/front.js" || path === "/front.css") return new Response(Bun.file(join(CLIENT, path)));
  // The menus' background: every clip dropped into engine/client/clips plays.
  if (path === "/clips/") return Response.json(readdirSync(join(CLIENT, "clips")).filter((f) => f.endsWith(".mp4")));
  const [, dir, name = ""] = path.match(/^\/(clips|fonts)\/(.*)$/) ?? [];
  if (!dir) return;
  const file = Bun.file(join(CLIENT, dir, name));
  return /^[\w-]+\.(mp4|jpg|woff2)$/.test(name) && (await file.exists()) ? new Response(file, { headers: { "cache-control": "max-age=86400" } }) : new Response("not found", { status: 404 });
}
