# App paths

Every journey through the desktop app and the browser, and the test that covers it. `app` is `desktop/app.test.mjs` (Electron and Chromium under Xvfb), `launcher` is `engine/launcher.test.ts`, `update` is `desktop/update.test.mjs` (two real AppImage builds).

Run them with `bun test engine/launcher.test.ts`, `cd desktop && npm test`, and `SANDBOX_APPIMAGES=<dir with 0.2.0/ and 0.2.1/> xvfb-run -a node --test desktop/update.test.mjs`.

## Install and launch

| Journey | Entry | States | Test |
| --- | --- | --- | --- |
| One-liner | `curl …/desktop/install \| bash` | download release, extract to `~/.local/share/sandbox`, link `~/.local/bin/sandbox`, open | update: installs 0.2.0 |
| Release file | AppImage / Mac zip from Releases | opens directly | manual |
| First launch | app opens | title: Worlds, Join world, Host world, Quit; Worlds empty | app: first launch |

## Updates

| Journey | Entry | States | Test |
| --- | --- | --- | --- |
| At start, none | launch | menu after the check, no Update entry | app: first launch |
| At start, newer release | launch | "Checking for updates…", "Updating to X…", app quits, installer replaces it and opens the new version; the menu never shows first | app: starting up, newer release; update: 0.2.0 → 0.2.1 |
| At start, offline | launch | menu at once, no Update | app: starting up, offline |
| At start, release server hangs | launch | menu after 3 s at most | app: starting up, never answers |
| At start, download fails | launch | menu opens, Update offered | app: starting up, fails at start |
| At start, install didn't take | relaunch still old | opens as it is, Update offered, no install loop | app: starting up, didn't bring the new version |
| Release while running | poll | Update on the title and in the game menu; never restarts by itself, hosting or not; applied at the next start | app: release while hosting |
| Which installer | any update | from 0.2.6 the installer script and the build come from the tag being installed, so master cannot break updates; older apps still fetch master's installer | app: newer release installs |
| Update from the menu | Update | Downloading…, installer handoff, app quits, relaunches | app: downloads before quitting |
| Update, failure | Update, download fails | app stays open, "The update didn't download. Check your connection." | app: failed download |
| Update, friends online | Update | asks first, naming the players; after restart hosting resumes under the same code and the host is back in the game | app: failed download (dialog), after the update |

## Worlds

| Journey | Entry | States | Test |
| --- | --- | --- | --- |
| Hosted world | Worlds | row: name, Live or last played, Hosted | app: leaving shows the hosted world |
| Joined world | Worlds | row: name, last played, Joined; saved under its relay address | app: code joins, listed as Joined |
| Empty | Worlds | "Worlds you host or join show up here" | app: first launch |
| Hosted, not running | Worlds, open | Starting your server…, then the world | app: reopened after the crash |
| Joined, host closed it | Worlds, Continue | "Snow Race is closed. Ask the host to open it, then retry."; Retry opens it once it is back | app: host closes the game |
| Joined, host unreachable | Worlds, Continue | "Snow Race isn't answering. Ask the host if it's running, then retry." | app: host closes the game (silent path shares the screen) |
| Joined, this computer offline | Worlds, Continue | "You're offline. Check your internet, then retry." | manual |
| Forget joined | Worlds, Forget | row removed | app: Forget removes it |

## Host world

| Journey | Entry | States | Test |
| --- | --- | --- | --- |
| Create | Host world, name or blank | blank gets a distinct place name; host plays it | app: unnamed world; launcher: own names |
| Relay reachable | Host world | main menu opens through the relay, never "Waiting for the host" | app: Host world through the relay |
| Relay unreachable | Host world | main menu opens on localhost, says "Can't reach the Sandbox relay, so only people on your Wi-Fi can join. Trying again…"; the world's invite is the Wi-Fi link | app: relay down, Wi-Fi link |
| World crashes while starting | Host world | "The world crashed while starting. Try again." | manual |
| No git (Mac without Xcode tools) | any | git never runs; history tools say Needs Git | launcher: no git |

## Join world

| Journey | Entry | States | Test |
| --- | --- | --- | --- |
| Code | Join world, code | relay looks it up, join screen, game | app: code joins through the relay |
| Invite link | Join world, link | join screen, game | app: invite link |
| /r/ link without scheme | Join world | becomes https | app: invite link |
| Wrong code | Join world | "No world with that code" | app: wrong code |
| Rate limit | many wrong codes | "Too many tries. Wait a minute." | app: rate limit; launcher: limited per address |
| Relay down | code | "Can't look up codes right now. Check your connection, or ask for the invite link." | app: relay down, code |
| Clipboard prefill | Join world | prefills invite links and codes only | app: clipboard, true and false positives |
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
| Crash | app killed | no server left behind; reopening lists the world and opens it | app: crashed app, reopened after the crash |
| Host quits mid-game | host closes | "The host closed the world. You're back in when they open it."; rejoins by itself | app: host closes the game |
| Voice, host without a key | mic reads Turn on voice | opens Settings on the Voice key field; key checked with ElevenLabs, saved 0600 in the app's data, shown masked, voice on for everyone without a restart | app: host turns voice on; launcher: voice key |
| Voice, player without host key | mic reads Voice off | disabled | app: code joins (visitor) |
| Voice, key refused later | hold T | host: "ElevenLabs refused the voice key. Add it again in Settings."; players: "Voice didn't go through. Try again." | manual |
| Mic blocked in the app | hold T | "Voice needs the microphone. Hold T again to allow it." | manual |
| Connect a coding agent | Claude tab | one prompt for any agent with a shell, with Copy; Copied shows in place | app: connecting an agent |

## Browser

| Journey | Entry | States | Test |
| --- | --- | --- | --- |
| /menu, host's computer | `localhost/menu` | loopback gets the host key; main menu; Desktop app entry | app: in a browser; launcher: loopback |
| /menu, elsewhere | relay or LAN `/menu` | "Only the host can open this menu, on their own computer." | app: in a browser; launcher: LAN, proxy, relay |
| Invite link | browser | join screen, Get the app with the same link, Play in browser | app: in a browser |

## Confusing states found

| State | Was | Now |
| --- | --- | --- |
| Voice off because the host has no key | "Voice needs the host's ElevenLabs key", fixable only with an env var | host: Turn on voice opens the Voice key field; players: Voice off |
| An update is out | Update had to be found and clicked | installs at start before the menu; while running, Update shows and nothing restarts |
| Host quits mid-game | Reconnecting… forever | says the host closed it and rejoins by itself |
| Joined world is closed | "<host:port> isn't answering. Is the game running?" | names the world and says the host must open it; offline says offline |
| Host's relay is blocked | main menu showed the relay URL and a retry interval; invite link pointed at localhost | plain relay message; invite is a Wi-Fi link friends on the same network can open |
| Code lookup with the relay down | "Can't reach the relay" | says codes can't be looked up and offers the invite link instead |
| /menu opened by a player | "Open the menu link from the host's terminal." | says it is the host's, on their own computer |
| World crashes on start | "the terminal shows why" | "The world crashed while starting. Try again." |
| Mic blocked in the app | pointed at the browser's address bar | says to hold T again |
| Coding agent | Connect listed before Install; Copied resized the row | decided: one prompt pasted into the agent, which installs the command itself; Copy keeps its size |
| Pre-play card under a menu | its title, keys and Play showed through Settings and Invite | hidden while a menu is open, in the game's font |
| Host closed, in game | the message covered the top-bar buttons; Play and the Open badge stayed | message sits below the bar; Play disabled and the badge hidden until the world is back |
| Reloads and brief tabs | a joined and left line each time | lines wait 3 s to join and 10 s to leave, so neither shows |
| Getting the app from a browser | curl one-liner | unchanged: unsigned Mac builds and AppImage need it |
