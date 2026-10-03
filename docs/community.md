# Community worlds

A host shares a world from the game (Tab, World, Share; the desktop app asks in its own dialog) or from Worlds, Community, Publish a world in the app, as the Community account signed in under Settings, Account. Community in the app lists public worlds, most played first or newest first, and the account's own; each world's screen plays, forks, upvotes, comments, reports or, for its owner, takes it down. The site lists the public ones the same two ways, gives each world its own page with upvotes and comments, and hands Play and Fork to the app by copying the world's link.

## What goes up

| Part | What it is |
| --- | --- |
| World | What Export makes, without what its players did and said: every mod and its history, the entities and each mod's database, and `owners.json`, so mod authors keep their credit. Rewind and the Timelapse go with it, but without the chat in their moments; the record (chat, tool calls, sessions) and where each player sits (`seats.json`) are left out. Player names that are part of the game, in scores and items, stay. The invite, the host key and players' keys are never in it, and every copy of them in a database is replaced with `[secret]`. |
| Cover | The world's picture (`cover.jpg`, the host's view without the HUD or name tags), or the current view. |
| Clip | The whole timelapse played back in 12 s and recorded in the host's game: muted 640×360 WebM, without name tags. A world with nothing to replay yet goes up without one. |
| Details | Title, a one-line description, link-only or public, the world it was forked from, a random id the world keeps on this computer (so a world a moderator removed can't simply go up again), the engine version and the mod count. The author is the account's username. |

Link-only worlds open by their link and are never listed. Sharing a world again updates the same community world. A copy of a community world keeps the world it came from in its own `config.json` (`forkOf`), so the parent survives export and import; a parent never changes once set, and a chain that would loop is refused. A world's page says what it was forked from and lists its forks; taking a world down leaves its forks up, saying they came from a removed world, and a link-only parent is never named, since its id is its link. Mods are code that runs on whoever hosts them, so Host and Fork of anyone else's world first say "This world runs code from <author>. Only play worlds from people you trust."

## Accounts

An account is a username (3 to 20 of `a-z`, `0-9`, `_`, unique, changeable once in 30 days, shown wherever the account appears; the app suggests the player's name), an email (trimmed and lowercased, never shown) and a password of 8 to 128 characters, hashed with Argon2id. Sign-in errors never say which of the two was wrong. A session lasts 90 days from its last use; Postgres keeps only its hash.

The desktop app keeps its session only in its main process, encrypted with the system keychain (`safeStorage`; where there is none, in memory until quit), never in `data/` or where a world's code runs: the game asks the app to publish, and the app checks that the request comes from the world this computer hosts. The site keeps it in an `HttpOnly; Secure; SameSite=Lax` cookie, and every change from a browser needs the site's `Origin` and an `x-sandbox: 1` header.

Worlds shared before accounts carry an owner token in `data/community.json`. Signing in moves each of them to that account (`POST /worlds/:id/claim`), once: after that the token does nothing and the launcher forgets it, and a world already claimed never moves to another account signing in on the same computer. Until claimed, the token can only take the world down.

Deleting an account needs its password. Its sessions end at once and its worlds are taken down; other people's forks keep pointing at them, as removed worlds. Password reset needs an email provider and doesn't exist yet.

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
| `POST /accounts` | `{ username, email, password }`; signs in. |
| `POST /sessions`, `DELETE /sessions` | Sign in with `{ email, password }`, sign out. The app gets `{ account, token }`, the site a cookie. 5 tries a minute and 20 an hour per IP, and 5 a minute per email unless the IP signed into that account before. |
| `GET /account`, `PATCH /account`, `DELETE /account` | Who is signed in, a new `username`, deletion with `{ password }`. |
| `GET /account/worlds` | The account's live worlds, link-only included. |
| `POST /worlds` | Signed in. JSON details and `files: { zip, cover, clip?, gallery? }` sizes (zip 200 MB, JPEG cover 2 MB, WebM clip 6 MB, `gallery` a list of up to 8 JPEG sizes, 2 MB each). `timelapse: false` leaves the clip off the world's page. Answers `{ id, link, uploads }`, an upload URL per file, the gallery's as `gallery0` to `gallery7`. 10 per IP an hour. |
| `PUT /worlds/:id` | Same, by the account that owns it; a cover, clip or gallery not sent keeps the old one, a gallery sent (even empty) replaces it, `timelapse: false` takes the clip down, and `changelog` (280 characters) says what changed. Each share that goes live is the world's next `version`. 30 per IP an hour. |
| `POST /worlds/:id/done` | Its account only, after the uploads. Checks each file landed at its size and is the kind it claims, then the world goes live; an update replaces the old files only now. |
| `POST /worlds/:id/claim` | Signed in, `{ ownerToken }`: moves a world shared before accounts to this account. |
| `DELETE /worlds/:id` | Its account, or the owner token of an unclaimed world. Leaves a tombstone (`410 Gone`) and deletes its files. |
| `GET /worlds` | Public live worlds, 50 at a time: by players, or newest first with `?sort=new`; `?after=<id>` goes on from that world, ties broken by id. Worlds of banned accounts are left out. |
| `GET /worlds/:id` | One world, link-only included, `410` once removed, with `zip`, `cover` and `clip` URLs that last the hour, `gallery` (the picked pictures' URLs, in order), `parent` (the world it was forked from: its id, title and author while that one is listed, otherwise only `removed` or `unlisted`; `updated` is the original's newest `{ version, changelog, at }` when it is newer than the version the fork was first published from), its `history`, the 20 newest `{ version, changelog, at }`, and its number of `forks`, and `builder`: whether the asker is its owner or a credited builder who accepted, and `builders`: its author, then each credited builder who accepted. |
| `GET /worlds/:id/usage` | Its builders only: what agents used building it, from `POST /agent-usage` under its id or the id its host keeps for it (`origin`), summed by `{ provider, model, subscription }` with `inputTokens`, `outputTokens`, `cacheRead`, `cacheWrite`, `costUsd` and `requests`, costliest first. |
| `GET /worlds/:id/forks` | Its listed forks, newest first, 50 at a time, `?after=<id>`. |
| `PUT /worlds/:id/vote` | Signed in, `{ up: true }` or `{ up: false }`: the vote the account wants, so sending it twice changes nothing. Answers `{ votes, voted }`. 60 a minute. |
| `POST /worlds/:id/report` | Counts a report. 10 per IP an hour. |
| `POST /plays`, `PUT /plays/:id` | The install's token, `{ world }`, and the session in `x-session` when signed in: starts a play. Then `{ seconds }`, the play's focused time so far, every minute. |
| `POST /playtime` | The install's token, `{ world, seconds }`, the session in `x-session` when signed in: focused time in any game since the last one, added to today's (UTC) total for that world. |
| `POST /agent-usage` | The install's token, `{ world, provider, model, subscription, inputTokens, outputTokens, cacheRead, cacheWrite, costUsd, requests }`, added to today's row for that world, provider and model. Nothing sends it yet. |
| `GET /worlds/:id/comments` | Oldest first, 100 at a time, `?after=<id>`. Comments of banned accounts are left out; removed ones show as removed. |
| `POST /worlds/:id/comments` | Signed in, `{ body }`, 1 to 1,000 characters of plain text. One every 20 s. |
| `DELETE /comments/:id`, `POST /comments/:id/report` | Removal by its author or the world's owner, which also wipes its text; a report, once per account or IP. |
| `PUT /worlds/:id/credits` | Its account, `{ builders: [{ name, checks }] }`, up to 20: asks each builder, by in-world name, to be credited. Replaces the waiting ones; accepted credits stay. |
| `DELETE /worlds/:id/credits` | Signed in: drops the account's own credit on that world. |
| `POST /credits/waiting`, `POST /credits/accept` | Signed in, `{ tokens }`: the credits those tokens prove, not yet accepted. `{ token }`: accepts one, which then shows on the world. |
| `GET /users/:username` | A profile: `joined`, `players` and `votes` over its listed worlds, those `worlds`, its own and credited, and whether the asker `blocked` it, and `friend`. `404` for a banned account. |
| `POST /messages` | Signed in, `{ to, body }`, 1 to 2,000 characters of plain text. One every 3 s, and 10 new conversations a day. `403` when the recipient blocked the sender. |
| `GET /messages`, `GET /messages/:username` | The conversations, newest first, each with its last message and unread count. One conversation, 50 at a time going back with `?before=<id>`; reading it marks its messages read. |
| `GET /account/unread` | `{ unread, notifications }`: unread messages and notifications. |
| `GET /notifications`, `POST /notifications/read` | The newest 50 `{ id, kind, actor, world: { id, title } \| null, at, read }`, `kind` one of `fork`, `comment`, `message`, `credit`, `friend-request`, `friend-accepted`; nothing from accounts you blocked, and one unread notice per kind, account and world. Read marks them all read. |
| `PUT /friends/:username` | Signed in: asks to be friends, or accepts when they asked first. 20 new requests a day. Answers `{ friend }`: `sent`, `received`, `friends` or `null`, as profiles show it. |
| `DELETE /friends/:username`, `GET /friends` | Unfriends, takes back or declines a request. `{ friends, received, sent }` by username. |
| `PUT /live` | The host's app, with its install token and `x-session`, every 30 s while a world it hosts lets in more than its invite holders: `{ link, title, players, access, world? }`, with `access` one of `anyone`, `friends`, `password`. A room stays with the computer that listed it first (409). |
| `DELETE /live`, `GET /live` | Unlists this computer's world. Worlds seen in the last 90 s, most players first: `anyone` and `password` ones for everybody, `friends` ones only for the host's friends. A `password` world's link has no invite; its relay hands that out for the right password at `POST /_unlock { room, password }`, 10 tries a minute, and keeps only the hash the host's launcher sent it. |
| `PUT /blocks/:username`, `DELETE /blocks/:username` | Block or unblock: a blocked account can't message the blocker or ask to be friends either way, a block ends a friendship, and earlier messages stay. |
| `POST /messages/:id/report` | Its recipient only: shares that message with the moderators. |

The app authenticates with `Authorization: Bearer <session>`. Rate limits are counter rows, each bumped in one statement, so requests at the same moment can't slip past them. Shares never finished are swept after a day.

A play is time in a Community world hosted by the desktop app, only while its window has focus, and only with Share usage stats on; joining players aren't counted yet. The server credits no more than the time since the play started on its own clock, a play's seconds never go down, and only an install's newest play counts, so two at once can't both add up. Plays are the plays of a minute or more; players are the installs with at least one. Installs are free to make, so a determined player can still inflate these.

Playtime covers every game the app has open, its own, joined ones and Community's, with the same focus rule and switch. A world goes under its Community id, the random id a world keeps in its `config.json` (`telemetry`), or, for a joined world, a random id the app keeps for that world's address in its `state.json`; names and links never leave the computer. Each heartbeat is credited at most the time since the install's last one (a minute for its first, two at most), so a replay or two worlds at once add nothing. Playtime and agent usage outlive a deleted account, without it. The site's origin is the only one browsers may read the API from.

A credit is consent from both sides, proven without accounts knowing each other's player keys. Publishing, the owner picks builders from the names in the world's `keys.json`; for each, the launcher sends `sha256(HMAC-SHA256(playerKey, "sandbox-credit:" + localWorldId))` for that name's keys. A builder's game page computes the same HMAC with its own key when it joins and hands it to the app, which keeps the last 500 in `state.json`; the server sees only the hash until the builder, signed in, shows a token whose hash matches and accepts it. So credits are accepted from the desktop app, by someone who played in that world under that name.

Messages are plain text, seen only by their two accounts, and reports are the only way moderators see one.

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

Backups: every hour `pg_dump | zstd` to `sandbox-backups/pg/<time>.sql.zst`, then, only after that upload landed, older dumps are thinned to everything from 48 hours, one a day for 30 days and one a month for a year. Restore one with `zstd -dc <dump> | psql`, then `docker compose exec app bun replay.ts <dump time>`: every takedown and account deletion is logged in R2 under `deletions/` before it happens, and replay does again those since the dump.

## Takedown

On the box, `cd /opt/sandbox-api && docker compose exec app bun takedown.ts` lists the most reported worlds; `bun takedown.ts <id>` takes one down, and a world with the same local id can't be published again; `bun takedown.ts ban <username>` stops an account publishing, voting and commenting and takes its worlds and comments out of the lists; `bun takedown.ts comments` lists the most reported comments and `bun takedown.ts comment <id>` removes one; `bun takedown.ts messages` lists reported messages. A banned account also can't message, and its profile is gone. That id is chosen by the app, so a determined author can still get around it.
