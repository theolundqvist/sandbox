# Sandbox desktop app

Play any Sandbox world in its own window instead of a browser tab: right-click reaches the game, the mouse locks without a warning banner, and browser shortcuts like Ctrl+W or Ctrl+R can't close or reload the game.

## Get it

One command in a terminal downloads the app and opens it. Add your invite link at the end to go straight into that world. On a Mac, press Cmd+Space, type Terminal and press Enter; on Linux, press Ctrl+Alt+T:

```sh
curl -fsSL https://raw.githubusercontent.com/theolundqvist/sandbox/master/desktop/install | bash -s -- '<invite link>'
```

On Windows 10 or 11, press the Windows key, type PowerShell and press Enter, then:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/theolundqvist/sandbox/master/desktop/install.ps1))) '<invite link>'
```

or without a link, `irm https://raw.githubusercontent.com/theolundqvist/sandbox/master/desktop/install.ps1 | iex`. It needs no admin rights. If Windows says it protected your PC, click **More info**, then **Run anyway**.

On a Mac it lands in Applications, so the Dock, Spotlight and Launchpad find it. On Linux it goes in `~/.local/share/sandbox`, with an entry in your app menu. On Windows it goes in `%LOCALAPPDATA%\Programs\Sandbox`, with a Start menu and desktop shortcut. Everywhere, `sandbox` opens it from a terminal, with or without a link, and running the command again updates it. If `sandbox` isn't found on a Mac or Linux, add `~/.local/bin` to your PATH; on Windows, open a new PowerShell window.

The game shows this command, with your link filled in, under **Settings** and on the join screen; the host's main menu has it under **Desktop app**. From a clone, `bun desktop '<link>'` runs the app without installing it.

## Play

The start screen starts on **Continue**, which takes you back into the world you played last, hosted or joined, even after the app restarts; it isn't there before you've played one, or once that world is gone from Worlds. **Worlds** lists the ones this computer hosts and the ones you've joined. **Join world** takes a six-letter code or an invite link; one you've copied is filled in for you. **Host world** starts a world on this computer through the app's own game server and shares it through the relay, so the code and link it shows work for anyone.

- **Full screen:** F11, or Ctrl+Cmd+F on a Mac. The app remembers it.
- **Reload:** Cmd+R on a Mac, Ctrl+Shift+R elsewhere.
- **Mouse:** click the game to look around. Esc, Tab (menu) and Enter (chat) free the mouse. Switching back to the app from another window picks the mouse back up.
- **Quit:** Cmd+Q on a Mac. It asks first while you're in a world or friends are in yours.
- **Agents:** the game menu's Agent page has **Build with Claude Code** and **Build with Codex**. One click, and a yes in the app's own dialog, sets up the world's folder under `~/Sandbox` and starts it there in a terminal beside the game, installing it first with its maker's installer. You sign in to it there, so the app never sees your login; Stop ends it.
- **Updates:** the app checks GitHub for a new release every few minutes. **Update** shows up on the start screen and in the game menu, and one click installs it and reopens the app.

## Release

Pushing a `v*` tag builds the Mac (Apple silicon and Intel), Linux and Windows apps in GitHub Actions and publishes them as a GitHub release; the installer always takes the latest one, and the tag sets the version. The Mac app is unsigned, which the installer handles; a zip downloaded in a browser would need signing to open with a double-click.
