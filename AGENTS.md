# Agent notes

## Hosting a world

1. `bun install` first. `bun start` launches the menu without it, but the world crashes on start with `Could not resolve: "html-to-image"`.
2. `bun start` runs the launcher on port 7777 (`PORT` overrides). Run it in the background; worlds live only while it runs.
3. Drive the main menu over its API instead of the browser. Every call is a POST with `authorization: Bearer <hostKey>`, where `hostKey` is in `data/launcher.json` (also the `#key=` in the printed menu link):

   ```sh
   K=$(jq -r .hostKey data/launcher.json)
   menu() { curl -s -X POST "localhost:7777/api/menu/$1" -H "authorization: Bearer $K" -H 'content-type: application/json' -d "${2:-{\}}"; }
   menu share '{"on":true}'                                   # go public through the hosted relay
   menu create '{"name":"Sandbox","rules":"open","start":"basics"}'  # create and host a new world
   menu host '{"id":"<world id>"}'                            # host an existing world (ids: menu state)
   menu state                                                 # worlds, running world, tunnel url + join code
   ```

4. **Use the hosted relay** (`https://sandbox-relay.lundqvistliss.com`, the default) for sharing over the internet. Don't set `SANDBOX_RELAY` or run `relay/relay.ts` unless asked. Sharing is remembered in `data/launcher.json`, so later launches reconnect by themselves.
5. Invite link for friends: `<tunnel.url>/#invite=<running.invite>` from `menu state`, plus `tunnel.code` as the join code. `running.hostKey` is the host's own link; never share it or the menu key.

## Secrets

`ELEVENLABS_API_KEY` (voice transcription, EU-residency key) lives in the gitignored `.env`, which Bun loads on its own. Never commit it.
