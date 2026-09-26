# Sharing worlds on GitHub

A shared world is a GitHub repository. The host's agent builds it with the CLI's `publish` tool and pushes it with `gh` (see GUIDE.md, Publishing this world). Anyone plays it from Worlds, Browse: the launcher downloads the repository's tarball over HTTPS, so hosting needs no git, and makes it a new world.

## What a published world holds

`publish` builds the repository from an allowlist. Anything not in this table stays on the host's computer.

| World folder | Published as | Why |
| --- | --- | --- |
| `config.json` name, rules, start | `world.json`, with the builder's GitHub handle as author, a one-line description and the engine version | A new host needs the world's name and rules. |
| `config.json` `invite`, `hostKey` | nothing | Keys to the host's game. The new world gets fresh ones. |
| `keys.json` | nothing | Every player's key. Its names only decide what gets left out. |
| `owners.json`, authors in `mods.json` | nothing | Players' names. Every mod in the new world belongs to the world's author. |
| `mods.json` | nothing | Its build paths belong to this machine. It only picks which mods are published: the live ones. |
| `world/mods/<live mod>/` | `mods/<mod>/` | The game itself, assets included. Dotfiles and `node_modules` are left out. |
| `world/package.json`, `world/bun.lock` | `package.json`, `bun.lock`, only when mods added packages | The new host installs them with `bun install`. |
| `world/.git` | nothing | Its history names every builder. |
| `world/api.ts`, `GUIDE.md`, `tsconfig.json`, `.gitignore`, `node_modules/` | nothing | The engine writes or installs these on start. |
| `world.sqlite` entities | `state/entities.json`, without entities that name a player | The world as it stands. Inventories, quests, private views and other per-player records stay home. |
| `world.sqlite` snapshots and timelapse | nothing | Old states for Rewind and replays, with the players' chat in them. |
| `db/<live mod>.sqlite` | `state/db/<mod>.sql`, without rows that name a player | What mods keep outside entities, as reviewable SQL. |
| `cover.jpg` | `cover.jpg` | The host's own view of the world, saved by their game without the HUD or players' names. Worlds and Browse show it. |
| `about.json` | `state/about.json`, live mods only, without banners that name a player | What each mod is. |
| `record.sqlite` | nothing | The replay recording: tool calls, chat, sessions. |
| `world.log`, `seeded.json`, `build/` | nothing | Logs, and files the engine rebuilds. |
| `secrets.json` (the launcher's) | nothing | Paid-service keys. |

"Names a player" means a player's name appears as a whole word in any text or key, case-insensitively, where the names are everyone in `keys.json`, `owners.json` and `mods.json`.

Before anything is written, every published file is checked for the world's keys, the players' keys, the launcher's secrets, the values of environment variables whose names say key, token, secret, pass, auth or credential, and the shapes of common API keys. One match stops the publish and names the file.

Mod code and banners are published as the builders wrote them, so the agent searches the folder for players' names and shows its player each hit before pushing.

## Browse

`worlds.json` in this repository lists the worlds Browse offers, as `{ "repo": "owner/name", "name": "…", "description": "…" }`. Covers come from each repository's `cover.jpg`. Listed worlds play at once; a pasted link to any other repository first says "This world runs code from <owner>. Only play worlds from people you trust."
