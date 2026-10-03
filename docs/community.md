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

## Service

`community/server/` is a Bun API with Postgres for the rows; zips, covers and clips live in the R2 bucket `sandbox-worlds` and never pass through the server, which hands out presigned URLs signed for each file's exact size and type. `community/site/` is the site, built into `dist/` with the game's own styles by `build-site.sh`.

| Endpoint | Does |
| --- | --- |
| `POST /accounts` | `{ username, email, password }`; signs in. |
| `POST /sessions`, `DELETE /sessions` | Sign in with `{ email, password }`, sign out. The app gets `{ account, token }`, the site a cookie. 5 tries a minute and 20 an hour per IP, and 5 a minute per email unless the IP signed into that account before. |
| `GET /account`, `PATCH /account`, `DELETE /account` | Who is signed in, a new `username`, deletion with `{ password }`. |
| `GET /account/worlds` | The account's live worlds, link-only included. |
| `POST /worlds` | Signed in. JSON details and `files: { zip, cover, clip? }` sizes (zip 200 MB, JPEG cover 2 MB, WebM clip 6 MB). Answers `{ id, link, uploads }`, an upload URL per file. 10 per IP an hour. |
| `PUT /worlds/:id` | Same, by the account that owns it; a cover or clip not sent keeps the old one. 30 per IP an hour. |
| `POST /worlds/:id/done` | Its account only, after the uploads. Checks each file landed at its size and is the kind it claims, then the world goes live; an update replaces the old files only now. |
| `POST /worlds/:id/claim` | Signed in, `{ ownerToken }`: moves a world shared before accounts to this account. |
| `DELETE /worlds/:id` | Its account, or the owner token of an unclaimed world. Leaves a tombstone (`410 Gone`) and deletes its files. |
| `GET /worlds` | Public live worlds, 50 at a time: by players, or newest first with `?sort=new`; `?after=<id>` goes on from that world, ties broken by id. Worlds of banned accounts are left out. |
| `GET /worlds/:id` | One world, link-only included, `410` once removed, with `zip`, `cover` and `clip` URLs that last the hour, `parent` (the world it was forked from: its id, title and author while that one is listed, otherwise only `removed` or `unlisted`) and its number of `forks`, and `builders`: its author, then each credited builder who accepted. |
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
| `GET /account/unread` | `{ unread }` messages. |
| `PUT /friends/:username` | Signed in: asks to be friends, or accepts when they asked first. 20 new requests a day. Answers `{ friend }`: `sent`, `received`, `friends` or `null`, as profiles show it. |
| `DELETE /friends/:username`, `GET /friends` | Unfriends, takes back or declines a request. `{ friends, received, sent }` by username. |
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
