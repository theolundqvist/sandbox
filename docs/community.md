# Community worlds

A host shares a world from the game: Tab, World, Share. Anyone hosts or remixes it from Worlds, Community in the app, and the site lists the public ones and gives each world its own page.

## What goes up

| Part | What it is |
| --- | --- |
| World | What Export makes, without what its players did and said: every mod and its history, the entities and each mod's database, and `owners.json`, so mod authors keep their credit. Rewind and the Timelapse go with it, but without the chat in their moments; the record (chat, tool calls, sessions) and where each player sits (`seats.json`) are left out. Player names that are part of the game, in scores and items, stay. The invite, the host key and players' keys are never in it, and every copy of them in a database is replaced with `[secret]`. |
| Cover | The world's picture (`cover.jpg`, the host's view without the HUD or name tags), or the current view. |
| Clip | The whole timelapse played back in 12 s and recorded in the host's game: muted 640×360 WebM, without name tags. A world with nothing to replay yet goes up without one. |
| Details | Title, a one-line description, the host's player name as author, link-only or public, the world it was remixed from, the engine version and the mod count. |

Link-only worlds open by their link and are never listed. Sharing a world again updates the same community world. There is no sign-in: the launcher keeps each shared world's owner token in `data/community.json` (mode 600, outside every world's folder, so no export carries it), and only that token updates or deletes it. Mods are code that runs on whoever hosts them, so Host and Remix of anyone else's world first say "This world runs code from <author>. Only play worlds from people you trust."

## Service

`community/server/` is a Bun API with Postgres for the rows; zips, covers and clips live in the R2 bucket `sandbox-worlds` and never pass through the server, which hands out presigned URLs signed for each file's exact size and type. `community/site/` is the site, built into `dist/` with the game's own styles by `build-site.sh`.

| Endpoint | Does |
| --- | --- |
| `POST /worlds` | JSON details and `files: { zip, cover, clip? }` sizes (zip 200 MB, JPEG cover 2 MB, WebM clip 6 MB). Answers `{ id, link, ownerToken, uploads }`, an upload URL per file. 10 per IP an hour. |
| `PUT /worlds/:id` | Same, with `Authorization: Bearer <ownerToken>`; a cover or clip not sent keeps the old one. 30 per IP an hour. |
| `POST /worlds/:id/done` | Owner only, after the uploads. Checks each file landed at its size and is the kind it claims, then the world goes live; an update replaces the old files only now. |
| `DELETE /worlds/:id` | Owner only. Removes the row and its files. |
| `GET /worlds` | Public live worlds, newest first. |
| `GET /worlds/:id` | One world, link-only included, with `zip`, `cover` and `clip` URLs that last the hour. |
| `POST /worlds/:id/report` | Counts a report. 10 per IP an hour. |

Shares never finished are swept after a day. The site's origin is the only one browsers may read the API from.

## Free voice

The same API gives every install of the app voice without a key of its own: speech to text and text to speech through ElevenLabs, never a language model. On first start the launcher signs up with `POST /installs` and keeps the token it gets in `data/secrets.json`; Postgres keeps only its hash.

| Endpoint | Does |
| --- | --- |
| `POST /installs` | Answers `{ id, token }`. 5 per IP an hour. |
| `POST /ai/tts` | `{ text, voice? }`, 2,000 characters at most; answers MP3. |
| `POST /ai/stt` | The recording as the body, 60 s (512 KB) at most; answers `{ text }`. |
| `GET /ai/usage` | `{ used, of }` in dollars. |

Each takes `Authorization: Bearer <token>`, 30 calls a minute. Calls are charged at ElevenLabs' list price (the table is in `server.ts`) against $1 per install for good and $20 for everyone per UTC day, both counted in one Postgres statement so calls at the same moment can't go over; a transcript is held at a minute's price and settled to its length, and a call ElevenLabs fails costs nothing. Past either limit the call is refused with "Free voice is used up on this computer." or "Free voice is paused for today." The ElevenLabs key lives in `providers.env` on the box, passed only to the API container.

Test it with `bun test community/server` (throwaway Postgres and SeaweedFS for S3 in Docker), and the launchers against it with `bun test engine/community.test.ts`.

## Running it

It runs on the `npm` box in `/opt/sandbox-api` as its own Compose project (`compose.yaml`): Postgres listening only on a socket in a volume shared with the API and the backups, password auth, no network but an internal one; the API on `127.0.0.1:9200` behind Nginx Proxy Manager at `sandbox.api.lundqvistliss.com`, non-root, read-only, no capabilities. `db.env`, `r2.env` (the bucket-scoped R2 key) and `providers.env` (the ElevenLabs key) exist only on the box. Deploy with `community/server/deploy.sh`; the site with `bun run deploy-site` from `community/` (Pages project `sandbox`, `sandbox.lundqvistliss.com`).

Backups: every hour `pg_dump | zstd` to `sandbox-backups/pg/<time>.sql.zst`, then, only after that upload landed, older dumps are thinned to everything from 48 hours, one a day for 30 days and one a month for a year. Restore one with `zstd -dc <dump> | psql`.

## Takedown

On the box, `cd /opt/sandbox-api && docker compose exec app bun takedown.ts` lists the most reported worlds; `docker compose exec app bun takedown.ts <id>` deletes one and its files.

Its owner's next Share puts it up again as a new world, so a world that must stay down needs its author told.
