# Sandbox desktop app

Play any Sandbox world in its own window instead of a browser tab: right-click reaches the game, the mouse locks without a warning banner, and browser shortcuts like Ctrl+W or Ctrl+R can't close or reload the game.

## Get it

On a Mac or Linux (and Windows through WSL), one command downloads the app and opens it. Add your invite link at the end to go straight into that world:

```sh
curl -fsSL https://raw.githubusercontent.com/theolundqvist/sandbox/master/desktop/install | bash -s -- '<invite link>'
```

On a Mac it lands in Applications, so the Dock, Spotlight and Launchpad find it. On Linux it goes in `~/.local/share/sandbox`, with an entry in your app menu. Either way, `sandbox` opens it from a terminal, with or without a link, and running the command again updates it. If `sandbox` isn't found, add `~/.local/bin` to your PATH.

The game shows this command, with your link filled in, under **Settings** and on the join screen; the host's main menu has it under **Desktop app**. From a clone, `bun desktop '<link>'` runs the app without installing it.

## Play

The start screen starts on **Continue**, which takes you back into the world you played last, hosted or joined, even after the app restarts; it isn't there before you've played one, or once that world is gone from Worlds. **Worlds** lists the ones this computer hosts and the ones you've joined. **Join world** takes a six-letter code or an invite link; one you've copied is filled in for you. **Host world** starts a world on this computer through the app's own game server and shares it through the relay, so the code and link it shows work for anyone.

- **Full screen:** F11, or Ctrl+Cmd+F on a Mac. The app remembers it.
- **Reload:** Cmd+R on a Mac, Ctrl+Shift+R elsewhere.
- **Mouse:** click the game to look around. Esc, Tab (menu) and Enter (chat) free the mouse. Switching back to the app from another window picks the mouse back up.
- **Quit:** Cmd+Q on a Mac. It asks first while you're in a world or friends are in yours.
- **Updates:** the app checks GitHub for a new release every few minutes. **Update** shows up on the start screen and in the game menu, and one click installs it and reopens the app.

## Release

Pushing a `v*` tag builds the Mac (Apple silicon and Intel) and Linux apps in GitHub Actions and publishes them as a GitHub release; the installer always takes the latest one, and the tag sets the version. The Mac app is unsigned, which the installer handles; a zip downloaded in a browser would need signing to open with a double-click.
