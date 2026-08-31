# Installing Pokémon Masters in Foundry VTT

A trainer-driven Pokémon system for **Foundry VTT v13–v14**. This guide covers
the easy install-by-link path first, then a manual fallback.

---

## Option A — Install by manifest link (recommended)

1. Open Foundry VTT and go to the **setup screen** (the one with *Game Systems*,
   *Modules*, *Worlds*).
2. Click the **Game Systems** tab → **Install System**.
3. In the **Manifest URL** box at the bottom, paste:

   ```
   https://github.com/painhog/pokegame/releases/latest/download/system.json
   ```

4. Click **Install**. Foundry downloads and unpacks the full package
   (Pokédex, moves, items, and every map — nothing else to fetch).
5. Go to the **Worlds** tab → **Create World**, and pick **Pokémon Masters** as
   the Game System. Launch the world.

> The link points at the latest automated build. If it ever 404s, the release is
> still being built — wait a minute and retry, or use Option B.

---

## Option B — Manual install (always works)

Use this if you'd rather build it yourself, or the release isn't up yet.

1. Download or clone the repo, then from its folder run:

   ```bash
   npm install
   npm run build      # compiles the compendium packs + generates the maps
   npm run sprites    # optional: bundles Pokémon sprites locally (else they load from the web)
   ```

2. Copy (or symlink) the whole folder into your Foundry data directory as
   `Data/systems/pokemon-masters`. Find your data path from Foundry's
   **Configuration** screen (*User Data Path*); the systems folder is
   `<that path>/Data/systems/`.

   ```bash
   # example (adjust the data path for your OS)
   ln -s "$(pwd)" "/path/to/FoundryVTT/Data/systems/pokemon-masters"
   ```

3. Restart Foundry. **Pokémon Masters** now appears under *Game Systems* — create
   a world with it.

---

## First steps inside a new world (GM)

1. **Import the maps.** Open the **Maps** compendium (compendium sidebar →
   *Pokémon Masters* folder → *Maps*) and import **Pallet Town** (and any others
   you want). Each scene is pre-wired with its region behaviors and exits, so
   walking a token to an edge travels to the next scene automatically.
2. **Make a Trainer.** Create an Actor of type **Trainer**. Open its sheet and
   assign it to a player under *Ownership*. Set a player's character to it
   (Players list → Configure → Character), so the system knows who's who.
3. **Choose a starter.** On the Trainer sheet, click **⭐ (Choose a starter)**,
   pick a region and starter — the region's Professor hands it over at level 5,
   already knowing its level-appropriate moves.
4. **Play.** Drop the Trainer's token on an imported map and move it around:
   - Stepping on wild tiles rolls encounters — a chat card with a **Throw Poké
     Ball** button.
   - Walking into a **town / Pokémon Center / Poké Mart / venue** posts its
     services (Nurse Joy heals, the Mart sells, the Quest Board offers jobs…).
   - Open the **📖 Pokédex** from the Trainer sheet to browse and search every
     species and see what you've caught.

Most player actions live on the two sheets (Trainer and Pokémon) and on chat-card
buttons. Everything else is scriptable via `game.pokemonMasters.*` in a macro if
a GM wants to trigger it directly (e.g. `game.pokemonMasters.league.gymChallenge(actor, "kanto", 0)`).

---

## Notes & known limits

- Built and verified without a live Foundry run: the data, maps, packs, and pure
  game logic are checked by the build, the lore verifier, a smoke test, and
  audits — but the in-Foundry glue (sheet rendering, region behaviors, the
  line-of-sight trainer AI) is best shaken out live. Report anything odd.
- Sprites are the animated PokéAPI mirror (CC0), keyed by Dex number, so a
  regional form shows its base species' sprite.
- Requires internet only if sprites weren't bundled (`npm run sprites`) — all
  game data is offline.
