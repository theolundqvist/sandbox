# Agent notes

## Hosting a world

1. `bun install` first. `bun start` launches the menu without it, but the world crashes on start with `Could not resolve: "html-to-image"`.
2. `bun start` runs the launcher on port 7777 (`PORT` overrides; `SANDBOX_NO_OPEN=1` stops it opening a browser). Run it in the background; worlds live only while it runs.
3. Drive the main menu over its API instead of the browser. Every call is a POST with `authorization: Bearer <hostKey>`, where `hostKey` is in `data/launcher.json` (also the `#key=` in the printed menu link):

   ```sh
   K=$(jq -r .hostKey data/launcher.json)
   menu() { curl -s -X POST "localhost:7777/api/menu/$1" -H "authorization: Bearer $K" -H 'content-type: application/json' -d "${2:-{\}}"; }
   menu create '{"name":"Sandbox","rules":"open","start":"basics"}'  # create and host a new world
   menu host '{"id":"<world id>"}'                            # host an existing world (ids: menu state)
   menu stop                                                  # stop the running world
   menu state                                                 # worlds, running world and its invite link
   ```

   `rules` is `open` or `additive`; `start` is `blank`, `basics` (3D field) or `hills` (3D hills). Anything else falls back to `open` and `basics`. `password` sets one players type once per device, and `"agents": false` turns agents off; `host` takes the same three for a saved world and restarts it when they change.
4. **Use the hosted relay** (`https://sandbox-relay.lundqvistliss.com`, the default) for sharing over the internet. Don't set `SANDBOX_RELAY` or run `relay/relay.ts` unless asked. A hosted world is always shared through it.
5. Invite link for friends: `running.link` from `menu state`. While the relay can't be reached, `running.wifiOnly` is true and the link works only on the host's network. `running.hostKey` is the host's own link; never share it or the menu key.

## Moving a world

Export answers with the zip itself; import takes the raw zip as the body, adds the world under a new id and does not start it:

```sh
curl -s -X POST localhost:7777/api/menu/export -H "authorization: Bearer $K" -H 'content-type: application/json' -d '{"id":"<world id>"}' -o world.zip
curl -s -X POST localhost:7777/api/menu/import -H "authorization: Bearer $K" --data-binary @world.zip
```

The zip holds every mod and its history, the entities, each mod's database and the record. It never holds the invite, the host key or players' keys, so after a move every player pastes the new prompt from the game's Claude page into their agent; a name they played under gets its mods back. Imports through the relay are capped at 25 MB.

## Host on a Linux server

Clone the repo and run `bun install` on the server, then run the launcher as a systemd user service so worlds outlive your SSH session (`bun start` is `bun engine/launcher.ts`):

```ini
# ~/.config/systemd/user/sandbox.service
[Unit]
Description=Sandbox launcher
After=network-online.target

[Service]
WorkingDirectory=%h/sandbox
Environment=SANDBOX_NO_OPEN=1
ExecStart=%h/.bun/bin/bun engine/launcher.ts
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now sandbox
loginctl enable-linger "$USER"   # keep user services running while logged out
journalctl --user -u sandbox -f  # logs, including the menu link
```

To move from another machine: export the world there and stop that launcher, then import the zip on the server and host it. To keep the same public link, carry the relay identity: the server's launcher writes its own `data/launcher.json` on first start, so stop it, copy `room` and `relayToken` from the old machine's file into it, and start it again. Leave `hostKey` as the server made it. Never run both launchers with the same identity, and never commit or paste these values anywhere public.

## README media

- Clips and stills live in `docs/readme/`, kebab-case, referenced from README.md with alt text and a one-line caption under each saying exactly what happens. Every file there should be referenced; delete what the README stops using.
- Clips are animated WebP: 6–12 s, 960–1200 px wide, 10–12 fps, lossy quality 60–75, at most 5 MB each. Stills are JPEG quality ~85 (PNG only for small flat UI crops).
- Keep screen recordings out of the repo. To cut a clip from one (`ffmpeg` here has no WebP encoder, so go through PNG frames and `img2webp` from Homebrew `webp`):

  ```sh
  # find the game canvas first: grab one full frame and note where the browser/app chrome ends
  ffmpeg -ss 540 -i recording.mov -frames:v 1 full.png
  # frames: start, length, fps, crop=w:h:x:y to the canvas, then scale down
  ffmpeg -ss 539 -t 6 -i recording.mov -vf "fps=12,crop=3880:2350:108:142,scale=1120:-2:flags=lanczos" f/a_%04d.png
  ffmpeg -ss 549 -t 3.6 -i recording.mov -vf "fps=12,crop=3880:2350:108:142,scale=1120:-2:flags=lanczos" f/b_%04d.png
  img2webp -loop 0 -lossy -q 65 -m 6 -d 83 f/*.png -o docs/readme/clip.webp   # -d = 1000/fps ms
  # stills
  ffmpeg -ss 40 -i recording.mov -frames:v 1 -vf "crop=3880:2350:108:142,scale=1600:-2:flags=lanczos" -q:v 3 docs/readme/still.jpg
  ```

  Skim a long recording first with one frame every 10–15 s tiled into contact sheets (`ffmpeg -ss <t> -frames:v 1` per frame, then `xstack`), then zoom into promising ranges at 1 fps.
- Privacy, for every frame you keep: crop to the game canvas only. Nothing outside it: no OS menu bar, dock, notifications or other apps; no URL bar (invite and host keys live in URLs); no terminals; no Tab menu Claude page (its prompt holds the player's key); no invite links, join codes of a live world, emails, IPs, hostnames or API keys. Players' first names in the game are fine. If a good moment shows something private, crop it out or skip it, and look at the final frames yourself before committing.

## Secrets

`ELEVENLABS_API_KEY` (voice transcription, EU-residency key) lives in the gitignored `.env`, which Bun loads on its own. Never commit it.
