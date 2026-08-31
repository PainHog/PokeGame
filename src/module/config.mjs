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
  ace: "Ace Trainer",
  ranger: "Pokémon Ranger",
  professor: "Professor",
  assistant: "Research Assistant",
  breeder: "Breeder",
  daycare: "Daycare Attendant",
  gymleader: "Gym Leader",
  coordinator: "Coordinator / Contest Star",
  elitefour: "Elite Four",
  champion: "Champion",
  fisher: "Fisher",
  nurse: "Nurse / Doctor",
  photographer: "Photographer"
};

/**
 * What each vocation actually does in play — a short player-facing note plus the
 * systems it unlocks. Drives the trainer sheet's job blurb and future job gates.
 */
PM.vocationInfo = {
  trainer: { blurb: "Battle, catch, and earn badges — the classic journey.", unlocks: ["battling", "gyms"] },
  ace: { blurb: "Battling as a career or serious side job; higher battle payouts.", unlocks: ["battling", "bounties"] },
  ranger: { blurb: "Care for a region and its Pokémon; field patrols and rescues.", unlocks: ["patrols", "rescues"] },
  professor: { blurb: "Study Pokémon; run research tasks and hand out starters.", unlocks: ["research", "dex-payouts"] },
  assistant: { blurb: "Assist a Professor; fieldwork and dex data collection.", unlocks: ["research"] },
  breeder: { blurb: "Run a daycare and breed Pokémon; raise eggs.", unlocks: ["breeding", "daycare"] },
  daycare: { blurb: "Tend young and baby Pokémon at a daycare.", unlocks: ["daycare"] },
  gymleader: { blurb: "A pillar of the community; run a gym and test challengers.", unlocks: ["gym-ownership", "battling"] },
  coordinator: { blurb: "Dazzle crowds in Contests with style and flair.", unlocks: ["contests"] },
  elitefour: { blurb: "An elite, celebrity-tier battler near the top of the League.", unlocks: ["battling", "league"] },
  champion: { blurb: "The pinnacle: broad knowledge and unmatched skill.", unlocks: ["battling", "league"] },
  fisher: { blurb: "Fish and trade aquatic Pokémon; water-method specialist.", unlocks: ["fishing", "trading"] },
  nurse: { blurb: "Heal Pokémon at Centers; treat status and injuries in the field.", unlocks: ["healing", "centers"] },
  photographer: { blurb: "Capture Pokémon on film for pay; rare shots earn more.", unlocks: ["photography", "bounties"] }
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

/**
 * The 25 natures. `plus`/`minus` name the stat raised/lowered by 10%; the five
 * neutral natures have neither. Applied in the Pokémon's derived-stat calc.
 */
PM.natures = {
  hardy: {}, lonely: { plus: "atk", minus: "def" }, brave: { plus: "atk", minus: "spe" }, adamant: { plus: "atk", minus: "spa" }, naughty: { plus: "atk", minus: "spd" },
  bold: { plus: "def", minus: "atk" }, docile: {}, relaxed: { plus: "def", minus: "spe" }, impish: { plus: "def", minus: "spa" }, lax: { plus: "def", minus: "spd" },
  timid: { plus: "spe", minus: "atk" }, hasty: { plus: "spe", minus: "def" }, serious: {}, jolly: { plus: "spe", minus: "spa" }, naive: { plus: "spe", minus: "spd" },
  modest: { plus: "spa", minus: "atk" }, mild: { plus: "spa", minus: "def" }, quiet: { plus: "spa", minus: "spe" }, bashful: {}, rash: { plus: "spa", minus: "spd" },
  calm: { plus: "spd", minus: "atk" }, gentle: { plus: "spd", minus: "def" }, sassy: { plus: "spd", minus: "spe" }, careful: { plus: "spd", minus: "spa" }, quirky: {}
};

/** Shiny odds (Gen 6+ base rate). */
PM.shinyRate = 1 / 4096;

/** Status conditions (used by battle, catch bonuses, and healing items). */
PM.statuses = {
  none: "Healthy",
  poison: "Poisoned",
  toxic: "Badly Poisoned",
  burn: "Burned",
  paralysis: "Paralyzed",
  sleep: "Asleep",
  freeze: "Frozen"
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
 * Special venues — tag a Scene Region with a Venue behavior so walking into the
 * building offers the activity (no crowded sheet buttons). `venueInfo` drives
 * the themed arrival card.
 */
PM.venueKinds = {
  safari: "Safari Zone",
  bugcontest: "Bug-Catching Contest",
  gamecorner: "Game Corner",
  battletower: "Battle Tower",
  raid: "Max Raid Den",
  fossil: "Fossil Lab",
  lottery: "Lottery Corner",
  berry: "Berry Garden",
  police: "Police Station",
  questboard: "Quest Board"
};

PM.venueInfo = {
  safari: { label: "Safari Zone", icon: "🦓", cta: "Enter the Safari Zone" },
  bugcontest: { label: "Bug-Catching Contest", icon: "🐛", cta: "Join the contest" },
  gamecorner: { label: "Game Corner", icon: "🎰", cta: "Play the Game Corner" },
  battletower: { label: "Battle Tower", icon: "🏯", cta: "Take the challenge" },
  raid: { label: "Max Raid Den", icon: "🔴", cta: "Challenge the den" },
  fossil: { label: "Fossil Lab", icon: "🦴", cta: "Revive a fossil" },
  lottery: { label: "Lottery Corner", icon: "🎫", cta: "Draw a ticket" },
  berry: { label: "Berry Garden", icon: "🫐", cta: "Tend the garden" },
  police: { label: "Police Station", icon: "🚓", cta: "Speak to Officer Jenny" },
  questboard: { label: "Quest Board", icon: "📋", cta: "Check for jobs" }
};

/**
 * Region starter trios (anime/game accurate). The starter picker grants one at
 * level 5. Names resolve against the Pokédex compendium.
 */
/**
 * NPC/trainer token sprites — full-colour Gen-3 pixel art (bundled under
 * assets/trainers/, fetched by `npm run trainers`). A Trainer actor is
 * auto-assigned one by matching keywords in its name so the world reads at a
 * glance: named gym leaders, the Elite Four, champions, villain-team members and
 * professors get their real sprites; everyone else gets a fitting trainer class.
 * These are uniform 64×64 colour sprites, matching the front-facing Pokémon
 * battle sprites. GMs can always set a custom token image instead.
 */
PM.npcSpriteBase = "systems/pokemon-masters/assets/trainers/";
PM.npcSpriteMatch = [
  // — Named Kanto gym leaders —
  [/\bbrock\b/i, "leader_brock"], [/\bmisty\b/i, "leader_misty"],
  [/(lt\.? ?)?surge/i, "leader_lt_surge"], [/\berika\b/i, "leader_erika"],
  [/\bkoga\b/i, "leader_koga"], [/\bsabrina\b/i, "leader_sabrina"],
  [/\bblaine\b/i, "leader_blaine"], [/\bgiovanni\b/i, "leader_giovanni"],
  // — Named Hoenn gym leaders —
  [/roxanne/i, "leader_roxanne"], [/brawly/i, "leader_brawly"],
  [/wattson/i, "leader_wattson"], [/flannery/i, "leader_flannery"],
  [/\bnorman\b/i, "leader_norman"], [/winona/i, "leader_winona"],
  [/tate|liza/i, "leader_tate_and_liza"], [/wallace|\bjuan\b/i, "leader_wallace"],
  // — Elite Four & Champions —
  [/lorelei/i, "elite_four_lorelei"], [/\bbruno\b/i, "elite_four_bruno"],
  [/agatha/i, "elite_four_agatha"], [/\blance\b/i, "elite_four_lance"],
  [/sidney/i, "elite_four_sidney"], [/phoebe/i, "elite_four_phoebe"],
  [/glacia/i, "elite_four_glacia"], [/\bdrake\b/i, "elite_four_drake"],
  [/steven/i, "champion_steven"],
  [/\brival\b|\bblue\b|\bgary\b|\bgreen\b/i, "champion_rival"],
  // — Villain teams (boss → admin → grunt; female cues where possible) —
  [/maxie/i, "magma_leader_maxie"], [/archie/i, "aqua_leader_archie"],
  [/magma.*(admin|leader)/i, "magma_admin_m"], [/aqua.*(admin|leader)/i, "aqua_admin_m"],
  [/magma/i, "magma_grunt_m"], [/aqua/i, "aqua_grunt_m"],
  [/jessie/i, "rocket_grunt_f"], [/\bjames\b/i, "rocket_grunt_m"],
  [/rocket|galactic|plasma|flare|skull|team ?star|team ?yell|macro|grunt|admin/i, "rocket_grunt_m"],
  // — Service / town NPCs —
  [/nurse|joy/i, "nurse"], [/officer|police|jenny|cop\b/i, "policeman"],
  [/mart|clerk|cashier|shopkeep/i, "mart_clerk"],
  [/\bmom\b|mother/i, "mom"], [/reporter|interview|press/i, "reporter_m"],
  [/\bcook\b|chef|waiter/i, "cook"], [/professor|\bprof\b|\bdr\.? /i, "professor_oak"],
  // — Civilian / trainer classes —
  [/bug ?catcher/i, "bug_catcher"], [/youngster/i, "youngster"], [/\blass\b/i, "lass"],
  [/black ?belt/i, "black_belt"], [/\bhiker\b/i, "hiker"], [/fisher(man)?|angler/i, "fisherman"],
  [/sailor|swimmer/i, "swimmer_m"], [/\bbeauty\b/i, "beauty"], [/gentle ?man/i, "gentleman"],
  [/scientist/i, "scientist"], [/psychic/i, "psychic_m"], [/\blady\b/i, "lady"],
  [/camper/i, "camper"], [/picnicker/i, "picnicker"], [/painter|artist/i, "painter"],
  [/guitarist|rocker|musician|bard/i, "guitarist"], [/biker/i, "biker"],
  [/ranger/i, "pokemon_ranger_m"], [/breeder/i, "pokemon_breeder"],
  [/\bgambler\b|gamer|game ?boy/i, "gamer"], [/super ?nerd|engineer|nerd/i, "super_nerd"],
  [/rich|millionaire|gentleman|collector/i, "rich_boy"], [/ninja/i, "ninja_boy"],
  [/dragon/i, "dragon_tamer"], [/aroma|florist/i, "aroma_lady"],
  [/hex|witch|psychic ?girl/i, "hex_maniac"], [/expert|veteran|ace/i, "expert_m"],
  [/school ?kid|student|pupil/i, "school_kid_m"], [/pok[eé] ?fan|fan\b/i, "pokefan_m"],
  [/old ?man|gramps|grandpa|\belder\b/i, "old_man"],
  [/old ?woman|granny|grandma/i, "old_woman"],
  [/\bkid\b|\bboy\b|child/i, "little_boy"], [/\bgirl\b/i, "little_girl"],
  [/tamer|maniac/i, "pokemaniac"], [/bird ?keeper|falconer/i, "bird_keeper"],
  [/leader|kahuna|captain|elite|champion|gym/i, "cool_trainer_m"], // generic authority fallback
];
/** The sprite path for a trainer/NPC of the given name (defaults to Ace Trainer). */
PM.npcSpriteFor = function npcSpriteFor(name = "") {
  for (const [re, key] of PM.npcSpriteMatch) if (re.test(name)) return `${PM.npcSpriteBase}${key}.png`;
  return `${PM.npcSpriteBase}cool_trainer_m.png`;
};

/**
 * Player-selectable trainer avatars (choose your look + gender, like the games).
 * Each id is a file in assets/trainers/. Used by the appearance picker on the
 * trainer sheet and offered during onboarding.
 */
PM.playerAvatars = [
  // Male
  { id: "red", label: "Red", gender: "male" },
  { id: "ruby_sapphire_brendan", label: "Brendan", gender: "male" },
  { id: "wally", label: "Wally", gender: "male" },
  { id: "cool_trainer_m", label: "Ace Trainer", gender: "male" },
  { id: "black_belt", label: "Black Belt", gender: "male" },
  { id: "swimmer_m", label: "Swimmer", gender: "male" },
  { id: "psychic_m", label: "Psychic", gender: "male" },
  { id: "camper", label: "Camper", gender: "male" },
  { id: "bug_catcher", label: "Bug Catcher", gender: "male" },
  { id: "hiker", label: "Hiker", gender: "male" },
  { id: "ninja_boy", label: "Ninja Boy", gender: "male" },
  { id: "guitarist", label: "Guitarist", gender: "male" },
  { id: "biker", label: "Biker", gender: "male" },
  { id: "pokefan_m", label: "PokéFan", gender: "male" },
  { id: "expert_m", label: "Expert", gender: "male" },
  { id: "school_kid_m", label: "School Kid", gender: "male" },
  // Female
  { id: "leaf", label: "Leaf", gender: "female" },
  { id: "ruby_sapphire_may", label: "May", gender: "female" },
  { id: "cool_trainer_f", label: "Ace Trainer", gender: "female" },
  { id: "battle_girl", label: "Battle Girl", gender: "female" },
  { id: "swimmer_f", label: "Swimmer", gender: "female" },
  { id: "psychic_f", label: "Psychic", gender: "female" },
  { id: "lass", label: "Lass", gender: "female" },
  { id: "beauty", label: "Beauty", gender: "female" },
  { id: "aroma_lady", label: "Aroma Lady", gender: "female" },
  { id: "picnicker", label: "Picnicker", gender: "female" },
  { id: "parasol_lady", label: "Parasol Lady", gender: "female" },
  { id: "pokefan_f", label: "PokéFan", gender: "female" },
  { id: "expert_f", label: "Expert", gender: "female" },
  { id: "pokemon_ranger_f", label: "Ranger", gender: "female" },
  { id: "hex_maniac", label: "Hex Maniac", gender: "female" },
  { id: "school_kid_f", label: "School Kid", gender: "female" },
];
/** Absolute token image path for a player-avatar id. */
PM.avatarImg = (id) => `${PM.npcSpriteBase}${id}.png`;

/** The town a new trainer of each region spawns in (auto-placed on start). */
PM.startTowns = {
  kanto: "Pallet Town", johto: "New Bark Town", hoenn: "Littleroot Town",
  sinnoh: "Twinleaf Town", unova: "Nuvema Town", kalos: "Vaniville Town",
  alola: "Iki Town", galar: "Postwick", paldea: "Cabo Poco", hisui: "Jubilife Village"
};

PM.starterSets = {
  kanto: ["Bulbasaur", "Charmander", "Squirtle"],
  johto: ["Chikorita", "Cyndaquil", "Totodile"],
  hoenn: ["Treecko", "Torchic", "Mudkip"],
  sinnoh: ["Turtwig", "Chimchar", "Piplup"],
  unova: ["Snivy", "Tepig", "Oshawott"],
  kalos: ["Chespin", "Fennekin", "Froakie"],
  alola: ["Rowlet", "Litten", "Popplio"],
  galar: ["Grookey", "Scorbunny", "Sobble"],
  hisui: ["Rowlet", "Cyndaquil", "Oshawott"],
  paldea: ["Sprigatito", "Fuecoco", "Quaxly"]
};

/**
 * Joinable organizations. Each has a rank ladder; reputation earned through
 * org-appropriate deeds promotes a member up the ladder over time. Alignment
 * flavors the world (a Rocket can't also be Champion without consequences).
 */
PM.organizations = {
  league: { label: "Pokémon League", align: "good", desc: "Earn badges and climb toward Champion.", ranks: ["Challenger", "Badge Holder", "Gym Trainer", "Gym Leader", "Elite Four", "Champion"] },
  rangers: { label: "Ranger Union", align: "good", desc: "Protect regions and the Pokémon in them.", ranks: ["Cadet", "Ranger", "Top Ranger", "Ranger Leader"] },
  lab: { label: "Professor's Lab", align: "good", desc: "Study Pokémon and complete the Pokédex.", ranks: ["Intern", "Assistant", "Researcher", "Professor"] },
  breeders: { label: "Breeders' Guild", align: "good", desc: "Raise, hatch, and breed Pokémon.", ranks: ["Helper", "Breeder", "Master Breeder"] },
  contests: { label: "Contest Association", align: "good", desc: "Dazzle crowds through contests.", ranks: ["Normal Rank", "Super Rank", "Hyper Rank", "Master Rank", "Top Coordinator"] },
  anglers: { label: "Anglers' Society", align: "neutral", desc: "Fish for and trade aquatic Pokémon.", ranks: ["Novice", "Angler", "Master Angler"] },
  rocket: { label: "Team Rocket", align: "villain", desc: "Steal, scheme, and rise through the syndicate.", ranks: ["Recruit", "Grunt", "Agent", "Executive", "Admin", "Boss"] },
  magma: { label: "Team Magma", align: "villain", desc: "Expand the land at any cost.", ranks: ["Grunt", "Agent", "Admin", "Leader"] },
  aqua: { label: "Team Aqua", align: "villain", desc: "Expand the sea at any cost.", ranks: ["Grunt", "Agent", "Admin", "Leader"] },
  galactic: { label: "Team Galactic", align: "villain", desc: "Harness legendary power to remake the universe.", ranks: ["Grunt", "Commander", "Boss"] },
  plasma: { label: "Team Plasma", align: "villain", desc: "\"Liberate\" Pokémon — or seize power behind the cause.", ranks: ["Grunt", "Knight", "Sage", "Shadow", "King"] },
  flare: { label: "Team Flare", align: "villain", desc: "Wealth, beauty, and a chillingly selective new world.", ranks: ["Grunt", "Admin", "Scientist", "Boss"] },
  skull: { label: "Team Skull", align: "villain", desc: "Misfits making trouble across the islands.", ranks: ["Grunt", "Enforcer", "Big Sister/Brother", "Boss"] },
  star: { label: "Team Star", align: "villain", desc: "Rule the school through the Starfall Street crews.", ranks: ["Cadet", "Grunt", "Squad Boss", "Big Boss"] },
  aether: { label: "Aether Foundation", align: "neutral", desc: "Conserve and protect Pokémon — officially, at least.", ranks: ["Intern", "Employee", "Researcher", "Branch Chief", "President"] },
  yell: { label: "Team Yell", align: "neutral", desc: "Rowdy super-fans cheering their idol to the top.", ranks: ["Fan", "Rowdy Fan", "Biker"] },
  macro: { label: "Macro Cosmos", align: "neutral", desc: "The corporation that powers Galar — and its League.", ranks: ["Employee", "Manager", "Executive", "Chairman"] },
  silph: { label: "Silph Co.", align: "good", desc: "Kanto's tech giant — the makers of the Master Ball.", ranks: ["Intern", "Engineer", "Lead", "President"] },
  devon: { label: "Devon Corporation", align: "good", desc: "Hoenn's innovator in Poké Balls, PokéNav, and more.", ranks: ["Intern", "Researcher", "Senior Researcher", "President"] }
};

/** Which region each organization is most associated with (flavor / availability). */
PM.organizationRegions = {
  rocket: "kanto", magma: "hoenn", aqua: "hoenn", galactic: "sinnoh", plasma: "unova",
  flare: "kalos", skull: "alola", aether: "alola", star: "paldea", yell: "galar",
  macro: "galar", silph: "kanto", devon: "hoenn"
};

/** Reputation needed to advance one rank (rank N needs N × this in total). */
PM.reputationPerRank = 100;

/** Sample gym-badge names per region (GMs can rename; drives the League ladder). */
PM.leagueBadges = {
  kanto: ["Boulder", "Cascade", "Thunder", "Rainbow", "Soul", "Marsh", "Volcano", "Earth"],
  johto: ["Zephyr", "Hive", "Plain", "Fog", "Storm", "Mineral", "Glacier", "Rising"],
  hoenn: ["Stone", "Knuckle", "Dynamo", "Heat", "Balance", "Feather", "Mind", "Rain"],
  sinnoh: ["Coal", "Forest", "Cobble", "Fen", "Relic", "Mine", "Icicle", "Beacon"]
};

/**
 * Per-region Gym Leaders, Elite Four, Champion and Professor — the League roster.
 * Verified against Bulbapedia. Each leader has a type specialty, badge, gym city,
 * and a representative team (real species names). `leagues.mjs` builds their teams
 * as combatants and awards the region's badge on a win.
 */
PM.gymLeaders = {
  kanto: {
    professor: "Professor Oak", champion: "Blue",
    leaders: [
      { name: "Brock", city: "Pewter City", type: "Rock", badge: "Boulder", team: ["Geodude", "Onix"] },
      { name: "Misty", city: "Cerulean City", type: "Water", badge: "Cascade", team: ["Staryu", "Starmie"] },
      { name: "Lt. Surge", city: "Vermilion City", type: "Electric", badge: "Thunder", team: ["Voltorb", "Pikachu", "Raichu"] },
      { name: "Erika", city: "Celadon City", type: "Grass", badge: "Rainbow", team: ["Victreebel", "Tangela", "Vileplume"] },
      { name: "Koga", city: "Fuchsia City", type: "Poison", badge: "Soul", team: ["Koffing", "Muk", "Weezing"] },
      { name: "Sabrina", city: "Saffron City", type: "Psychic", badge: "Marsh", team: ["Kadabra", "Mr. Mime", "Alakazam"] },
      { name: "Blaine", city: "Cinnabar Island", type: "Fire", badge: "Volcano", team: ["Growlithe", "Ponyta", "Rapidash", "Arcanine"] },
      { name: "Giovanni", city: "Viridian City", type: "Ground", badge: "Earth", team: ["Rhyhorn", "Dugtrio", "Nidoking", "Rhydon"] }
    ],
    eliteFour: [
      { name: "Lorelei", type: "Ice", team: ["Dewgong", "Cloyster", "Slowbro", "Jynx", "Lapras"] },
      { name: "Bruno", type: "Fighting", team: ["Onix", "Hitmonlee", "Hitmonchan", "Machamp"] },
      { name: "Agatha", type: "Ghost", team: ["Gengar", "Golbat", "Haunter", "Arbok"] },
      { name: "Lance", type: "Dragon", team: ["Gyarados", "Dragonair", "Aerodactyl", "Dragonite"] }
    ]
  },
  johto: {
    professor: "Professor Elm", champion: "Lance",
    leaders: [
      { name: "Falkner", city: "Violet City", type: "Flying", badge: "Zephyr", team: ["Pidgey", "Pidgeotto"] },
      { name: "Bugsy", city: "Azalea Town", type: "Bug", badge: "Hive", team: ["Metapod", "Kakuna", "Scyther"] },
      { name: "Whitney", city: "Goldenrod City", type: "Normal", badge: "Plain", team: ["Clefairy", "Miltank"] },
      { name: "Morty", city: "Ecruteak City", type: "Ghost", badge: "Fog", team: ["Gastly", "Haunter", "Gengar"] },
      { name: "Chuck", city: "Cianwood City", type: "Fighting", badge: "Storm", team: ["Primeape", "Poliwrath"] },
      { name: "Jasmine", city: "Olivine City", type: "Steel", badge: "Mineral", team: ["Magnemite", "Steelix"] },
      { name: "Pryce", city: "Mahogany Town", type: "Ice", badge: "Glacier", team: ["Seel", "Dewgong", "Piloswine"] },
      { name: "Clair", city: "Blackthorn City", type: "Dragon", badge: "Rising", team: ["Dragonair", "Gyarados", "Kingdra"] }
    ],
    eliteFour: [
      { name: "Will", type: "Psychic", team: ["Xatu", "Jynx", "Slowbro", "Exeggutor"] },
      { name: "Koga", type: "Poison", team: ["Ariados", "Venomoth", "Forretress", "Crobat"] },
      { name: "Bruno", type: "Fighting", team: ["Hitmontop", "Hitmonlee", "Hitmonchan", "Machamp"] },
      { name: "Karen", type: "Dark", team: ["Umbreon", "Murkrow", "Gengar", "Houndoom"] }
    ]
  },
  hoenn: {
    professor: "Professor Birch", champion: "Steven",
    leaders: [
      { name: "Roxanne", city: "Rustboro City", type: "Rock", badge: "Stone", team: ["Geodude", "Nosepass"] },
      { name: "Brawly", city: "Dewford Town", type: "Fighting", badge: "Knuckle", team: ["Machop", "Makuhita"] },
      { name: "Wattson", city: "Mauville City", type: "Electric", badge: "Dynamo", team: ["Magnemite", "Voltorb", "Magneton", "Manectric"] },
      { name: "Flannery", city: "Lavaridge Town", type: "Fire", badge: "Heat", team: ["Slugma", "Numel", "Torkoal", "Camerupt"] },
      { name: "Norman", city: "Petalburg City", type: "Normal", badge: "Balance", team: ["Slaking", "Vigoroth", "Spinda"] },
      { name: "Winona", city: "Fortree City", type: "Flying", badge: "Feather", team: ["Swellow", "Pelipper", "Skarmory", "Altaria"] },
      { name: "Tate & Liza", city: "Mossdeep City", type: "Psychic", badge: "Mind", team: ["Solrock", "Lunatone"] },
      { name: "Wallace", city: "Sootopolis City", type: "Water", badge: "Rain", team: ["Luvdisc", "Whiscash", "Sealeo", "Milotic"] }
    ],
    eliteFour: [
      { name: "Sidney", type: "Dark", team: ["Mightyena", "Shiftry", "Cacturne", "Absol"] },
      { name: "Phoebe", type: "Ghost", team: ["Dusclops", "Banette", "Sableye"] },
      { name: "Glacia", type: "Ice", team: ["Sealeo", "Glalie", "Walrein"] },
      { name: "Drake", type: "Dragon", team: ["Shelgon", "Altaria", "Flygon", "Salamence"] }
    ]
  },
  sinnoh: {
    professor: "Professor Rowan", champion: "Cynthia",
    leaders: [
      { name: "Roark", city: "Oreburgh City", type: "Rock", badge: "Coal", team: ["Geodude", "Onix", "Cranidos"] },
      { name: "Gardenia", city: "Eterna City", type: "Grass", badge: "Forest", team: ["Turtwig", "Cherrim", "Roserade"] },
      { name: "Maylene", city: "Veilstone City", type: "Fighting", badge: "Cobble", team: ["Meditite", "Machoke", "Lucario"] },
      { name: "Crasher Wake", city: "Pastoria City", type: "Water", badge: "Fen", team: ["Gyarados", "Quagsire", "Floatzel"] },
      { name: "Fantina", city: "Hearthome City", type: "Ghost", badge: "Relic", team: ["Duskull", "Haunter", "Mismagius"] },
      { name: "Byron", city: "Canalave City", type: "Steel", badge: "Mine", team: ["Bronzor", "Steelix", "Bastiodon"] },
      { name: "Candice", city: "Snowpoint City", type: "Ice", badge: "Icicle", team: ["Snover", "Sneasel", "Medicham", "Abomasnow"] },
      { name: "Volkner", city: "Sunyshore City", type: "Electric", badge: "Beacon", team: ["Raichu", "Luxray", "Electivire"] }
    ],
    eliteFour: [
      { name: "Aaron", type: "Bug", team: ["Dustox", "Beautifly", "Vespiquen", "Heracross", "Drapion"] },
      { name: "Bertha", type: "Ground", team: ["Whiscash", "Gliscor", "Hippowdon", "Rhyperior"] },
      { name: "Flint", type: "Fire", team: ["Rapidash", "Infernape", "Magmortar", "Flareon"] },
      { name: "Lucian", type: "Psychic", team: ["Mr. Mime", "Girafarig", "Alakazam", "Bronzong"] }
    ]
  },
  unova: {
    professor: "Professor Juniper", champion: "Alder",
    leaders: [
      { name: "Cilan, Chili & Cress", city: "Striaton City", type: "Grass", badge: "Trio", team: ["Pansage", "Pansear", "Panpour"] },
      { name: "Lenora", city: "Nacrene City", type: "Normal", badge: "Basic", team: ["Herdier", "Watchog"] },
      { name: "Burgh", city: "Castelia City", type: "Bug", badge: "Insect", team: ["Whirlipede", "Dwebble", "Leavanny"] },
      { name: "Elesa", city: "Nimbasa City", type: "Electric", badge: "Bolt", team: ["Emolga", "Zebstrika"] },
      { name: "Clay", city: "Driftveil City", type: "Ground", badge: "Quake", team: ["Krokorok", "Palpitoad", "Excadrill"] },
      { name: "Skyla", city: "Mistralton City", type: "Flying", badge: "Jet", team: ["Swoobat", "Unfezant", "Swanna"] },
      { name: "Brycen", city: "Icirrus City", type: "Ice", badge: "Freeze", team: ["Vanillish", "Cryogonal", "Beartic"] },
      { name: "Drayden", city: "Opelucid City", type: "Dragon", badge: "Legend", team: ["Fraxure", "Druddigon", "Haxorus"] }
    ],
    eliteFour: [
      { name: "Shauntal", type: "Ghost", team: ["Cofagrigus", "Jellicent", "Golurk", "Chandelure"] },
      { name: "Grimsley", type: "Dark", team: ["Liepard", "Krookodile", "Scrafty", "Bisharp"] },
      { name: "Caitlin", type: "Psychic", team: ["Musharna", "Sigilyph", "Reuniclus", "Gothitelle"] },
      { name: "Marshal", type: "Fighting", team: ["Throh", "Sawk", "Conkeldurr", "Mienshao"] }
    ]
  },
  kalos: {
    professor: "Professor Sycamore", champion: "Diantha",
    leaders: [
      { name: "Viola", city: "Santalune City", type: "Bug", badge: "Bug", team: ["Surskit", "Vivillon"] },
      { name: "Grant", city: "Cyllage City", type: "Rock", badge: "Cliff", team: ["Amaura", "Tyrunt"] },
      { name: "Korrina", city: "Shalour City", type: "Fighting", badge: "Rumble", team: ["Mienfoo", "Machoke", "Hawlucha", "Lucario"] },
      { name: "Ramos", city: "Coumarine City", type: "Grass", badge: "Plant", team: ["Jumpluff", "Weepinbell", "Gogoat"] },
      { name: "Clemont", city: "Lumiose City", type: "Electric", badge: "Voltage", team: ["Emolga", "Magneton", "Heliolisk"] },
      { name: "Valerie", city: "Laverre City", type: "Fairy", badge: "Fairy", team: ["Mawile", "Mr. Mime", "Sylveon"] },
      { name: "Olympia", city: "Anistar City", type: "Psychic", badge: "Psychic", team: ["Sigilyph", "Slowking", "Meowstic"] },
      { name: "Wulfric", city: "Snowbelle City", type: "Ice", badge: "Iceberg", team: ["Abomasnow", "Cryogonal", "Avalugg"] }
    ],
    eliteFour: [
      { name: "Malva", type: "Fire", team: ["Pyroar", "Torkoal", "Chandelure", "Talonflame"] },
      { name: "Siebold", type: "Water", team: ["Clawitzer", "Gyarados", "Starmie", "Barbaracle"] },
      { name: "Wikstrom", type: "Steel", team: ["Klefki", "Probopass", "Scizor", "Aegislash"] },
      { name: "Drasna", type: "Dragon", team: ["Dragalge", "Druddigon", "Altaria", "Noivern"] }
    ]
  },
  alola: {
    professor: "Professor Kukui", champion: "Professor Kukui",
    leaders: [
      { name: "Ilima", city: "Hau'oli City", type: "Normal", badge: "Normalium", team: ["Yungoos", "Gumshoos", "Smeargle"] },
      { name: "Hala", city: "Iki Town", type: "Fighting", badge: "Melemele", team: ["Makuhita", "Crabrawler", "Poliwrath"] },
      { name: "Lana", city: "Brooklet Hill", type: "Water", badge: "Waterium", team: ["Wishiwashi", "Araquanid"] },
      { name: "Kiawe", city: "Wela Volcano Park", type: "Fire", badge: "Firium", team: ["Marowak", "Salazzle", "Turtonator"] },
      { name: "Mallow", city: "Lush Jungle", type: "Grass", badge: "Grassium", team: ["Steenee", "Lurantis", "Tsareena"] },
      { name: "Olivia", city: "Konikoni City", type: "Rock", badge: "Akala", team: ["Lycanroc", "Probopass", "Relicanth", "Carbink"] },
      { name: "Sophocles", city: "Hokulani Observatory", type: "Electric", badge: "Electrium", team: ["Charjabug", "Vikavolt", "Togedemaru"] },
      { name: "Acerola", city: "Thrifty Megamart", type: "Ghost", badge: "Ghostium", team: ["Sableye", "Mimikyu", "Palossand"] },
      { name: "Nanu", city: "Malie City", type: "Dark", badge: "Ula'ula", team: ["Sableye", "Krokorok", "Persian"] },
      { name: "Mina", city: "Seafolk Village", type: "Fairy", badge: "Fairium", team: ["Ribombee", "Klefki", "Wigglytuff"] },
      { name: "Hapu", city: "Poni Island", type: "Ground", badge: "Poni", team: ["Mudsdale", "Flygon", "Golurk", "Gastrodon"] }
    ],
    eliteFour: [
      { name: "Hala", type: "Fighting", team: ["Hariyama", "Primeape", "Bewear", "Poliwrath", "Crabominable"] },
      { name: "Olivia", type: "Rock", team: ["Relicanth", "Carbink", "Golem", "Probopass", "Lycanroc"] },
      { name: "Acerola", type: "Ghost", team: ["Sableye", "Drifblim", "Dhelmise", "Froslass", "Palossand"] },
      { name: "Kahili", type: "Flying", team: ["Skarmory", "Crobat", "Oricorio", "Mandibuzz", "Toucannon"] }
    ]
  },
  galar: {
    professor: "Professor Magnolia", champion: "Leon",
    leaders: [
      { name: "Milo", city: "Turffield", type: "Grass", badge: "Grass", team: ["Gossifleur", "Eldegoss"] },
      { name: "Nessa", city: "Hulbury", type: "Water", badge: "Water", team: ["Goldeen", "Arrokuda", "Drednaw"] },
      { name: "Kabu", city: "Motostoke", type: "Fire", badge: "Fire", team: ["Ninetales", "Arcanine", "Centiskorch"] },
      { name: "Bea", city: "Stow-on-Side", type: "Fighting", badge: "Fighting", team: ["Hitmontop", "Pangoro", "Sirfetch'd", "Machamp"] },
      { name: "Opal", city: "Ballonlea", type: "Fairy", badge: "Fairy", team: ["Weezing", "Mawile", "Togekiss", "Alcremie"] },
      { name: "Gordie", city: "Circhester", type: "Rock", badge: "Rock", team: ["Barbaracle", "Shuckle", "Stonjourner", "Coalossal"] },
      { name: "Piers", city: "Spikemuth", type: "Dark", badge: "Dark", team: ["Scrafty", "Malamar", "Skuntank", "Obstagoon"] },
      { name: "Raihan", city: "Hammerlocke", type: "Dragon", badge: "Dragon", team: ["Gigalith", "Flygon", "Sandaconda", "Duraludon"] }
    ],
    eliteFour: []
  },
  paldea: {
    professor: "Professor Sada / Turo", champion: "Geeta",
    leaders: [
      { name: "Katy", city: "Cortondo", type: "Bug", badge: "Bug", team: ["Nymble", "Tarountula", "Teddiursa"] },
      { name: "Brassius", city: "Artazon", type: "Grass", badge: "Grass", team: ["Petilil", "Smoliv", "Sudowoodo"] },
      { name: "Iono", city: "Levincia", type: "Electric", badge: "Electric", team: ["Wattrel", "Bellibolt", "Mismagius"] },
      { name: "Kofu", city: "Cascarrafa", type: "Water", badge: "Water", team: ["Veluza", "Wugtrio", "Crabominable"] },
      { name: "Larry", city: "Medali", type: "Normal", badge: "Normal", team: ["Komala", "Staraptor", "Dudunsparce"] },
      { name: "Ryme", city: "Montenevera", type: "Ghost", badge: "Ghost", team: ["Banette", "Mimikyu", "Houndstone", "Toxtricity"] },
      { name: "Tulip", city: "Alfornada", type: "Psychic", badge: "Psychic", team: ["Farigiraf", "Gardevoir", "Espathra", "Florges"] },
      { name: "Grusha", city: "Glaseado Mountain", type: "Ice", badge: "Ice", team: ["Frosmoth", "Beartic", "Cetitan", "Altaria"] }
    ],
    eliteFour: [
      { name: "Rika", type: "Ground", team: ["Dugtrio", "Donphan", "Clodsire", "Whiscash"] },
      { name: "Poppy", type: "Steel", team: ["Copperajah", "Bronzong", "Magnezone", "Tinkaton"] },
      { name: "Larry", type: "Flying", team: ["Tropius", "Staraptor", "Altaria", "Flamigo"] },
      { name: "Hassel", type: "Dragon", team: ["Noivern", "Dragalge", "Haxorus", "Baxcalibur"] }
    ]
  }
};

/** Base level cap and how much each badge raises it (obedience-style soft cap). */
PM.levelCapBase = 15;
PM.levelCapPerBadge = 10;

/**
 * HM / field moves that double as traversal gates (a party member must know it).
 * Restricted to moves that actually exist in the Gen-9 learnsets we compile —
 * Cut/Rock Smash/Strength/Flash/Whirlpool/Defog were dropped from Gen 9, so
 * gating on them would be impassable. (Re-add them if HM learnsets are injected.)
 */
PM.fieldMoves = {
  cut: "Cut",
  surf: "Surf",
  strength: "Strength",
  rocksmash: "Rock Smash",
  flash: "Flash",
  fly: "Fly",
  waterfall: "Waterfall",
  whirlpool: "Whirlpool",
  dive: "Dive"
};

/** How each field move reads when it clears its obstacle. */
PM.fieldMoveFlavor = {
  cut: "cut down the small tree",
  surf: "surfed across the water",
  strength: "pushed the boulder aside",
  rocksmash: "smashed the cracked rock",
  flash: "lit up the dark cavern",
  fly: "flew over the gap",
  waterfall: "climbed the waterfall",
  whirlpool: "cleared the raging whirlpool",
  dive: "dove beneath the surface"
};

/**
 * Canon badge each HM needs to be used in the field (Kanto/Johto). A Field Gate
 * only enforces this when its `requireBadge` option is on; empty = no badge.
 */
PM.hmBadges = {
  cut: "Cascade Badge",
  fly: "Thunder Badge",
  surf: "Soul Badge",
  strength: "Rainbow Badge",
  flash: "Boulder Badge",
  rocksmash: "",
  waterfall: "Rising Badge",
  whirlpool: "Glacier Badge",
  dive: ""
};

/**
 * Default habitats a type suggests, used to seed each Pokémon's encounter
 * requirements at build time. A Pokémon is only eligible to appear on a tile
 * whose habitat is among its allowed habitats (empty = any habitat).
 */
PM.typeHabitats = {
  Bug: ["forest", "grass"],
  Grass: ["grass", "forest"],
  Poison: ["forest", "cave", "urban"],
  Water: ["water", "fishing"],
  Ice: ["cave", "mountain"],
  Rock: ["cave", "mountain"],
  Ground: ["cave", "mountain", "sand"],
  Steel: ["cave", "mountain"],
  Fighting: ["cave", "mountain", "urban"],
  Fire: ["mountain", "cave"],
  Electric: ["urban", "grass"],
  Flying: ["grass", "mountain", "forest"],
  Normal: ["grass", "urban"],
  Fairy: ["forest", "grass"],
  Psychic: ["urban", "night"],
  Ghost: ["night", "cave"],
  Dark: ["night", "cave"],
  Dragon: ["mountain", "cave"]
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
