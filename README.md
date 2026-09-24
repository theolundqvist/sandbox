# Sandbox

A live multiplayer game builder. You and your friends start in an empty 3D world, and every player's Claude Code hot-reloads new rules, weapons and whole games into it while you play, together or against each other. Changes go live for everyone in about half a second, and nobody gets disconnected.

## Host a world

```sh
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/theolundqvist/sandbox && cd sandbox
bun install
bun start
```

Open the main menu link the terminal prints (on a Mac it opens by itself). Start a new game and pick its settings:

- **Open** rules: anyone's Claude can change or remove anyone's mod.
- **Additive** rules: you can only add. Nobody can edit or remove a mod they didn't make, so you answer an attack by building a counter-mod.
- **Start with** an empty field (ground, sky and walking) or nothing at all.

Every world is saved. Host any of them again from the menu later.

## Let friends in

The main menu shows the invite link. Friends only need a browser. To play over the internet without opening ports, tick **Share over the internet**: the menu opens a free Cloudflare tunnel (install it once with `brew install cloudflared`) and shows a public invite link. The tunnel's address changes each time sharing starts, so the menu's player list has each friend's personal link to get back in as themselves. It also lets you remove players, make a new invite link, and rewind the world to any minute of the last hour.

## Connect your Claude

Press Esc in the game and paste the command into a terminal. During play the mouse steers the camera; Esc also frees it. It holds your personal key, connects Claude Code to the world and leaves it listening to the in-game chat. Go back to the game and ask for things right there: "add coins that respawn and a scoreboard", "make gravity flip every 30 seconds", "give me a grappling hook". Your Claude answers in the chat when it's live, and new mods arrive with an on-screen banner it names and colours.

Each Claude edits the same shared file tree on the server, and nothing goes live until it calls `reload`. A reload only swaps in if the mod passes three checks: it typechecks, it builds, and 20 test ticks run clean against a copy of the live world. Mods that crash, stall, or freeze the server after going live are reverted automatically, and the whole world sees it in the feed.

Mods can do anything: add entities, rewrite physics and rendering, keep secrets from some players, call web APIs, import npm packages and 3D models, or `wrap` another player's mod to intercept, bend, or reverse what it does. Claudes see what their player sees through a screenshot tool and read the in-game chat. `engine/GUIDE.md` is what every Claude reads first.

## Trust

Mods run as real code on the host's machine. Only invite people you would give a shell to.
