# Sandbox desktop app

Play any Sandbox world in its own window instead of a browser tab: right-click reaches the game, the mouse locks without a warning banner, and browser shortcuts like Ctrl+W or Ctrl+R can't close or reload the game.

## Get it

On a Mac or Linux (and Windows through WSL), one command downloads the app and opens it. Add your invite link at the end to go straight into that world:

```sh
curl -fsSL https://raw.githubusercontent.com/theolundqvist/sandbox/master/desktop/install | bash -s -- 'http://host:7777/#invite=…'
```

On a Mac it lands in Applications, so the Dock, Spotlight and Launchpad find it. On Linux it goes in `~/.local/share/sandbox`, with an entry in your app menu. Either way, `sandbox` opens it from a terminal, with or without a link, and running the command again updates it. If `sandbox` isn't found, add `~/.local/bin` to your PATH.

The game shows this command, with your link filled in, under **Settings** and on the join screen; the host's main menu has it under **Desktop app**. From a clone, `bun desktop '<link>'` runs the app without installing it.

## Play

The app opens the world you played last, or the one hosted on this computer. If that world isn't up, it says so and offers **Retry** next to the invite box.

Paste the invite link your host sent and press Enter. The worlds you've joined show up on the start screen, so next time you just pick one. If you host on the same computer, **Host a world** opens your main menu. The first time, paste the main menu link your terminal printed, so the app knows you're the host.

- **Full screen:** F11, or Ctrl+Cmd+F on a Mac. The app remembers it.
- **Mouse:** click the game to look around. Esc, Tab (menu) and Enter (chat) free the mouse. Switching back to the app from another window picks the mouse back up.
- **Quit:** Cmd+Q on a Mac. On every system, closing the window asks first while you're in a world.

## Release

Pushing a `v*` tag builds the Mac and Linux apps in GitHub Actions and publishes them as a GitHub release; the installer always takes the latest one. The Mac app is unsigned, which the installer handles; a zip downloaded in a browser would need signing to open with a double-click.
