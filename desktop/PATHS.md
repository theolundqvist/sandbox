# App paths

Every journey through the desktop app and the browser, and the test that covers it. `app` is `desktop/app.test.mjs` (Electron and Chromium under Xvfb), `launcher` is `engine/launcher.test.ts`, `update` is `desktop/update.test.mjs` (two real AppImage builds).

Run them with `bun test engine/launcher.test.ts`, `cd desktop && npm test`, and `SANDBOX_APPIMAGES=<dir with 0.2.0/ and 0.2.1/> xvfb-run -a node --test desktop/update.test.mjs`.

## Install and launch

| Journey | Entry | States | Test |
| --- | --- | --- | --- |
| One-liner | `curl …/desktop/install \| bash` | download release, extract to `~/.local/share/sandbox`, link `~/.local/bin/sandbox`, open | update: installs 0.2.0 |
| Release file | AppImage / Mac zip from Releases | opens directly | manual |
| First launch | app opens | title: Worlds, Join game, Host game, Quit; Worlds empty | app: first launch |

## Updates

| Journey | Entry | States | Test |
| --- | --- | --- | --- |
| None available | launch | no Update entry | app: first launch |
| Available | launch, release newer | title and game menu show Update with the version | app: shows Update, game menu offers it |
| Download and apply | Update | Downloading…, installer prints the handoff line, app quits, installer waits for its PID, replaces the app, relaunches | app: downloads before quitting; update: 0.2.0 → 0.2.1 |
| Failure or offline | Update, download fails | app stays open, "The update didn't download. Check your connection." | app: failed download |
| While hosting, friends online | Update | asks first, naming the players; after restart hosting resumes under the same code and the host is back in the game | app: failed download (dialog), after the update |

## Worlds

| Journey | Entry | States | Test |
| --- | --- | --- | --- |
| Hosted world | Worlds | row: name, Live or last played, Hosted | app: leaving shows the hosted world |
| Joined world | Worlds | row: name, last played, Joined; saved under its relay address | app: code joins, listed as Joined |
| Empty | Worlds | "Worlds you host or join show up here" | app: first launch |
| Hosted, not running | Worlds, open | Starting your server…, then the world | app: Host game (same start path) |
| Forget joined | Worlds, Forget | row removed | app: Forget removes it |

## Host game

| Journey | Entry | States | Test |
| --- | --- | --- | --- |
| Create | Host game, name or blank | blank gets a distinct place name; host plays it | app: unnamed world; launcher: own names |
| Relay reachable | Host game | main menu opens through the relay, never "Waiting for the host" | app: Host game through the relay |
| Relay unreachable | Host game | main menu opens on localhost | app: relay down, Host game |
| No git (Mac without Xcode tools) | any | git never runs; history tools say Needs Git | launcher: no git |

## Join game

| Journey | Entry | States | Test |
| --- | --- | --- | --- |
| Code | Join game, code | relay looks it up, join screen, game | app: code joins through the relay |
| Invite link | Join game, link | join screen, game | app: invite link |
| /r/ link without scheme | Join game | becomes https | app: invite link |
| Wrong code | Join game | "No game with that code" | app: wrong code |
| Rate limit | many wrong codes | "Too many tries. Wait a minute." | app: rate limit; launcher: limited per address |
| Relay down | code | "Can't reach the relay. Check your connection." | app: relay down, code |
| Clipboard prefill | Join game | prefills invite links and codes only | app: clipboard, true and false positives |
| Other games' clips | join screen | only this world's | app: no /clips/ requests |

## Invites

| Journey | Entry | States | Test |
| --- | --- | --- | --- |
| Link, code | Invite in the game menu | code leads to the current invite link | launcher: join code |
| New code, new link | Invite | new link: the code follows it; new code: the old one stops | launcher: join code |
| Sharing off | Invite | code stops resolving | launcher: join code |

## In game

| Journey | Entry | States | Test |
| --- | --- | --- | --- |
| Reload | Ctrl+Shift+R | stays in the relay room | app: reload stays in the room |
| Leave | Leave game | back to Worlds | app: leaving shows the hosted world |
| Quit, players online | Quit or close | asks, naming the count; Keep hosting keeps the server | app: a friend online |
| Quit | Quit | server stops | app: quitting stops the server |
| Crash | app killed | no server left behind | app: crashed app |

## Browser

| Journey | Entry | States | Test |
| --- | --- | --- | --- |
| /menu, host's computer | `localhost/menu` | loopback gets the host key; main menu; Desktop app entry | app: in a browser; launcher: loopback |
| /menu, elsewhere | relay or LAN `/menu` | "Open the menu link from the host's terminal." | app: in a browser; launcher: LAN, proxy, relay |
| Invite link | browser | join screen, Get the app with the same link, Play in browser | app: in a browser |
