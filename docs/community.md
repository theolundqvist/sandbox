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

Each mod's database goes into the zip from inside the mod sandbox, which can read only the world's `db/` folder: a mod that swaps its database for a link to a file elsewhere stops the export instead of putting that file in it, and nothing else in `db/` is ever read. Host and Remix unpack a zip as Import world does. Only a world's own parts come in, and of `world/` only the mods and the files the engine writes there. Its `package.json` keeps only npm registry packages by plain version and its `bun.lock` only plain registry entries, installed in the mod sandbox without their scripts. Its `.git` keeps only the history, under a config the engine writes, with none of the stranger's hooks, attributes or pointers to other repositories. Settings files Bun or git would obey, such as `bunfig.toml` or `.npmrc`, stay out.

Sharing also refuses known host, player and service credentials, including Community install and owner tokens, and recognizable key formats, in the archive, Git history, details or media bytes. Private Export keeps its full-world behavior; unknown passwords and concealed secrets are not reliably recognizable.

## Origins: the host's computer and the relay

A browser keeps a page's storage, and what its code may read, per origin: scheme, host and port. Every world's mods run in the page of the world being played, so whatever else that origin holds, they can read.

On the host's computer the launcher answers at two origins:

| Origin | Serves | Holds |
| --- | --- | --- |
| `http://127.0.0.1:<port>` | The main menu, the host's controls page (`host.html`), the menu's API and the front end's files. Never a world's page, code, files or socket. | The menu's key: `/api/local-key` answers only this origin's own pages, on this computer, without CORS, uncached. |
| `http://localhost:<port>` | The running world, for the host to play. Its `/menu` sends the host to the menu's origin; its `/api/menu/` and `/api/local-key` refuse even the right key. | The host's player key for the world, like any player's. |

The host's World page (export, stop hosting, rewind), its Share page and their speech key are frames of `host.html` inside their game. The game asks those frames for four things only, each about the world running as they opened: join it as the host, which returns the host's own player key; take a new picture of it; show or focus the controls; and open Share, offering its mods' titles as the default description. The Share frame reads the world's shared state and saved cover itself and asks the game only for media, the current view and the timelapse clip; every other field is typed or picked in the frame, its Share and Stop sharing act only on the world it opened for, and it names no author, so the launcher names the world's host. Stopping, exporting, rewinding, sharing and the speech key go only through the frames' own buttons. Neither the menu's key, a shared world's owner token, the world's host key nor the speech key ever reaches the game's page, and no link the menu opens carries them: the host plays from the world's invite link, and watches the timelapse with a pass that plays once within two minutes.

Origin isolation stops a mod reading the frame's credentials, not UI redressing: the game page and its mods can move or disguise an iframe they contain to trick the host into clicking it. For sensitive host actions, open the top-level main menu instead of trusting how a game page presents the controls.

The first player name that becomes host still comes from the game's realm, where a mod can race the join screen; this does not reveal an admin key or another player's key, but first-host selection is **not** an agent-safe authorization boundary. Once a host name is set, new names joined through the frame cannot replace it.

### The relay: one origin per room

The contract: each room is its own origin, so one world's code can never read what another world's page keeps.

The relay doesn't meet it yet. Every room is a path, `/r/<room>/`, on the relay's one origin, and the page each room serves keeps its player's key in that origin's `localStorage` (`sandbox-key:<world id>`), as the rejoin link the game needs. So the mods of any world played through the relay can read the player keys of every other world that browser has joined through it, and join those worlds as those players: build, chat and drive agents' tools with their rights. The same holds, on a smaller scale, for the worlds one launcher hosts in turn at `localhost:<port>` or at its Wi-Fi address, Community worlds hosted or remixed there included. Moving the keys to `sessionStorage` would not close this: it is per origin too, and another room's page in the same tab reads it the same way. Only a separate origin per room, such as `https://<room>.<relay domain>/`, does.

What meeting it takes, on the relay's side:

- **Cookies and storage.** A room's cookie (the one that sends a page's own requests to its room) is set host-only on the room's origin, with no `Domain`, so no other room ever receives it. `localStorage`, `sessionStorage`, IndexedDB and caches then follow the origin by themselves.
- **Pages, files, API and socket.** Everything a room serves, its page, `/front.js` and fonts, `/build/` mod code, `/stills/`, `/api/*`, `/cli/*` and the `/ws` socket, answers only at that room's origin, never at the shared one or another room's. A request for one room arriving at another's origin is refused, not forwarded.
- **Links.** Invite links become `https://<room>.<relay domain>/#invite=…`; the launcher's `running.link` and the game's Invite page give that form.
- **Moving over.** Players' keys saved under the shared origin stay readable there until it stops serving rooms. The old `/r/<room>/` links answer only with a redirect to the room's origin, carrying the fragment in the browser, never a page; players rejoin once by their invite or name, and the shared origin's storage is left behind.

Until the relay ships this, the exposure above stands.

What the shared relay origin never holds: the menu's key, any world's host key, Community owner tokens, the speech key or the launcher's other secrets. Those stay on the host's computer, at `127.0.0.1`.

A world run on its own with `bun engine/server.ts`, without the launcher, prints its invite link, never its host key: the host plays by the invite and the password like anyone, since a link reaches the page where mods run. Only the launcher, from its own process, joins someone as the host.

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
