# Sandbox desktop app

Play any Sandbox world in its own window instead of a browser tab: right-click reaches the game, the mouse locks without a warning banner, and browser shortcuts like Ctrl+W or Ctrl+R can't close or reload the game.

## Get it

On a Mac or Linux (and Windows through WSL), one command downloads the app from the computer hosting your world, installs Bun if it's missing (Bun then fetches Electron), puts the app in `~/.sandbox-app` and opens your world in it. The game shows the command under **Settings**, and the host's main menu under **Desktop app**. It looks like this:

```sh
curl -fsSL http://host:7777/desktop/install | bash -s -- 'http://host:7777/#invite=…'
```

It needs `curl` and `tar`. After that, `sandbox` opens the app, with or without a link, and running the command again updates it from the same host. If `sandbox` isn't found, add `~/.local/bin` to your PATH.

From a clone of this repository, `bun desktop 'http://host:7777/#invite=…'` runs it without installing.

## Play

Paste the invite link your host sent and press Enter. The worlds you've joined show up on the start screen, so next time you just pick one. If you host on the same computer, **Host a world** opens your main menu. The first time, paste the main menu link your terminal printed, so the app knows you're the host.

- **Full screen:** F11, or Ctrl+Cmd+F on a Mac. The app remembers it.
- **Mouse:** click the game to look around. Esc, Tab (menu) and Enter (chat) free the mouse. Switching back to the app from another window picks the mouse back up.
- **Quit:** Cmd+Q on a Mac. On every system, closing the window asks first while you're in a world.
