# Sandbox desktop app

Play any Sandbox world in its own window instead of a browser tab: right-click reaches the game, the mouse locks without a warning banner, and browser shortcuts like Ctrl+W or Ctrl+R can't close or reload the game.

## Get it

Download the file for your computer from the [latest release](https://github.com/theolundqvist/sandbox/releases/latest):

- **Mac with Apple silicon:** `Sandbox-mac-arm64.zip`. **Older Intel Mac:** `Sandbox-mac-x64.zip`.
- **Windows:** `Sandbox-win-x64.exe`. It runs straight away without installing.
- **Linux:** `Sandbox-linux-x86_64.AppImage`. Make it executable with `chmod +x`, then run it.

The app isn't signed, so the first launch needs one extra step:

- **Mac:** unzip it and move `Sandbox.app` to Applications. Then run `xattr -dr com.apple.quarantine /Applications/Sandbox.app` in Terminal once. Or open it, close the warning, and click **Open Anyway** in System Settings → Privacy & Security. On macOS 14 and older, right-clicking the app and choosing **Open** also works.
- **Windows:** when SmartScreen says "Windows protected your PC", click **More info**, then **Run anyway**.

## Play

Paste the invite link your host sent and press Enter. The worlds you've joined show up on the start screen, so next time you just pick one. If you host on the same computer, **Host a world** opens your main menu. The first time, paste the main menu link your terminal printed, so the app knows you're the host.

- **Full screen:** F11, or Ctrl+Cmd+F on a Mac. The app remembers it.
- **Mouse:** click the game to look around. Esc, Tab (menu) and Enter (chat) free the mouse. Switching back to the app from another window picks the mouse back up.
- **Quit:** Cmd+Q on a Mac. On every system, closing the window asks first while you're in a world.

## Run from source

```sh
cd desktop
bun install
bun start
```

Push a `v*` tag to build the Mac, Windows and Linux apps and attach them to a GitHub release. Running the **Desktop app** workflow by hand builds them without releasing.
