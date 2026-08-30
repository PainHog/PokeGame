# Pokémon Masters — a Foundry VTT system

A trainer-driven Pokémon tabletop **system** for [Foundry Virtual Tabletop](https://foundryvtt.com/)
**v14** (compatible from v13). Players join a shared, animated world as **Trainers**
(or Breeders, Rangers, Rocket grunts…), roam tile/region-automated maps, and
encounter, catch, battle, and raise Pokémon — with NPCs that can battle on their own.

The full Pokédex is compiled **offline** from the [`@pkmn`](https://github.com/pkmn/ps)
dataset. **No external API is required at play time.**

---

## What's shipped

| System | What it does |
|---|---|
| **Complete Pokédex** | All 1025 dex numbers (1367 entries incl. regional forms), 905 moves, 310 abilities, 533 items — offline. |
| **Region-tagged maps** | Tag each Scene with a region; encounters use region-appropriate species (Alolan vs. Kanto Geodude). |
| **Tile events** | Stepping on a non-safe tile rolls a weighted outcome: wild Pokémon / item / trainer / event. |
| **Encounter eligibility** | Every species has requirements (habitat, region, method, time); **all must match** to roll. |
| **Population caps** | Legendaries/mythicals are unique (one in the world); gone once caught, freed if released. |
| **Safe zones** | Streets/towns/Centers/Marts never roll events; a Center heals the party. |
| **Catch flow** | Gen III/IV formula with **lore-accurate Poké Balls** (Net, Dusk, Quick, Timer, Level, Beast…). |
| **Battle engine** | Verified 18-type chart, mainline damage, move use vs. a target, faint. |
| **Progression** | XP → level-up → learn moves → evolution, off the faint hook. |
| **NPC auto-battle** | Type-aware AI resolves full team battles unattended (gym leaders, rivals). |
| **Starters** | Region starter trios granted at level 5. |
| **PC storage** | Party capped at 6; overflow routes to PC boxes (deposit/withdraw). |
| **Organizations** | Join the League, Ranger Union, Team Rocket, etc.; reputation promotes you up rank ladders. |
| **Careers** | 14 vocations (Trainer, Ace, Ranger, Professor, Breeder, Gym Leader, Coordinator, Nurse…). |
| **Living Pokédex** | Per-trainer seen/caught tracking toward 1025. |

Roadmap (not yet built): usable items, gyms/badges + Elite Four gauntlet, breeding & daycare,
faction encounters (Rocket raids / street & stadium battles), TMs & HMs. See the blueprint artifact.

---

## Install & build

The Pokédex data is a build artifact (git-ignored), generated from a pinned dependency:

```bash
npm install
npm run build          # full Pokédex → packs/
npm run build:limit    # fast 60-of-each subset while iterating
```

Then symlink (or clone) this folder into your Foundry user data so Foundry sees it:

```
{FoundryUserData}/Data/systems/pokemon-masters   ->   this repo
```

Restart Foundry, create a world using **Pokémon Masters**, and the compendiums appear.

---

## The core loop

```
walk onto a tile ─▶ Wild Tile behavior rolls (chance %)
        │
        ├─ outcome = wild ─▶ eligible species for {region, habitat, method}
        │                     (all requirements match, capped species excluded)
        │                     ─▶ weighted by rarity ─▶ encounter card
        │                          └─▶ "Throw Poké Ball" ─▶ catch formula ─▶ party/PC + Pokédex
        ├─ outcome = item ─▶ item find
        └─ outcome = trainer/event ─▶ battle / GM hook

battle ─▶ use move vs target ─▶ damage (type chart + STAB) ─▶ faint
        └─▶ winner gains XP ─▶ level-up ─▶ learn moves ─▶ evolve
```

Everything above is driven by **Foundry Scene Regions** — the art and the mechanics
are separate layers (see below).

---

## Making maps

**The mechanics never depend on the art.** A Wild Tile / Safe Zone / Zone Transit
behavior is attached to a **Scene Region**, which is an invisible shape you paint over
*any* background. So you have three escalating options:

1. **Prototype now — colored regions, no art.** Create a Scene, draw Regions over
   "grass", "water", "cave" areas, add the behaviors, and play immediately. Foundry
   renders regions as translucent color; that's enough to test the whole loop.
2. **Real maps — a background image + regions.** Get a region map as a PNG and set it
   as the Scene background, size the grid, then paint Regions over the grass/water/etc.
   Sources for the art:
   - **Ripped official maps** (GBA/DS region maps from community sprite archives) — set
     one as the Scene background. Fastest way to "stretch over the Pokémon game maps."
     Fan/IP use — fine for a private game, not for redistribution.
   - **Build your own in [Tiled](https://www.mapeditor.org/)** with a Pokémon tileset
     (e.g. the Pokémon Essentials / RPG Maker XP tilesets), export a PNG, use as
     background. Best for custom towns/routes.
3. **Tile the map inside Foundry** with the Tiles layer from a tileset — workable, but
   Tiled is a better editor for large maps.

Whichever you choose, the region/behavior layer is identical, so you can swap art in
later without redoing mechanics. Tag each Scene's region in **Scene Config → Pokémon
Masters Region**.

---

## Systems & APIs

Runtime helpers live under `game.pokemonMasters.*` (GM console or macros):

```js
// Catch the currently-targeted wild Pokémon
game.pokemonMasters.catch.throwAtTarget();

// Auto-resolve a battle between two NPC trainers
game.pokemonMasters.npc.autoBattle(actorA, actorB);

// Use a move (usually via the Pokémon sheet button)
game.pokemonMasters.battle.useMove(attacker, moveItem);

// Grant a starter / give reputation / award XP
game.pokemonMasters.starters.choose(trainer);
game.pokemonMasters.orgs.addReputation(trainer, "rocket", 120);
game.pokemonMasters.progression.awardXp(pokemon, 60);
```

Source modules (all `src/module/`): `config`, `data-models`, `documents`, `sheets`,
`regions`, `eligibility`, `world`, `catch`, `balls`, `battle`, `typechart`,
`progression`, `starters`, `storage`, `organizations`, `dex`, `npc`.

Data is rebuilt by `scripts/build-packs.mjs` from `@pkmn/dex`.

---

## Roadmap

Usable items · gyms/badges + Elite Four gauntlet · breeding & daycare · faction
encounters (Rocket raids, street & stadium battles) · TMs & HMs (teach moves + field
traversal). The blueprint artifact tracks the full phased plan.

---

## Credits & licensing

Game data derives from the [`@pkmn`](https://github.com/pkmn/ps) project (Pokémon
Showdown data). Pokémon and character names are trademarks of Nintendo / Game Freak /
The Pokémon Company. Non-commercial fan project.
