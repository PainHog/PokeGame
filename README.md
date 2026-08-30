# Pokémon Masters — a Foundry VTT system

A trainer-driven Pokémon tabletop **system** for [Foundry Virtual Tabletop](https://foundryvtt.com/)
**v14** (compatible from v13). Players join a shared world as **Trainers**, roam
tile/region-automated maps, and encounter, catch, and battle Pokémon.

The full Pokédex — species, base stats, types, abilities, evolutions, learnsets,
moves, and items — is compiled **offline** from the
[`@pkmn`](https://github.com/pkmn/ps) dataset (the community extraction of
Pokémon Showdown's data). **No external API is required at play time.**

> Status: **v0.1 vertical slice.** The data pipeline, actor/item data models,
> sheets, and the Region (tile) automation are in place. Battle resolution, the
> catch flow, breeding/jobs payouts, and cross-scene player warps are the next
> phases (see the roadmap).

---

## What's here

| Piece | Where | Notes |
|---|---|---|
| System manifest | `system.json` | v14 `documentTypes`, packs, grid |
| Data models | `src/module/data-models.mjs` | `trainer`, `pokemon` actors; `move`, `ability`, `gear` items |
| Documents | `src/module/documents.mjs` | party resolution, faint check, HP init |
| Sheets | `src/module/sheets.mjs` + `templates/` | ApplicationV2 + Handlebars |
| **Region (tile) behaviors** | `src/module/regions.mjs` | **Encounter** + **Zone Transit** |
| Config / tables | `src/module/config.mjs` | vocations, rarities, encounter tables |
| Pokédex build | `scripts/build-packs.mjs` | `@pkmn/data` → compiled LevelDB packs |

Compendium packs produced by the build:

- **Pokédex** (`species`) — one `pokemon` Actor per species (876), pre-filled with
  types, base stats, abilities, evolution data, learnset, and a rarity/catch-rate
  derived from base-stat total.
- **Moves** (685), **Abilities** (310), **Items & Poké Balls** (249).

---

## Install & build

The Pokédex data is a **build artifact** (git-ignored) generated from a pinned
dependency, so after cloning you build it once:

```bash
npm install
npm run build          # full Pokédex → packs/
# or, for fast iteration on a subset:
npm run build:limit    # 60 of each
```

Then point Foundry at the system. During development the simplest path is to
symlink (or clone) this folder into your Foundry user data:

```
{FoundryUserData}/Data/systems/pokemon-masters   ->   this repo
```

Restart Foundry, create a world using **Pokémon Masters**, and the four
compendiums appear under the "Pokémon Masters" pack folder.

> `packs/` and `src/packs/` are git-ignored. Re-running `npm run build` is
> idempotent — document IDs are derived deterministically from names, so UUIDs
> stay stable across rebuilds. Re-run it to pull dataset updates.

---

## The tile / region automation (the core idea)

Foundry v12+ replaced ad-hoc "tile triggers" with first-class **Scene Regions**
that emit movement events. Pokémon Masters ships two **Region Behaviors** you
attach to a region to make walking the map *do* things — no extra modules.

### 1. Wild Encounter

Draw a region over tall grass / water / a cave, add behavior **“Wild Encounter
(Pokémon Masters)”**, and configure:

- **Encounter Table** — `grass`, `forest`, `water`, `fishing`, `cave`,
  `mountain`, `sand`, `urban`, `night`. Each has a built-in weighted table
  (edit `PM.defaultEncounterTables` in `config.mjs`, or supply a **custom table**
  right on the behavior).
- **Encounter Chance (%)** — rolled on each step (or only on entry).
- **Min/Max Level** — the wild level band.
- **Announce Only** — post a chat card, or also drop a wild token next to the trainer.

When a **Trainer** token walks through, the behavior rolls the chance, picks a
weighted species, and posts *“A wild Geodude appeared! Lv 8 — Rock/Ground …”*.

**Rare Pokémon are genuinely hard to find.** Rarity is assigned at build time
from base-stat total, and a second **rarity gate** (`PM.rarityEncounterChance`)
means a legendary that wins the weighted roll still only actually shows up ~20%
of the time. So "rock Pokémon in the mountains, water Pokémon while surfing,
Magikarp while fishing, and a legendary you'll hunt for weeks" all fall out of
the table + gate design. Only the active GM's client rolls, so no duplicate
encounters across players.

### 2. Zone Transit

Add behavior **“Zone Transit (Pokémon Masters)”** to a region at a map edge or
doorway to announce a named zone (*“Ash entered Viridian Forest.”*) and/or warp
the token to a destination — the "walk to the next zone automatically" flow.
Same-scene warps work now; cross-scene **player** pulls are on the roadmap
(the core **Teleport Token** behavior already covers region→region cross-scene
if you need it today).

---

## Data model highlights

- **Trainer** — `vocation` (Trainer / Breeder / Researcher / Ranger / Coordinator /
  Fisher / Ace), `level`, `money`, `badges`, `party` (Pokémon by UUID), biography.
  Vocations are the hook for the show's "jobs" (breeders, rangers…).
- **Pokémon** — species + dex #, types, `level`, `nature`, `gender`, `shiny`,
  `rarity`, `catchRate`, `ability`, base stats, derived stats (`system.stats`),
  an HP resource wired to the token bar, `moves`, full `learnset`, and evolution
  (`from` / `into` / `method` / `level` / `item` / `condition`).
- **Move** — `moveType`, `category`, `power`, `accuracy`, `pp`, `priority`, `target`.
- **Gear** — `category` (item / ball / medicine / berry / TM / key), `catchModifier`
  for Poké Balls, price, quantity.

---

## Roadmap

1. **Catch flow** — a chat-card "throw ball" using `catchRate` × ball modifier × status.
2. **Battle resolution** — damage from the type chart + move category + stats
   (the `@pkmn` type effectiveness data can be baked into a config table).
3. **Jobs** — breeding (Breeder), field research payouts (Researcher/Ranger),
   contest scoring (Coordinator).
4. **Sprites** — optional sprite/cry assets per species.
5. **Cross-scene player warps** — socket-driven pull for Zone Transit.

---

## Credits & licensing

Game data is derived from the [`@pkmn`](https://github.com/pkmn/ps) project
(Pokémon Showdown data). Pokémon and Pokémon character names are trademarks of
Nintendo / Game Freak / The Pokémon Company. This is a non-commercial fan
project; do not distribute compiled game data without regard to those rights.
