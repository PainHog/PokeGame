/**
 * Pokémon Masters — system configuration.
 *
 * This object is exposed at `CONFIG.PM` during `init` and is used both by the
 * data models (for field `choices`) and by the region-behavior automation
 * (for default encounter tables). Everything here is browser-safe: it never
 * imports the build-time dataset (@pkmn/*). Species are referenced by display
 * name and resolved against the compiled `pokemon-masters.species` compendium
 * at runtime.
 */

export const PM = {};

/** The eighteen canonical Pokémon types (plus a stray/typeless bucket). */
PM.types = [
  "Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting", "Poison",
  "Ground", "Flying", "Psychic", "Bug", "Rock", "Ghost", "Dragon", "Dark",
  "Steel", "Fairy"
];

/**
 * Trainer vocations — the "jobs" from the world (breeders, rangers, etc.).
 * These gate future mechanics (breeding, catching bonuses, research payouts)
 * but for now are a first-class descriptor on every trainer.
 */
PM.vocations = {
  trainer: "Trainer",
  breeder: "Breeder",
  researcher: "Researcher",
  ranger: "Ranger",
  coordinator: "Coordinator",
  fisher: "Fisher",
  ace: "Ace Trainer"
};

/**
 * Rarity tiers. Assigned at build time from a species' base-stat total and used
 * to make rare Pokémon genuinely harder to find and catch.
 */
PM.rarities = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  veryrare: "Very Rare",
  legendary: "Legendary"
};

/** Baseline catch rate per rarity (0–255, higher = easier). */
PM.catchRateByRarity = {
  common: 190,
  uncommon: 120,
  rare: 60,
  veryrare: 30,
  legendary: 3
};

/**
 * Per-step "does this rare even show up" gate applied on top of table weighting.
 * A legendary that wins the weighted roll still only actually appears 20% of the
 * time, so encountering one is a real event. Tune freely.
 */
PM.rarityEncounterChance = {
  common: 1,
  uncommon: 1,
  rare: 0.85,
  veryrare: 0.6,
  legendary: 0.2
};

/**
 * Region/tile encounter categories. A GM drops an "Encounter" behavior on a
 * Scene Region, picks a category, and walking a Trainer token through it rolls
 * on the matching table below (unless the behavior supplies its own table).
 */
PM.encounterCategories = {
  grass: "Tall Grass",
  forest: "Forest",
  water: "Water (Surf)",
  fishing: "Fishing",
  cave: "Cave",
  mountain: "Mountain / Rocky",
  sand: "Desert / Sand",
  urban: "Urban",
  night: "Night"
};

/**
 * Default encounter tables keyed by category. Each row is a species name (must
 * match the Pokédex compendium), a relative weight, and an optional level band.
 * These are intentionally short, evocative starters — the GM can override the
 * whole table per-region in the behavior's config sheet.
 */
PM.defaultEncounterTables = {
  grass: [
    { species: "Pidgey", weight: 30, min: 2, max: 5 },
    { species: "Rattata", weight: 30, min: 2, max: 5 },
    { species: "Caterpie", weight: 15, min: 2, max: 4 },
    { species: "Bulbasaur", weight: 4, min: 3, max: 6 },
    { species: "Eevee", weight: 2, min: 4, max: 7 }
  ],
  forest: [
    { species: "Caterpie", weight: 25, min: 3, max: 6 },
    { species: "Weedle", weight: 25, min: 3, max: 6 },
    { species: "Oddish", weight: 20, min: 4, max: 7 },
    { species: "Pikachu", weight: 5, min: 4, max: 8 },
    { species: "Scyther", weight: 2, min: 8, max: 12 }
  ],
  water: [
    { species: "Tentacool", weight: 35, min: 5, max: 10 },
    { species: "Wingull", weight: 25, min: 5, max: 10 },
    { species: "Psyduck", weight: 15, min: 6, max: 12 },
    { species: "Lapras", weight: 2, min: 12, max: 18 }
  ],
  fishing: [
    { species: "Magikarp", weight: 55, min: 3, max: 8 },
    { species: "Goldeen", weight: 25, min: 5, max: 10 },
    { species: "Gyarados", weight: 3, min: 15, max: 22 },
    { species: "Dratini", weight: 3, min: 10, max: 15 }
  ],
  cave: [
    { species: "Zubat", weight: 35, min: 5, max: 10 },
    { species: "Geodude", weight: 30, min: 5, max: 10 },
    { species: "Onix", weight: 8, min: 8, max: 14 },
    { species: "Larvitar", weight: 2, min: 10, max: 15 }
  ],
  mountain: [
    { species: "Geodude", weight: 30, min: 6, max: 12 },
    { species: "Machop", weight: 20, min: 6, max: 12 },
    { species: "Rhyhorn", weight: 15, min: 8, max: 14 },
    { species: "Onix", weight: 10, min: 8, max: 14 },
    { species: "Aron", weight: 8, min: 6, max: 12 }
  ],
  sand: [
    { species: "Sandshrew", weight: 35, min: 6, max: 12 },
    { species: "Trapinch", weight: 20, min: 6, max: 12 },
    { species: "Cacnea", weight: 15, min: 7, max: 13 },
    { species: "Larvitar", weight: 3, min: 10, max: 15 }
  ],
  urban: [
    { species: "Rattata", weight: 40, min: 2, max: 6 },
    { species: "Meowth", weight: 25, min: 3, max: 7 },
    { species: "Growlithe", weight: 10, min: 5, max: 9 }
  ],
  night: [
    { species: "Gastly", weight: 30, min: 6, max: 12 },
    { species: "Hoothoot", weight: 30, min: 4, max: 9 },
    { species: "Murkrow", weight: 15, min: 6, max: 11 },
    { species: "Umbreon", weight: 2, min: 12, max: 18 }
  ]
};

/**
 * The regions of the world. A Scene is tagged with one of these (Scene Config →
 * "Pokémon Masters Region", stored as `scene.flags.pokemon-masters.region`), and
 * encounters on that map draw from the region's table set. This is how the same
 * "cave" tile yields Geodude in Kanto but Alolan Geodude in Alola.
 */
PM.regions = {
  kanto: "Kanto",
  johto: "Johto",
  hoenn: "Hoenn",
  sinnoh: "Sinnoh",
  unova: "Unova",
  kalos: "Kalos",
  alola: "Alola",
  galar: "Galar",
  hisui: "Hisui",
  paldea: "Paldea"
};

/**
 * Region-specific encounter tables. Keyed by region → category → rows. Anything
 * not defined here falls back to `PM.defaultEncounterTables` (the generic set).
 * Alola is seeded to demonstrate regional variants; author more regions freely.
 */
PM.regionEncounterTables = {
  alola: {
    grass: [
      { species: "Rattata-Alola", weight: 30, min: 2, max: 5 },
      { species: "Pikachu", weight: 15, min: 3, max: 6 },
      { species: "Cutiefly", weight: 20, min: 2, max: 5 },
      { species: "Vulpix-Alola", weight: 4, min: 4, max: 7 }
    ],
    cave: [
      { species: "Zubat", weight: 30, min: 5, max: 10 },
      { species: "Geodude-Alola", weight: 30, min: 5, max: 10 },
      { species: "Diglett-Alola", weight: 20, min: 5, max: 10 },
      { species: "Marowak-Alola", weight: 5, min: 10, max: 15 }
    ],
    urban: [
      { species: "Meowth-Alola", weight: 35, min: 3, max: 7 },
      { species: "Grimer-Alola", weight: 20, min: 5, max: 9 },
      { species: "Rattata-Alola", weight: 30, min: 2, max: 6 }
    ],
    water: [
      { species: "Wingull", weight: 30, min: 5, max: 10 },
      { species: "Tentacool", weight: 30, min: 5, max: 10 },
      { species: "Sandshrew-Alola", weight: 8, min: 6, max: 11 }
    ]
  }
};

/** Resolve the effective encounter table for a region + category (with fallback). */
PM.resolveEncounterTable = (region, category) =>
  (PM.regionEncounterTables?.[region]?.[category]) ??
  (PM.defaultEncounterTables?.[category]) ??
  [];

/**
 * Tile-event outcome kinds. When a Trainer steps on a "wild" region tile, one of
 * these is chosen by weight. `nothing` should dominate so the world feels calm
 * between events. `wild` is a battle, `item` a pickup, `trainer` an NPC battle,
 * `event` a GM-defined happening (macro/journal).
 */
PM.tileEventKinds = {
  wild: "Wild Pokémon",
  item: "Found Item",
  trainer: "Trainer Battle",
  event: "Special Event",
  nothing: "Nothing"
};

/**
 * Weighted table of items found on `item` outcomes. Names resolve (case-
 * insensitively) against the gear compendium when possible.
 */
PM.itemFindTable = [
  { item: "Potion", weight: 30 },
  { item: "Poké Ball", weight: 25 },
  { item: "Antidote", weight: 14 },
  { item: "Super Potion", weight: 12 },
  { item: "Great Ball", weight: 8 },
  { item: "Revive", weight: 6 },
  { item: "Rare Candy", weight: 3 },
  { item: "Nugget", weight: 2 }
];

/**
 * "Safe" tile kinds — streets, towns, Pokémon Centers, Marts. These never roll
 * events. A Center can heal the party on entry; a Mart flags a shop point.
 */
PM.safeZoneKinds = {
  street: "Street / Route Path",
  town: "Town",
  center: "Pokémon Center",
  mart: "Poké Mart",
  indoor: "Building Interior"
};

/**
 * Known Poké Ball catch multipliers, keyed by lower-cased ball name. Balls not
 * listed default to 1×. Applied when a catch is attempted (future combat/catch
 * flow); surfaced now on gear items.
 */
PM.ballModifiers = {
  "poke ball": 1,
  "great ball": 1.5,
  "ultra ball": 2,
  "master ball": 255,
  "premier ball": 1,
  "net ball": 3.5,
  "dive ball": 3.5,
  "nest ball": 4,
  "repeat ball": 3.5,
  "timer ball": 4,
  "dusk ball": 3,
  "quick ball": 5,
  "heal ball": 1,
  "luxury ball": 1
};
