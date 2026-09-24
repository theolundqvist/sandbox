# Sandbox

An empty 3D world that you and your friends turn into a game while you play it. Every player connects their own Claude Code. Every change goes live for everyone in about half a second, and nobody gets disconnected.

## Host a world

```sh
curl -fsSL https://bun.sh/install | bash
git clone <this repo> sandbox && cd sandbox
bun install
bun start
```

Open the setup link the terminal prints, name the world, and pick the house rules:

- **Open**: anyone's Claude can change or remove anyone's mod.
- **Additive**: you can only add. Nobody can edit or remove a mod they didn't make, so you answer an attack by building a counter-mod.

## Let friends in

Press Tab in the game and send them the invite link. Friends only need a browser.

To play over the internet without opening ports:

```sh
cloudflared tunnel --url http://localhost:7777
```

Share the `https://…trycloudflare.com/#invite=…` address instead. Everything runs over that single port.

## Connect your Claude

Press Tab in the game and copy the `claude mcp add …` command into a terminal. It holds your personal key. Then ask Claude Code to build something: "add coins that respawn and a scoreboard", "make gravity flip every 30 seconds", "give me a grappling hook".

Each Claude edits the same shared file tree on the server, and nothing goes live until it calls `reload`. A reload only swaps in if the mod passes three checks: it typechecks, it builds, and 20 test ticks run clean against a copy of the live world. Mods that crash, stall, or freeze the server after going live are reverted automatically, and the whole world sees it in the feed.

Mods can do anything: add entities, rewrite physics, or `wrap` another player's mod to intercept, bend, or reverse what it does. `engine/GUIDE.md` is what every Claude reads first.

## Trust

Mods run as real code on the host's machine. Only invite people you would give a shell to.
