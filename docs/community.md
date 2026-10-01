# Community worlds

A host shares a world from the game: Tab, World, Share. Anyone hosts or remixes it from Worlds, Community in the app, and the site lists the public ones and gives each world its own page.

## What goes up

| Part | What it is |
| --- | --- |
| World | Exactly what Export makes: every mod and its history, the entities, each mod's database, the record and the timelapse. The invite, the host key and players' keys are never in it, and every copy of them in a database is replaced with `[secret]`. Players' names, chat and banners stay in, as in any export. |
| Cover | The world's picture (`cover.jpg`, the host's view without the HUD or name tags), or the current view. |
| Clip | The whole timelapse played back in 12 s and recorded in the host's game: muted 640×360 WebM, without name tags. A world with nothing to replay yet goes up without one. |
| Details | Title, a one-line description, the host's player name as author, link-only or public, the world it was remixed from, the engine version and the mod count. |

Link-only worlds open by their link and are never listed. Sharing a world again updates the same community world. There is no sign-in: the launcher keeps each shared world's owner token in `data/community.json` (mode 600, outside every world's folder, so no export carries it), and only that token updates or deletes it. Mods are code that runs on whoever hosts them, so Host and Remix of anyone else's world first say "This world runs code from <author>. Only play worlds from people you trust."

## Service

`community/` holds the Worker (`worker.ts`, D1 table in `schema.sql`, zips, covers and clips in R2) and the site (`site/`, built into `dist/` with the game's own styles by `build-site.sh`).

| Endpoint | Does |
| --- | --- |
| `POST /worlds` | Multipart details, cover (JPEG, 2 MB) and optional clip (WebM, 6 MB). Answers `{ id, link, ownerToken }`. 10 per IP an hour. |
| `PUT /worlds/:id` | Same, with `Authorization: Bearer <ownerToken>`; a missing cover or clip keeps the old one. |
| `PUT /worlds/:id/zip` | The export's zip as the raw body, at most 95 MB. A world is listed and served only once it has one. |
| `DELETE /worlds/:id` | Owner only. Removes the row and its files. |
| `GET /worlds` | Public worlds with a zip, newest first. |
| `GET /worlds/:id`, `/zip`, `/cover`, `/clip` | One world and its files, link-only included. |
| `POST /worlds/:id/report` | Counts a report. 10 per IP an hour. |

Test it with `cd community && bun install && bun test worker.test.ts` (wrangler dev with local D1 and R2), and the launchers against it with `bun test engine/community.test.ts`. Deploy with `bun run deploy` from `community/`.

## Takedown

Reported worlds come first: `npx wrangler d1 execute sandbox-community --remote --command "select id, title, author, visibility, reports from worlds order by reports desc limit 20"`. To take one down:

```sh
cd community
npx wrangler d1 execute sandbox-community --remote --command "delete from worlds where id = '<id>'"
for f in world.zip cover.jpg clip.webm; do npx wrangler r2 object delete "sandbox-community/worlds/<id>/$f" --remote; done
```

Its owner's next Share puts it up again as a new world, so a world that must stay down needs its author told.
