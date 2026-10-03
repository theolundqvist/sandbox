# Community mods

When to use: before writing a common system (inventory, day and night, vehicles, shops, quests, weather, pets), to add one another world already published instead of building it from scratch.

Community mods are single mods other worlds shared: their code and assets, a README and the API they export. Adding one copies it into `mods/` as a normal mod you can read, edit and reload.

## Find, read, add

1. `./world search_mods q="day night"` lists matches, most used first: the id, folder name, author, how many worlds use it, one line about it and a preview image URL. Open the preview image to judge the look before adding.
2. `./world read_mod id=<id>` shows its README, the API other mods reach with `world.use("<name>")`, the npm packages it installs and the other mods it needs. Check that it does what your players asked and that its needs exist here or can be added too.
3. `./world add_mod id=<id>` downloads it into `mods/<name>/`, installs its packages and reloads it live. If a mod with that folder name already exists, pass `as=<another-name>`.

Prefer one well-used mod over several overlapping ones, and prefer building on its API over copying its code.

## After adding

- It is yours now: edit its files and `reload` like any other mod. Restyle it to match this world's look.
- `mods/<name>/community.json` records where it came from (id, author, link). Leave it in place: it credits the author and makes a later share of this mod a fork of theirs.
- If it didn't go live, the reply says why (usually a missing package or mod). Fix the files and `reload`.

## Sharing back

Only the host shares a mod, from the game: Tab, then Mods, then Share on that mod's row. It asks for their Community account, sends only that mod's code and assets (never the world's saves, chat or keys) and takes the current view as its preview. Suggest it when you built something other worlds would want, and make sure its README says what it does and how to use it.
