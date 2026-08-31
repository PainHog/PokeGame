/**
 * Build the Pokémon Masters compendium packs from the offline @pkmn dataset.
 *
 *   node scripts/build-packs.mjs            # full Pokédex (all species/moves/…)
 *   node scripts/build-packs.mjs --limit=60 # quick subset for fast iteration
 *
 * Pipeline:
 *   1. Read species / moves / abilities / items from @pkmn/data (Gen 9).
 *   2. Emit one Foundry document JSON per entry under src/packs/<pack>/.
 *   3. Compile each source dir into a LevelDB pack under packs/<pack>/ with the
 *      official @foundryvtt/foundryvtt-cli.
 *
 * The output is a build artifact (git-ignored). Re-running is idempotent: IDs
 * are derived deterministically from names, so a rebuild keeps stable UUIDs.
 */

import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Dex } from "@pkmn/dex";
import { compilePack } from "@foundryvtt/foundryvtt-cli";
import { PM } from "../src/module/config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// City → gym info, from the (Bulbapedia-verified) region rosters. Used to drop a
// Gym building + its leader into the right town.
const GYM_BY_CITY = new Map();
for (const [region, data] of Object.entries(PM.gymLeaders ?? {})) {
  (data.leaders ?? []).forEach((l, i) => {
    if (l.city) GYM_BY_CITY.set(l.city, { leader: l.name, region, gymIndex: i, type: l.type, badge: l.badge });
  });
}

// Locally-bundled sprites (assets/sprites/<num>.<ext>), if they've been fetched
// with `npm run sprites`. Keyed by National Dex number. Loaded synchronously so
// the build stays offline-friendly.
let SPRITE_INDEX = {};
try { SPRITE_INDEX = JSON.parse(fsSync.readFileSync(path.join(ROOT, "assets", "sprites", "index.json"), "utf8")); } catch { /* not fetched yet */ }

// Locally-bundled FORM sprites (assets/sprites/forms/<species.id>.<ext>), fetched
// with `npm run forms`. Keyed by @pkmn species id (e.g. "raichualola"), so an
// alternate form can override the base-number sprite it would otherwise share.
let FORM_SPRITE_INDEX = {};
try { FORM_SPRITE_INDEX = JSON.parse(fsSync.readFileSync(path.join(ROOT, "assets", "sprites", "forms", "index.json"), "utf8")); } catch { /* not fetched yet */ }

/**
 * Sprite path for a species: always a LOCAL path — a bundled file when we have
 * one, else a bundled Foundry-core placeholder. The system is self-contained, so
 * we never emit an external URL (a missing dex number fails closed to the
 * placeholder + a build warning, rather than silently hot-linking Showdown).
 *
 * A form species (its `id` in the forms index) prefers its own form-specific
 * sprite; everything else uses the base National-Dex-number sprite exactly as
 * before.
 */
function spriteFor(s) {
  const formFile = FORM_SPRITE_INDEX[s.id];
  if (formFile) return `systems/pokemon-masters/assets/sprites/forms/${formFile}`;
  const file = SPRITE_INDEX[s.num];
  if (file) return `systems/pokemon-masters/assets/sprites/${file}`;
  console.warn(`Pokémon Masters | no bundled sprite for #${s.num} (${s.name}) — using placeholder. Run \`npm run sprites\`.`);
  return "icons/svg/mystery-man.svg";
}
const SRC = path.join(ROOT, "src", "packs");
const OUT = path.join(ROOT, "packs");

const LIMIT = (() => {
  const arg = process.argv.find((a) => a.startsWith("--limit="));
  return arg ? parseInt(arg.split("=")[1], 10) : Infinity;
})();

/**
 * Include every *real* Pokémon/move/ability/item: fully-standard current-gen
 * entries, "Past" entries (National Dex mons not native to the current game),
 * and LGPE. Exclude fan-made CAP, Custom, and unreleased "Future" entries.
 */
const okNs = (e) => !e.isNonstandard || e.isNonstandard === "Past" || e.isNonstandard === "LGPE";

/** Map a Pokémon Showdown status code to our status keys. */
const mapStatus = (s) => ({ brn: "burn", par: "paralysis", slp: "sleep", frz: "freeze", psn: "poison", tox: "toxic" }[s] || "");

/** Mega / Primal formes grouped by their base species (for Mega Evolution). */
const MEGA_BY_BASE = {};
for (const sp of Dex.species.all()) {
  if (!/^(Mega|Primal)/.test(sp.forme || "")) continue;
  (MEGA_BY_BASE[sp.baseSpecies] ??= []).push({
    name: sp.name, item: sp.requiredItem || "",
    stats: { ...sp.baseStats }, types: [...sp.types], ability: Object.values(sp.abilities || {})[0] || ""
  });
}

/* -------------------------------------------- */
/*  Helpers                                      */
/* -------------------------------------------- */

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Deterministic 16-char Foundry _id from a namespace + key (stable across rebuilds). */
function stableId(namespace, key) {
  let h = 0xcbf29ce484222325n;
  const str = `${namespace}:${key}`;
  for (const ch of str) {
    h = (h ^ BigInt(ch.charCodeAt(0))) * 0x100000001b3n & 0xffffffffffffffffn;
  }
  let n = h;
  let id = "";
  while (id.length < 16) {
    id += ID_ALPHABET[Number(n % 62n)];
    n = n / 62n;
    if (n === 0n) n = h + BigInt(id.length + 1);
  }
  return id.slice(0, 16);
}

/** Tags that mark a truly unique Pokémon (only one may exist in the world). */
const UNIQUE_TAGS = ["Mythical", "Restricted Legendary", "Sub-Legendary"];

/**
 * Rarity from the dataset's legendary tags first, then base-stat total. This
 * keeps pseudo-legendaries (Dragonite, Garchomp — high BST, no tag) out of the
 * "legendary" tier, so only tagged legendaries get the harshest catch/uniqueness.
 */
function rarityFor(s, bst) {
  const tags = s.tags || [];
  if (tags.some((t) => UNIQUE_TAGS.includes(t))) return "legendary";
  if (bst >= 525) return "veryrare"; // pseudo-legendaries, Ultra Beasts, Paradox
  if (bst >= 450) return "rare";
  if (bst >= 330) return "uncommon";
  return "common";
}

const CATCH_RATE = { common: 190, uncommon: 120, rare: 60, veryrare: 30, legendary: 3 };

const GEN_TO_REGION = {
  1: "kanto", 2: "johto", 3: "hoenn", 4: "sinnoh", 5: "unova",
  6: "kalos", 7: "alola", 8: "galar", 9: "paldea"
};

/** Regional-variant region derived from a forme suffix (Alola/Galar/Hisui/Paldea). */
function variantRegion(forme) {
  if (!forme) return "";
  for (const r of ["Alola", "Galar", "Hisui", "Paldea"]) {
    if (forme.includes(r)) return r.toLowerCase();
  }
  return "";
}

/** The base (lowest-stage) species of an evolution line — what an egg hatches into. */
function eggSpeciesOf(s) {
  let cur = s;
  let guard = 0;
  while (cur.prevo && guard++ < 12) {
    const prev = Dex.species.get(cur.prevo);
    if (!prev) break;
    cur = prev;
  }
  return cur.name;
}

/** Genderless species (can only breed with Ditto). */
function isGenderless(s) {
  const gr = s.genderRatio;
  return !!gr && gr.M === 0 && gr.F === 0;
}

/** Habitats a type suggests (kept in sync with PM.typeHabitats in config.mjs). */
const TYPE_HABITATS = {
  Bug: ["forest", "grass"], Grass: ["grass", "forest"], Poison: ["forest", "cave", "urban"],
  Water: ["water", "fishing"], Ice: ["cave", "mountain"], Rock: ["cave", "mountain"],
  Ground: ["cave", "mountain", "sand"], Steel: ["cave", "mountain"], Fighting: ["cave", "mountain", "urban"],
  Fire: ["mountain", "cave"], Electric: ["urban", "grass"], Flying: ["grass", "mountain", "forest"],
  Normal: ["grass", "urban"], Fairy: ["forest", "grass"], Psychic: ["urban", "night"],
  Ghost: ["night", "cave"], Dark: ["night", "cave"], Dragon: ["mountain", "cave"]
};

/**
 * Per-species encounter requirements. A species can only roll on a tile whose
 * context satisfies EVERY non-empty axis, so region-specific Pokémon stay in
 * their own regions:
 *  - habitats: the union of its types' habitats (bugs → forest, etc.).
 *  - regions:  a regional form is locked to its form's region; otherwise the
 *              species appears in its native (introduction-generation) region.
 *              Kanto and Johto are the one exception — a single connected
 *              landmass that canonically shares its wild Pokémon — so a native
 *              of either also appears in the other.
 *  - methods:  water-types are surf/fishing; everyone else walks.
 */
const SHARED_DEX = { kanto: ["kanto", "johto"], johto: ["johto", "kanto"] };
// Hisui (ancient Sinnoh) is home to Hisuian forms plus a broad range of early
// Pokémon, so Gen 1–4 species also appear there.
const ANCIENT_REGIONS = new Set(["kanto", "johto", "hoenn", "sinnoh"]);
function deriveRequirements(s, rarity, nativeReg, varReg) {
  const habitats = [...new Set((s.types || []).flatMap((t) => TYPE_HABITATS[t] || []))];
  const isWater = (s.types || []).includes("Water");
  const methods = isWater ? ["surf", "fishing"] : ["walk"];
  let regions = [];
  if (varReg) regions = [varReg]; // regional forms (Alolan/Galarian/Hisuian/Paldean) stay locked
  else if (nativeReg) {
    regions = SHARED_DEX[nativeReg] ?? [nativeReg];
    if (ANCIENT_REGIONS.has(nativeReg)) regions = [...new Set([...regions, "hisui"])];
  }
  return { habitats, regions, methods, times: [] };
}

/** Shop prices (buy). Anything unlisted is not sold in Marts (price 0). */
const ITEM_PRICES = {
  "poké ball": 200, "great ball": 600, "ultra ball": 800, "premier ball": 200, "heal ball": 300, "luxury ball": 3000,
  "net ball": 1000, "dusk ball": 1000, "quick ball": 1000, "timer ball": 1000, "nest ball": 1000, "dive ball": 1000, "repeat ball": 1000,
  "potion": 300, "super potion": 700, "hyper potion": 1500, "max potion": 2500, "full restore": 3000,
  "revive": 2000, "max revive": 4000, "fresh water": 200, "soda pop": 300, "lemonade": 350, "moomoo milk": 600,
  "antidote": 100, "paralyze heal": 200, "parlyz heal": 200, "awakening": 100, "burn heal": 250, "ice heal": 250, "full heal": 600,
  "escape rope": 1000, "repel": 400, "super repel": 700, "max repel": 900, "poké doll": 1000,
  "fire stone": 3000, "water stone": 3000, "thunder stone": 3000, "leaf stone": 3000, "moon stone": 3000,
  "sun stone": 3000, "shiny stone": 3000, "dusk stone": 3000, "dawn stone": 3000, "ice stone": 3000,
  "rare candy": 10000
};
const priceFor = (name, isBall) => ITEM_PRICES[name.toLowerCase()] ?? (isBall ? 1000 : 0);

const BALL_MODIFIERS = {
  "poke ball": 1, "great ball": 1.5, "ultra ball": 2, "master ball": 255,
  "net ball": 3.5, "dive ball": 3.5, "nest ball": 4, "repeat ball": 3.5,
  "timer ball": 4, "dusk ball": 3, "quick ball": 5, "heal ball": 1, "luxury ball": 1,
  "premier ball": 1
};

// Foundry's LevelDB packs are keyed "!<collection>!<id>"; compilePack SKIPS any
// source doc without a `_key`, so every doc must carry one or the pack is empty.
// Embedded documents (a Scene's Regions, and their RegionBehaviors) are packed
// as their own entries too, so they each need a nested key of the form
// "!<parent>.<embedded>!<parentId>.<embeddedId>".
const PACK_COLLECTION = { species: "actors", moves: "items", abilities: "items", gear: "items", scenes: "scenes" };

function assignSceneKeys(scene) {
  scene._key = `!scenes!${scene._id}`;
  for (const region of scene.regions ?? []) {
    region._key = `!scenes.regions!${scene._id}.${region._id}`;
    for (const beh of region.behaviors ?? []) {
      beh._key = `!scenes.regions.behaviors!${scene._id}.${region._id}.${beh._id}`;
    }
  }
}

async function writePack(name, docs) {
  const collection = PACK_COLLECTION[name] ?? "items";
  const dir = path.join(SRC, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  // Guard against duplicate ids clobbering each other's source file (and pack entry).
  const seen = new Set();
  for (const doc of docs) {
    if (seen.has(doc._id)) throw new Error(`duplicate _id '${doc._id}' in ${name} pack (${doc.name}) — ids must be unique`);
    seen.add(doc._id);
    if (collection === "scenes") assignSceneKeys(doc);
    else doc._key = `!${collection}!${doc._id}`;
    await fs.writeFile(path.join(dir, `${doc._id}.json`), JSON.stringify(doc, null, 2));
  }
  const dest = path.join(OUT, name);
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  await compilePack(dir, dest, { log: false });
  console.log(`  ${name.padEnd(10)} ${String(docs.length).padStart(5)} documents`);
}

/* -------------------------------------------- */
/*  Species  ->  pokemon Actors                  */
/* -------------------------------------------- */

async function buildSpecies() {
  const docs = [];
  let count = 0;
  for (const s of Dex.species.all()) {
    if (count >= LIMIT) break;
    if (s.num < 1 || !okNs(s)) continue; // real National Dex entries only
    count++;

    const bs = s.baseStats;
    const bst = bs.hp + bs.atk + bs.def + bs.spa + bs.spd + bs.spe;
    const rarity = rarityFor(s, bst);

    let learnset = [];
    try {
      const ls = await Dex.learnsets.get(s.id);
      if (ls?.learnset) {
        learnset = Object.keys(ls.learnset).map((moveId) => {
          const move = Dex.moves.get(moveId);
          // Earliest level-up entry, if any (format e.g. "9L14").
          const sources = ls.learnset[moveId] || [];
          let level = 0;
          for (const src of sources) {
            const m = /^\d+L(\d+)$/.exec(src);
            if (m) level = level ? Math.min(level, Number(m[1])) : Number(m[1]);
          }
          const name = move?.name ?? moveId.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
          return { move: name, level };
        });
      }
    } catch { /* some formes have no learnset */ }

    const sprite = spriteFor(s);
    docs.push({
      _id: stableId("species", s.id),
      name: s.name,
      type: "pokemon",
      img: sprite,
      system: {
        species: {
          name: s.name,
          num: s.num,
          baseSpecies: s.baseSpecies ?? s.name,
          forme: s.forme ?? ""
        },
        nativeRegion: GEN_TO_REGION[s.gen] ?? "",
        variantRegion: variantRegion(s.forme),
        requirements: deriveRequirements(s, rarity, GEN_TO_REGION[s.gen] ?? "", variantRegion(s.forme)),
        // Legendaries/mythicals are unique in the world; 0 = unlimited.
        populationCap: rarity === "legendary" ? 1 : 0,
        ultraBeast: (s.tags || []).includes("Ultra Beast"),
        megaData: MEGA_BY_BASE[s.name] ?? [],
        teraType: s.types?.[0] ?? "Normal",
        eggGroups: s.eggGroups ?? [],
        eggSpecies: eggSpeciesOf(s),
        genderless: isGenderless(s),
        femaleRate: s.genderRatio?.F ?? (isGenderless(s) ? 0 : 0.5),
        types: s.types,
        level: 5,
        rarity,
        catchRate: CATCH_RATE[rarity],
        // Regular abilities only; the Hidden Ability is kept separate so it
        // doesn't leak into ordinary wild encounters.
        abilities: [s.abilities?.["0"], s.abilities?.["1"]].filter(Boolean),
        hiddenAbility: s.abilities?.["H"] ?? "",
        ability: s.abilities?.["0"] ?? "",
        baseStats: { hp: bs.hp, atk: bs.atk, def: bs.def, spa: bs.spa, spd: bs.spd, spe: bs.spe },
        hp: { value: null, max: 0 },
        moves: [],
        learnset,
        evolution: {
          from: s.prevo ?? "",
          into: s.evos ?? [],
          method: s.evoType ?? "",
          level: s.evoLevel ?? null,
          item: s.evoItem ?? "",
          condition: s.evoCondition ?? ""
        },
        trainer: null
      },
      prototypeToken: {
        name: s.name,
        actorLink: false,
        disposition: -1,
        texture: { src: sprite },
        bar1: { attribute: "hp" }
      }
    });
  }
  return docs;
}

/* -------------------------------------------- */
/*  Moves / Abilities / Gear  ->  Items          */
/* -------------------------------------------- */

function buildMoves() {
  const docs = [];
  let count = 0;
  for (const m of Dex.moves.all()) {
    if (count >= LIMIT) break;
    if (!m.exists || !okNs(m)) continue;
    count++;
    docs.push({
      // Key by name: some variants (all 17 Hidden Powers) share the source id.
      _id: stableId("move", m.name),
      name: m.name,
      type: "move",
      img: "icons/svg/sword.svg",
      system: {
        moveType: m.type,
        category: m.category,
        power: typeof m.basePower === "number" ? m.basePower : 0,
        accuracy: m.accuracy === true ? 100 : (m.accuracy || 0),
        alwaysHits: m.accuracy === true,
        pp: m.pp ?? 0,
        priority: m.priority ?? 0,
        target: m.target ?? "normal",
        // Status this move inflicts: a Status move's primary, or a damaging
        // move's secondary chance to inflict one.
        inflictStatus: mapStatus(m.status),
        secondaryStatus: mapStatus(m.secondary?.status),
        secondaryChance: (m.secondary?.status || m.secondary?.boosts) ? (m.secondary?.chance ?? 0) : 0,
        // Stat-stage changes: primary (Status moves) and secondary (on-hit chance).
        boosts: m.boosts ?? (m.self?.boosts ?? null),
        boostTarget: m.boosts ? (m.target === "self" ? "self" : "target") : (m.self?.boosts ? "self" : "target"),
        secondaryBoosts: m.secondary?.boosts ?? null,
        // Damage extras.
        drain: Array.isArray(m.drain) ? m.drain[0] / m.drain[1] : 0,
        recoil: Array.isArray(m.recoil) ? m.recoil[0] / m.recoil[1] : 0,
        flinchChance: m.secondary?.volatileStatus === "flinch" ? (m.secondary?.chance ?? 0) : 0,
        multihit: Array.isArray(m.multihit) ? m.multihit : (typeof m.multihit === "number" ? [m.multihit, m.multihit] : null),
        contact: !!m.flags?.contact,
        // Field effects: hazards/screens (sideCondition), weather, and confusion.
        sideCondition: m.sideCondition ?? "",
        weather: (m.weather ?? "").toString().toLowerCase().replace(/\s+/g, ""),
        terrain: (m.terrain ?? "").toString().toLowerCase().replace(/\s+/g, ""),
        confuseChance: m.volatileStatus === "confusion" ? 100 : (m.secondary?.volatileStatus === "confusion" ? (m.secondary?.chance ?? 0) : 0),
        healSelf: Array.isArray(m.heal) ? m.heal[0] / m.heal[1] : 0,
        description: m.shortDesc || m.desc || ""
      }
    });
  }
  return docs;
}

function buildAbilities() {
  const docs = [];
  let count = 0;
  for (const a of Dex.abilities.all()) {
    if (count >= LIMIT) break;
    if (!a.exists || !okNs(a) || a.id === "noability") continue;
    count++;
    docs.push({
      _id: stableId("ability", a.id),
      name: a.name,
      type: "ability",
      img: "icons/svg/aura.svg",
      system: {
        isNonstandard: !!a.isNonstandard,
        description: a.shortDesc || a.desc || ""
      }
    });
  }
  return docs;
}

function buildGear() {
  const docs = [];
  let count = 0;
  for (const it of Dex.items.all()) {
    if (count >= LIMIT) break;
    if (!it.exists || !okNs(it)) continue;
    count++;
    const lower = it.name.toLowerCase();
    // Anything ending in " ball" is a Poké Ball except these held items.
    const NON_CATCH_BALLS = new Set(["iron ball", "smoke ball", "light ball"]);
    const isBall = lower.endsWith(" ball") && !NON_CATCH_BALLS.has(lower);
    const category = isBall ? "ball"
      : it.isBerry ? "berry"
      : it.name.startsWith("TM") || it.name.startsWith("HM") ? "tm"
      : "item";
    docs.push({
      _id: stableId("gear", it.id),
      name: it.name,
      type: "gear",
      img: isBall ? "icons/svg/target.svg" : "icons/svg/item-bag.svg",
      system: {
        category,
        price: priceFor(it.name, isBall),
        quantity: 1,
        catchModifier: isBall ? (BALL_MODIFIERS[lower] ?? 1) : 1,
        description: it.desc || it.shortDesc || ""
      }
    });
  }
  // Standard shop/utility items the competitive dataset omits. [name, category, price, catchMod].
  const have = new Set(docs.map((d) => d.name.toLowerCase()));
  const CUSTOM = [
    ["Poké Ball", "ball", 200, 1], ["Great Ball", "ball", 600, 1.5], ["Ultra Ball", "ball", 800, 2],
    ["Potion", "medicine", 300, 1], ["Super Potion", "medicine", 700, 1], ["Hyper Potion", "medicine", 1500, 1], ["Max Potion", "medicine", 2500, 1], ["Full Restore", "medicine", 3000, 1],
    ["Revive", "medicine", 2000, 1], ["Max Revive", "medicine", 4000, 1],
    ["Antidote", "medicine", 100, 1], ["Paralyze Heal", "medicine", 200, 1], ["Awakening", "medicine", 100, 1], ["Burn Heal", "medicine", 250, 1], ["Ice Heal", "medicine", 250, 1], ["Full Heal", "medicine", 600, 1],
    ["Escape Rope", "item", 1000, 1], ["Repel", "item", 400, 1], ["Super Repel", "item", 700, 1], ["Max Repel", "item", 900, 1], ["Poké Doll", "item", 1000, 1],
    ["Fire Stone", "item", 3000, 1], ["Water Stone", "item", 3000, 1], ["Thunder Stone", "item", 3000, 1], ["Leaf Stone", "item", 3000, 1], ["Moon Stone", "item", 3000, 1],
    ["Sun Stone", "item", 3000, 1], ["Shiny Stone", "item", 3000, 1], ["Dusk Stone", "item", 3000, 1], ["Dawn Stone", "item", 3000, 1], ["Ice Stone", "item", 3000, 1],
    ["S.S. Ticket", "key", 0, 1], ["Bike Voucher", "key", 0, 1], ["Bicycle", "key", 0, 1], ["Old Rod", "key", 0, 1], ["Good Rod", "key", 0, 1], ["Super Rod", "key", 0, 1],
    // Battle-gimmick triggers (held): a Tera Orb terastallizes; a Z-Crystal powers one Z-Move.
    ["Tera Orb", "item", 0, 1], ["Z-Crystal", "item", 0, 1]
  ];
  for (const [name, category, price, catchMod] of CUSTOM) {
    if (have.has(name.toLowerCase())) continue;
    have.add(name.toLowerCase()); // dedupe within CUSTOM as well as against the dataset
    docs.push({ _id: stableId("gear", name), name, type: "gear", img: category === "ball" ? "icons/svg/target.svg" : "icons/svg/item-bag.svg", system: { category, price, quantity: 1, catchModifier: catchMod, description: "" } });
  }
  return docs;
}

/* -------------------------------------------- */
/*  Scenes  ->  a ready-to-play test map         */
/* -------------------------------------------- */

/**
 * The connected Pokémon world, region by region. Each city, route, dungeon and
 * island is its own Scene, wired exactly as in the games (grounded in
 * Bulbapedia). Data-driven: REGION_MAPS lists each region's places,
 * REGION_CONNECTIONS the edges within a region, and INTER_REGION the land
 * borders and ferries between regions (e.g. Kanto's Route 27 ↔ Johto's New Bark
 * Town via Tohjo Falls; the S.S. Anne docks at Vermilion).
 */
const REGION_MAPS = {
  kanto: {
  "Pallet Town": { kind: "town" }, "Viridian City": { kind: "town" }, "Pewter City": { kind: "town" },
  "Cerulean City": { kind: "town" }, "Saffron City": { kind: "town" }, "Celadon City": { kind: "town" },
  "Vermilion City": { kind: "town" }, "Lavender Town": { kind: "town" }, "Fuchsia City": { kind: "town" },
  "Cinnabar Island": { kind: "town", island: true }, "Indigo Plateau": { kind: "town" },
  "Viridian Forest": { kind: "forest", habitat: "forest" },
  "Mt. Moon": { kind: "cave", habitat: "cave" }, "Rock Tunnel": { kind: "cave", habitat: "cave" },
  "Seafoam Islands": { kind: "cave", habitat: "cave", island: true }, "Victory Road": { kind: "cave", habitat: "cave" },
  "Diglett's Cave": { kind: "cave", habitat: "cave" }, "S.S. Anne": { kind: "venue" },
  "Route 1": { kind: "route", habitat: "grass" }, "Route 3": { kind: "route", habitat: "mountain" },
  "Route 4": { kind: "route", habitat: "mountain" }, "Route 5": { kind: "route", habitat: "grass" },
  "Route 6": { kind: "route", habitat: "grass" }, "Route 7": { kind: "route", habitat: "urban" },
  "Route 8": { kind: "route", habitat: "urban" }, "Route 9": { kind: "route", habitat: "grass" },
  "Route 10": { kind: "route", habitat: "mountain" }, "Route 11": { kind: "route", habitat: "grass" },
  "Route 12": { kind: "route", habitat: "water" }, "Route 13": { kind: "route", habitat: "grass" },
  "Route 14": { kind: "route", habitat: "grass" }, "Route 15": { kind: "route", habitat: "grass" },
  "Route 16": { kind: "route", habitat: "urban" }, "Route 17": { kind: "route", habitat: "grass" },
  "Route 18": { kind: "route", habitat: "grass" }, "Route 19": { kind: "ocean", habitat: "water" },
  "Route 20": { kind: "ocean", habitat: "water" }, "Route 21": { kind: "ocean", habitat: "water" },
  "Route 22": { kind: "route", habitat: "grass" }, "Route 23": { kind: "route", habitat: "mountain" },
  "Route 24": { kind: "route", habitat: "grass" }, "Route 25": { kind: "route", habitat: "grass" },
  // The Kanto–Johto border corridor (Routes 26–28, Tohjo Falls, Mt. Silver).
  "Route 26": { kind: "route", habitat: "grass" }, "Route 27": { kind: "route", habitat: "water" },
  "Tohjo Falls": { kind: "cave", habitat: "cave" }, "Route 28": { kind: "route", habitat: "mountain" },
  "Mt. Silver": { kind: "cave", habitat: "cave" },
  // The Sevii Islands — a Kanto archipelago, reachable only by the Seagallop ferries.
  "One Island": { kind: "town", island: true }, "Two Island": { kind: "town", island: true },
  "Three Island": { kind: "town", island: true }, "Four Island": { kind: "town", island: true },
  "Five Island": { kind: "town", island: true }, "Six Island": { kind: "town", island: true },
  "Seven Island": { kind: "town", island: true },
  "Treasure Beach": { kind: "ocean", habitat: "water" }, "Kindle Road": { kind: "route", habitat: "mountain" },
  "Mt. Ember": { kind: "cave", habitat: "mountain" }, "Cape Brink": { kind: "route", habitat: "grass" },
  "Bond Bridge": { kind: "route", habitat: "grass" }, "Berry Forest": { kind: "forest", habitat: "forest" },
  "Icefall Cave": { kind: "cave", habitat: "cave" }, "Five Isle Meadow": { kind: "route", habitat: "grass" },
  "Lost Cave": { kind: "cave", habitat: "cave" }, "Water Path": { kind: "ocean", habitat: "water" },
  "Pattern Bush": { kind: "forest", habitat: "forest" }, "Green Path": { kind: "route", habitat: "grass" },
  "Ruin Valley": { kind: "route", habitat: "grass" }, "Altering Cave": { kind: "cave", habitat: "cave" },
  "Sevault Canyon": { kind: "cave", habitat: "mountain" }, "Tanoby Ruins": { kind: "cave", habitat: "cave" },
  "Trainer Tower": { kind: "venue" }, "Navel Rock": { kind: "cave", habitat: "cave", island: true },
  "Birth Island": { kind: "ocean", habitat: "water", island: true }
  },
  johto: {
    "New Bark Town": { kind: "town" }, "Cherrygrove City": { kind: "town" },
    "Violet City": { kind: "town" }, "Azalea Town": { kind: "town" },
    "Goldenrod City": { kind: "town" }, "Ecruteak City": { kind: "town" },
    "Olivine City": { kind: "town" }, "Cianwood City": { kind: "town", island: true },
    "Mahogany Town": { kind: "town" }, "Blackthorn City": { kind: "town" },
    "Route 29": { kind: "route", habitat: "grass" }, "Route 30": { kind: "route", habitat: "grass" },
    "Route 31": { kind: "route", habitat: "grass" }, "Route 32": { kind: "route", habitat: "grass" },
    "Route 33": { kind: "route", habitat: "mountain" }, "Route 34": { kind: "route", habitat: "grass" },
    "Route 35": { kind: "route", habitat: "grass" }, "Route 36": { kind: "route", habitat: "grass" },
    "Route 37": { kind: "route", habitat: "grass" }, "Route 38": { kind: "route", habitat: "grass" },
    "Route 39": { kind: "route", habitat: "grass" }, "Route 40": { kind: "ocean", habitat: "water" },
    "Route 41": { kind: "ocean", habitat: "water" }, "Route 42": { kind: "route", habitat: "mountain" },
    "Route 43": { kind: "route", habitat: "grass" }, "Route 44": { kind: "route", habitat: "grass" },
    "Route 45": { kind: "route", habitat: "mountain" }, "Route 46": { kind: "route", habitat: "mountain" },
    "Route 47": { kind: "ocean", habitat: "water" }, "Route 48": { kind: "route", habitat: "grass" },
    "Sprout Tower": { kind: "venue", habitat: "night" }, "Ruins of Alph": { kind: "cave", habitat: "cave" },
    "Union Cave": { kind: "cave", habitat: "cave" }, "Slowpoke Well": { kind: "cave", habitat: "cave" },
    "Ilex Forest": { kind: "forest", habitat: "forest" }, "National Park": { kind: "route", habitat: "grass" },
    "Burned Tower": { kind: "venue", habitat: "night" }, "Bell Tower": { kind: "venue", habitat: "night" }, "Olivine Lighthouse": { kind: "venue" },
    "Whirl Islands": { kind: "cave", habitat: "cave", island: true }, "Mt. Mortar": { kind: "cave", habitat: "cave" },
    "Lake of Rage": { kind: "ocean", habitat: "water" }, "Ice Path": { kind: "cave", habitat: "cave" },
    "Dragon's Den": { kind: "cave", habitat: "cave" }, "Dark Cave": { kind: "cave", habitat: "cave" },
    "Safari Zone Gate": { kind: "venue" }
  },
  alola: {
    // Melemele Island (northwest).
    "Iki Town": { kind: "town", island: true }, "Hau'oli City": { kind: "town", island: true },
    "Route 1": { kind: "route", habitat: "grass" }, "Route 2": { kind: "route", habitat: "grass" },
    "Route 3": { kind: "route", habitat: "mountain" }, "Trainers' School": { kind: "venue" },
    "Mahalo Trail": { kind: "route", habitat: "grass" }, "Ruins of Conflict": { kind: "cave", habitat: "cave" },
    "Verdant Cavern": { kind: "cave", habitat: "cave" }, "Melemele Meadow": { kind: "forest", habitat: "forest" },
    "Seaward Cave": { kind: "cave", habitat: "cave" }, "Ten Carat Hill": { kind: "cave", habitat: "cave" },
    "Kala'e Bay": { kind: "ocean", habitat: "water" },
    // Akala Island (northeast).
    "Heahea City": { kind: "town", island: true }, "Paniola Town": { kind: "town", island: true },
    "Konikoni City": { kind: "town", island: true }, "Royal Avenue": { kind: "town", island: true },
    "Route 4": { kind: "route", habitat: "grass" }, "Route 5": { kind: "route", habitat: "grass" },
    "Route 6": { kind: "route", habitat: "grass" }, "Route 7": { kind: "route", habitat: "mountain" },
    "Route 8": { kind: "route", habitat: "mountain" }, "Route 9": { kind: "route", habitat: "grass" },
    "Brooklet Hill": { kind: "ocean", habitat: "water" }, "Lush Jungle": { kind: "forest", habitat: "forest" },
    "Wela Volcano Park": { kind: "cave", habitat: "mountain" }, "Diglett's Tunnel": { kind: "cave", habitat: "cave" },
    "Battle Royal Dome": { kind: "venue" }, "Memorial Hill": { kind: "cave", habitat: "cave" },
    "Hano Grand Resort": { kind: "venue" },
    // Ula'ula Island (southeast, largest).
    "Malie City": { kind: "town", island: true }, "Tapu Village": { kind: "town", island: true },
    "Po Town": { kind: "town", island: true }, "Route 10": { kind: "route", habitat: "mountain" },
    "Route 11": { kind: "route", habitat: "grass" }, "Route 12": { kind: "route", habitat: "grass" },
    "Route 13": { kind: "route", habitat: "sand" }, "Route 14": { kind: "route", habitat: "grass" },
    "Route 15": { kind: "route", habitat: "water" }, "Route 16": { kind: "route", habitat: "grass" },
    "Route 17": { kind: "route", habitat: "mountain" }, "Mount Hokulani": { kind: "cave", habitat: "mountain" },
    "Hokulani Observatory": { kind: "venue" }, "Blush Mountain": { kind: "cave", habitat: "mountain" },
    "Haina Desert": { kind: "route", habitat: "sand" }, "Ula'ula Meadow": { kind: "forest", habitat: "forest" },
    "Lake of the Sunne": { kind: "ocean", habitat: "water" }, "Lake of the Moone": { kind: "ocean", habitat: "water" },
    "Thrifty Megamart": { kind: "venue" }, "Aether House": { kind: "venue" },
    "Mount Lanakila": { kind: "cave", habitat: "cave" }, "Alola Pokémon League": { kind: "town" },
    // Poni Island (southwest).
    "Seafolk Village": { kind: "town", island: true }, "Ancient Poni Path": { kind: "town", island: true },
    "Poni Wilds": { kind: "route", habitat: "grass" }, "Vast Poni Canyon": { kind: "cave", habitat: "mountain" },
    "Altar of the Sunne": { kind: "venue" }, "Poni Plains": { kind: "route", habitat: "grass" },
    "Poni Meadow": { kind: "forest", habitat: "forest" }, "Battle Tree": { kind: "venue" },
    "Resolution Cave": { kind: "cave", habitat: "cave" }, "Exeggutor Island": { kind: "forest", habitat: "forest", island: true },
    // Aether Paradise (artificial island, center).
    "Aether Paradise": { kind: "venue", island: true }
  },
  hoenn: {
    "Littleroot Town": { kind: "town" }, "Oldale Town": { kind: "town" },
    "Petalburg City": { kind: "town" }, "Rustboro City": { kind: "town" },
    "Dewford Town": { kind: "town", island: true }, "Slateport City": { kind: "town" },
    "Mauville City": { kind: "town" }, "Verdanturf Town": { kind: "town" },
    "Fallarbor Town": { kind: "town" }, "Lavaridge Town": { kind: "town" },
    "Fortree City": { kind: "town" }, "Lilycove City": { kind: "town" },
    "Mossdeep City": { kind: "town", island: true }, "Sootopolis City": { kind: "town", island: true },
    "Pacifidlog Town": { kind: "town", island: true }, "Ever Grande City": { kind: "town", island: true },
    "Route 101": { kind: "route", habitat: "grass" }, "Route 102": { kind: "route", habitat: "grass" },
    "Route 103": { kind: "route", habitat: "grass" }, "Route 104": { kind: "route", habitat: "grass" },
    "Route 105": { kind: "ocean", habitat: "water" }, "Route 106": { kind: "ocean", habitat: "water" },
    "Route 107": { kind: "ocean", habitat: "water" }, "Route 108": { kind: "ocean", habitat: "water" },
    "Route 109": { kind: "ocean", habitat: "water" }, "Route 110": { kind: "route", habitat: "grass" },
    "Route 111": { kind: "route", habitat: "sand" }, "Route 112": { kind: "route", habitat: "mountain" },
    "Route 113": { kind: "route", habitat: "mountain" }, "Route 114": { kind: "route", habitat: "grass" },
    "Route 115": { kind: "ocean", habitat: "water" }, "Route 116": { kind: "route", habitat: "grass" },
    "Route 117": { kind: "route", habitat: "grass" }, "Route 118": { kind: "route", habitat: "water" },
    "Route 119": { kind: "route", habitat: "grass" }, "Route 120": { kind: "route", habitat: "grass" },
    "Route 121": { kind: "route", habitat: "grass" }, "Route 122": { kind: "ocean", habitat: "water" },
    "Route 123": { kind: "route", habitat: "grass" }, "Route 124": { kind: "ocean", habitat: "water" },
    "Route 125": { kind: "ocean", habitat: "water" }, "Route 126": { kind: "ocean", habitat: "water" },
    "Route 127": { kind: "ocean", habitat: "water" }, "Route 128": { kind: "ocean", habitat: "water" },
    "Route 129": { kind: "ocean", habitat: "water" }, "Route 130": { kind: "ocean", habitat: "water" },
    "Route 131": { kind: "ocean", habitat: "water" }, "Route 132": { kind: "ocean", habitat: "water" },
    "Route 133": { kind: "ocean", habitat: "water" }, "Route 134": { kind: "ocean", habitat: "water" },
    "Petalburg Woods": { kind: "forest", habitat: "forest" }, "Granite Cave": { kind: "cave", habitat: "cave" },
    "Rusturf Tunnel": { kind: "cave", habitat: "cave" }, "Fiery Path": { kind: "cave", habitat: "mountain" },
    "Jagged Pass": { kind: "cave", habitat: "mountain" }, "Mt. Chimney": { kind: "cave", habitat: "mountain" },
    "Meteor Falls": { kind: "cave", habitat: "cave" }, "Weather Institute": { kind: "venue" },
    "Hoenn Safari Zone": { kind: "venue", habitat: "grass" }, "Mt. Pyre": { kind: "cave", habitat: "cave" },
    "Shoal Cave": { kind: "cave", habitat: "cave" }, "Seafloor Cavern": { kind: "cave", habitat: "cave" },
    "Cave of Origin": { kind: "cave", habitat: "cave" }, "Sky Pillar": { kind: "cave", habitat: "cave" },
    "Battle Frontier": { kind: "venue", island: true },
    "Hoenn Victory Road": { kind: "cave", habitat: "cave" }, "Hoenn Pokémon League": { kind: "town" }
  },
  sinnoh: {
    "Twinleaf Town": { kind: "town" }, "Sandgem Town": { kind: "town" },
    "Jubilife City": { kind: "town" }, "Oreburgh City": { kind: "town" },
    "Floaroma Town": { kind: "town" }, "Eterna City": { kind: "town" },
    "Hearthome City": { kind: "town" }, "Solaceon Town": { kind: "town" },
    "Veilstone City": { kind: "town" }, "Pastoria City": { kind: "town" },
    "Celestic Town": { kind: "town" }, "Canalave City": { kind: "town" },
    "Snowpoint City": { kind: "town" }, "Sunyshore City": { kind: "town", island: true },
    "Fight Area": { kind: "town", island: true }, "Survival Area": { kind: "town", island: true },
    "Resort Area": { kind: "town", island: true },
    "Route 201": { kind: "route", habitat: "grass" }, "Route 202": { kind: "route", habitat: "grass" },
    "Route 203": { kind: "route", habitat: "grass" }, "Route 204": { kind: "route", habitat: "grass" },
    "Route 205": { kind: "route", habitat: "grass" }, "Route 206": { kind: "route", habitat: "grass" },
    "Route 207": { kind: "route", habitat: "mountain" }, "Route 208": { kind: "route", habitat: "grass" },
    "Route 209": { kind: "route", habitat: "grass" }, "Route 210": { kind: "route", habitat: "grass" },
    "Route 211": { kind: "route", habitat: "mountain" }, "Route 212": { kind: "route", habitat: "grass" },
    "Route 213": { kind: "route", habitat: "water" }, "Route 214": { kind: "route", habitat: "grass" },
    "Route 215": { kind: "route", habitat: "grass" }, "Route 216": { kind: "route", habitat: "mountain" },
    "Route 217": { kind: "route", habitat: "mountain" }, "Route 218": { kind: "ocean", habitat: "water" },
    "Route 219": { kind: "ocean", habitat: "water" }, "Route 220": { kind: "ocean", habitat: "water" },
    "Route 221": { kind: "route", habitat: "grass" }, "Route 222": { kind: "route", habitat: "water" },
    "Route 223": { kind: "ocean", habitat: "water" }, "Route 224": { kind: "ocean", habitat: "water" },
    "Route 225": { kind: "route", habitat: "grass" }, "Route 226": { kind: "route", habitat: "mountain" },
    "Route 227": { kind: "route", habitat: "mountain" }, "Route 228": { kind: "route", habitat: "sand" },
    "Route 229": { kind: "route", habitat: "grass" }, "Route 230": { kind: "ocean", habitat: "water" },
    "Lake Verity": { kind: "ocean", habitat: "water" }, "Oreburgh Gate": { kind: "cave", habitat: "cave" },
    "Oreburgh Mine": { kind: "cave", habitat: "cave" }, "Ravaged Path": { kind: "cave", habitat: "cave" },
    "Valley Windworks": { kind: "venue" }, "Eterna Forest": { kind: "forest", habitat: "forest" },
    "Old Chateau": { kind: "venue", habitat: "night" }, "Wayward Cave": { kind: "cave", habitat: "cave" },
    "Mount Coronet": { kind: "cave", habitat: "mountain" }, "Spear Pillar": { kind: "cave", habitat: "mountain" },
    "Lost Tower": { kind: "venue", habitat: "night" }, "Solaceon Ruins": { kind: "cave", habitat: "cave" },
    "Great Marsh": { kind: "venue", habitat: "water" }, "Pokémon Mansion": { kind: "venue", habitat: "grass" },
    "Iron Island": { kind: "cave", habitat: "cave", island: true }, "Lake Valor": { kind: "ocean", habitat: "water" },
    "Lake Acuity": { kind: "ocean", habitat: "water" }, "Snowpoint Temple": { kind: "cave", habitat: "cave" },
    "Stark Mountain": { kind: "cave", habitat: "mountain" }, "Sinnoh Battle Tower": { kind: "venue", island: true },
    "Sinnoh Victory Road": { kind: "cave", habitat: "cave" }, "Sinnoh Pokémon League": { kind: "town" }
  },
  unova: {
    "Nuvema Town": { kind: "town" }, "Accumula Town": { kind: "town" },
    "Striaton City": { kind: "town" }, "Nacrene City": { kind: "town" },
    "Castelia City": { kind: "town" }, "Nimbasa City": { kind: "town" },
    "Driftveil City": { kind: "town" }, "Mistralton City": { kind: "town" },
    "Icirrus City": { kind: "town" }, "Opelucid City": { kind: "town" },
    "Lacunosa Town": { kind: "town" }, "Undella Town": { kind: "town" },
    "Aspertia City": { kind: "town" }, "Floccesy Town": { kind: "town" },
    "Virbank City": { kind: "town" }, "Humilau City": { kind: "town", island: true },
    "Black City": { kind: "town" }, "White Forest": { kind: "forest", habitat: "forest" },
    "Route 1": { kind: "route", habitat: "grass" }, "Route 2": { kind: "route", habitat: "grass" },
    "Route 3": { kind: "route", habitat: "grass" }, "Route 4": { kind: "route", habitat: "sand" },
    "Route 5": { kind: "route", habitat: "urban" }, "Route 6": { kind: "route", habitat: "grass" },
    "Route 7": { kind: "route", habitat: "grass" }, "Route 8": { kind: "route", habitat: "grass" },
    "Route 9": { kind: "route", habitat: "urban" }, "Route 10": { kind: "route", habitat: "mountain" },
    "Route 11": { kind: "route", habitat: "grass" }, "Route 12": { kind: "route", habitat: "grass" },
    "Route 13": { kind: "route", habitat: "grass" }, "Route 14": { kind: "route", habitat: "grass" },
    "Route 15": { kind: "route", habitat: "grass" }, "Route 16": { kind: "route", habitat: "grass" },
    "Route 17": { kind: "ocean", habitat: "water" }, "Route 18": { kind: "route", habitat: "water" },
    "Route 19": { kind: "route", habitat: "grass" }, "Route 20": { kind: "route", habitat: "grass" },
    "Route 21": { kind: "ocean", habitat: "water" }, "Route 22": { kind: "route", habitat: "grass" },
    "Route 23": { kind: "route", habitat: "grass" },
    "Wellspring Cave": { kind: "cave", habitat: "cave" }, "Pinwheel Forest": { kind: "forest", habitat: "forest" },
    "Skyarrow Bridge": { kind: "route", habitat: "urban" }, "Desert Resort": { kind: "route", habitat: "sand" },
    "Relic Castle": { kind: "cave", habitat: "sand" }, "Driftveil Drawbridge": { kind: "route", habitat: "water" },
    "Chargestone Cave": { kind: "cave", habitat: "cave" }, "Twist Mountain": { kind: "cave", habitat: "mountain" },
    "Moor of Icirrus": { kind: "route", habitat: "water" }, "Tubeline Bridge": { kind: "route", habitat: "urban" },
    "Challenger's Cave": { kind: "cave", habitat: "cave" }, "Village Bridge": { kind: "route", habitat: "urban" },
    "Giant Chasm": { kind: "cave", habitat: "cave" }, "Marvelous Bridge": { kind: "route", habitat: "urban" },
    "Lostlorn Forest": { kind: "forest", habitat: "forest" }, "Floccesy Ranch": { kind: "route", habitat: "grass" },
    "Seaside Cave": { kind: "cave", habitat: "cave" },
    "Unova Victory Road": { kind: "cave", habitat: "cave" }, "Unova Pokémon League": { kind: "town" }
  },
  kalos: {
    "Vaniville Town": { kind: "town" }, "Aquacorde Town": { kind: "town" },
    "Santalune City": { kind: "town" }, "Lumiose City": { kind: "town" },
    "Camphrier Town": { kind: "town" }, "Cyllage City": { kind: "town" },
    "Ambrette Town": { kind: "town" }, "Geosenge Town": { kind: "town" },
    "Shalour City": { kind: "town", island: true }, "Coumarine City": { kind: "town" },
    "Laverre City": { kind: "town" }, "Dendemille Town": { kind: "town" },
    "Anistar City": { kind: "town" }, "Couriway Town": { kind: "town" },
    "Snowbelle City": { kind: "town" }, "Kiloude City": { kind: "town" },
    "Route 1": { kind: "route", habitat: "grass" }, "Route 2": { kind: "route", habitat: "grass" },
    "Route 3": { kind: "route", habitat: "grass" }, "Route 4": { kind: "route", habitat: "urban" },
    "Route 5": { kind: "route", habitat: "grass" }, "Route 6": { kind: "route", habitat: "grass" },
    "Route 7": { kind: "route", habitat: "grass" }, "Route 8": { kind: "route", habitat: "water" },
    "Route 9": { kind: "route", habitat: "mountain" }, "Route 10": { kind: "route", habitat: "grass" },
    "Route 11": { kind: "route", habitat: "grass" }, "Route 12": { kind: "route", habitat: "water" },
    "Route 13": { kind: "route", habitat: "sand" }, "Route 14": { kind: "route", habitat: "grass" },
    "Route 15": { kind: "route", habitat: "grass" }, "Route 16": { kind: "route", habitat: "grass" },
    "Route 17": { kind: "route", habitat: "mountain" }, "Route 18": { kind: "route", habitat: "mountain" },
    "Route 19": { kind: "route", habitat: "grass" }, "Route 20": { kind: "forest", habitat: "forest" },
    "Route 21": { kind: "route", habitat: "grass" }, "Route 22": { kind: "route", habitat: "grass" },
    "Santalune Forest": { kind: "forest", habitat: "forest" }, "Parfum Palace": { kind: "venue" },
    "Connecting Cave": { kind: "cave", habitat: "cave" }, "Glittering Cave": { kind: "cave", habitat: "cave" },
    "Reflection Cave": { kind: "cave", habitat: "cave" }, "Tower of Mastery": { kind: "venue" },
    "Azure Bay": { kind: "ocean", habitat: "water" }, "Kalos Power Plant": { kind: "venue" },
    "Lost Hotel": { kind: "venue" }, "Frost Cavern": { kind: "cave", habitat: "mountain" },
    "Team Flare Secret HQ": { kind: "venue" }, "Terminus Cave": { kind: "cave", habitat: "cave" },
    "Pokémon Village": { kind: "forest", habitat: "forest" }, "Battle Maison": { kind: "venue", island: true },
    "Kalos Victory Road": { kind: "cave", habitat: "cave" }, "Kalos Pokémon League": { kind: "town" }
  },
  galar: {
    "Postwick": { kind: "town" }, "Wedgehurst": { kind: "town" },
    "Motostoke": { kind: "town" }, "Turffield": { kind: "town" },
    "Hulbury": { kind: "town" }, "Hammerlocke": { kind: "town" },
    "Stow-on-Side": { kind: "town" }, "Ballonlea": { kind: "town" },
    "Circhester": { kind: "town" }, "Spikemuth": { kind: "town" },
    "Wyndon": { kind: "town" }, "Galar Pokémon League": { kind: "town" },
    "Route 1": { kind: "route", habitat: "grass" }, "Route 2": { kind: "route", habitat: "grass" },
    "Route 3": { kind: "route", habitat: "grass" }, "Route 4": { kind: "route", habitat: "grass" },
    "Route 5": { kind: "route", habitat: "grass" }, "Route 6": { kind: "route", habitat: "sand" },
    "Route 7": { kind: "route", habitat: "grass" }, "Route 8": { kind: "route", habitat: "mountain" },
    "Route 9": { kind: "ocean", habitat: "water" }, "Route 10": { kind: "route", habitat: "mountain" },
    "Wild Area": { kind: "forest", habitat: "grass" }, "Slumbering Weald": { kind: "forest", habitat: "forest" },
    "Galar Mine": { kind: "cave", habitat: "cave" }, "Galar Mine No. 2": { kind: "cave", habitat: "cave" },
    "Motostoke Outskirts": { kind: "route", habitat: "grass" }, "Glimwood Tangle": { kind: "forest", habitat: "forest" },
    "Route 9 Tunnel": { kind: "cave", habitat: "cave" },
    // Expansion Pass areas, reached by train.
    "Isle of Armor": { kind: "forest", habitat: "grass", island: true }, "Master Dojo": { kind: "venue", island: true },
    "Crown Tundra": { kind: "route", habitat: "mountain", island: true }, "Freezington": { kind: "town", island: true }
  },
  paldea: {
    // Twelve cities & towns across the four provinces.
    "Mesagoza": { kind: "town" }, "Cabo Poco": { kind: "town" }, "Los Platos": { kind: "town" },
    "Cortondo": { kind: "town" }, "Artazon": { kind: "town" }, "Alfornada": { kind: "town" },
    "Cascarrafa": { kind: "town" }, "Porto Marinada": { kind: "town" }, "Medali": { kind: "town" },
    "Levincia": { kind: "town" }, "Zapapico": { kind: "town" }, "Montenevera": { kind: "town" },
    "Paldea Pokémon League": { kind: "town" },
    // Open-world provinces & areas (Paldea has no numbered routes).
    "South Province (Area One)": { kind: "route", habitat: "grass" }, "South Province (Area Two)": { kind: "route", habitat: "grass" },
    "South Province (Area Three)": { kind: "route", habitat: "grass" }, "South Province (Area Four)": { kind: "route", habitat: "grass" },
    "West Province (Area One)": { kind: "route", habitat: "grass" }, "West Province (Area Two)": { kind: "route", habitat: "grass" },
    "West Province (Area Three)": { kind: "route", habitat: "mountain" }, "East Province (Area One)": { kind: "route", habitat: "grass" },
    "East Province (Area Two)": { kind: "route", habitat: "grass" }, "East Province (Area Three)": { kind: "route", habitat: "mountain" },
    "North Province (Area One)": { kind: "route", habitat: "mountain" }, "North Province (Area Two)": { kind: "route", habitat: "grass" },
    "North Province (Area Three)": { kind: "route", habitat: "grass" }, "Poco Path": { kind: "route", habitat: "grass" },
    "Asado Desert": { kind: "route", habitat: "sand" }, "Tagtree Thicket": { kind: "forest", habitat: "forest" },
    "Casseroya Lake": { kind: "ocean", habitat: "water" }, "Glaseado Mountain": { kind: "cave", habitat: "mountain" },
    "Dalizapa Passage": { kind: "cave", habitat: "cave" }, "Alfornada Cavern": { kind: "cave", habitat: "cave" },
    "South Paldean Sea": { kind: "ocean", habitat: "water" }, "West Paldean Sea": { kind: "ocean", habitat: "water" },
    "East Paldean Sea": { kind: "ocean", habitat: "water" }, "North Paldean Sea": { kind: "ocean", habitat: "water" },
    "Zero Gate": { kind: "venue" }, "Area Zero": { kind: "cave", habitat: "cave" }, "Zero Lab": { kind: "venue" },
    // Expansion (The Hidden Treasure of Area Zero), reached by the academy field trips.
    "Kitakami": { kind: "route", habitat: "grass", island: true }, "Mossui Town": { kind: "town", island: true },
    "Blueberry Academy": { kind: "venue", island: true }
  },
  hisui: {
    // Ancient Sinnoh: Jubilife Village and five open sub-regions around Mt. Coronet.
    "Jubilife Village": { kind: "town" }, "Diamond Settlement": { kind: "town" }, "Pearl Settlement": { kind: "town" },
    "Obsidian Fieldlands": { kind: "route", habitat: "grass" }, "Crimson Mirelands": { kind: "route", habitat: "water" },
    "Cobalt Coastlands": { kind: "ocean", habitat: "water" }, "Coronet Highlands": { kind: "cave", habitat: "mountain" },
    "Alabaster Icelands": { kind: "route", habitat: "mountain" }, "The Heartwood": { kind: "forest", habitat: "forest" },
    "Ramanas Island": { kind: "ocean", habitat: "water" }, "Lake Verity": { kind: "ocean", habitat: "water" },
    "Solaceon Ruins": { kind: "cave", habitat: "cave" }, "Lake Valor": { kind: "ocean", habitat: "water" },
    "Firespit Island": { kind: "cave", habitat: "mountain" }, "Wayward Cave": { kind: "cave", habitat: "cave" },
    "Ancient Quarry": { kind: "cave", habitat: "cave" }, "Temple of Sinnoh": { kind: "cave", habitat: "mountain" },
    "Spear Pillar": { kind: "cave", habitat: "mountain" }, "Snowpoint Temple": { kind: "cave", habitat: "cave" },
    "Lake Acuity": { kind: "ocean", habitat: "water" }, "Icepeak Cavern": { kind: "cave", habitat: "cave" }
  }
};

const REGION_LABEL = {
  kanto: "Kanto", johto: "Johto", hoenn: "Hoenn", sinnoh: "Sinnoh",
  unova: "Unova", kalos: "Kalos", alola: "Alola", galar: "Galar", paldea: "Paldea",
  hisui: "Hisui"
};

// [from, from's edge, to] within a region — reverse (opposite edge) auto-generated.
const REGION_CONNECTIONS = {
  kanto: [
  ["Pallet Town", "north", "Route 1"], ["Route 1", "north", "Viridian City"],
  ["Viridian City", "north", "Viridian Forest"], ["Viridian Forest", "north", "Pewter City"],
  ["Viridian City", "west", "Route 22"], ["Route 22", "west", "Route 23"],
  ["Route 23", "north", "Victory Road"], ["Victory Road", "north", "Indigo Plateau"],
  ["Pewter City", "east", "Route 3"], ["Route 3", "east", "Mt. Moon"],
  ["Mt. Moon", "east", "Route 4"], ["Route 4", "east", "Cerulean City"],
  ["Cerulean City", "south", "Route 5"], ["Route 5", "south", "Saffron City"],
  ["Cerulean City", "north", "Route 24"], ["Route 24", "north", "Route 25"],
  ["Cerulean City", "east", "Route 9"], ["Route 9", "east", "Rock Tunnel"],
  ["Rock Tunnel", "east", "Route 10"], ["Route 10", "south", "Lavender Town"],
  ["Saffron City", "south", "Route 6"], ["Route 6", "south", "Vermilion City"],
  ["Saffron City", "west", "Route 7"], ["Route 7", "west", "Celadon City"],
  ["Saffron City", "east", "Route 8"], ["Route 8", "east", "Lavender Town"],
  ["Vermilion City", "east", "Route 11"], ["Route 11", "east", "Diglett's Cave"],
  ["Celadon City", "south", "Route 16"], ["Route 16", "south", "Route 17"],
  ["Route 17", "south", "Route 18"], ["Route 18", "east", "Fuchsia City"],
  ["Lavender Town", "south", "Route 12"], ["Route 12", "south", "Route 13"],
  ["Route 13", "west", "Route 14"], ["Route 14", "south", "Route 15"],
  ["Route 15", "west", "Fuchsia City"], ["Fuchsia City", "south", "Route 19"],
  ["Route 19", "south", "Seafoam Islands"], ["Seafoam Islands", "west", "Route 20"],
  ["Route 20", "west", "Cinnabar Island"], ["Cinnabar Island", "north", "Route 21"],
  ["Route 21", "north", "Pallet Town"],
  ["Vermilion City", "ship", "S.S. Anne", "S.S. Ticket"],
  // Border corridor east of Indigo Plateau toward Johto (Routes 26–28 + Tohjo Falls).
  ["Indigo Plateau", "east", "Route 26"], ["Route 26", "east", "Tohjo Falls"],
  ["Tohjo Falls", "north", "Route 27"], ["Route 27", "north", "Route 28"], ["Route 28", "north", "Mt. Silver"],
  // Sevii Islands — Seagallop ferries from Vermilion Harbor, then island to island.
  ["Vermilion City", "ship", "One Island"], ["One Island", "ship", "Two Island"],
  ["Two Island", "ship", "Three Island"], ["Three Island", "ship", "Four Island"],
  ["Four Island", "ship", "Five Island"], ["Five Island", "ship", "Six Island"],
  ["Six Island", "ship", "Seven Island"],
  ["One Island", "south", "Treasure Beach"], ["One Island", "north", "Kindle Road"],
  ["Kindle Road", "north", "Mt. Ember"], ["One Island", "west", "Cape Brink"],
  ["Three Island", "north", "Bond Bridge"], ["Bond Bridge", "north", "Berry Forest"],
  ["Four Island", "north", "Icefall Cave"], ["Five Island", "north", "Five Isle Meadow"],
  ["Five Isle Meadow", "north", "Lost Cave"], ["Six Island", "east", "Water Path"],
  ["Six Island", "north", "Green Path"], ["Green Path", "north", "Pattern Bush"],
  ["Six Island", "west", "Ruin Valley"], ["Ruin Valley", "west", "Altering Cave"],
  ["Seven Island", "south", "Sevault Canyon"], ["Sevault Canyon", "south", "Tanoby Ruins"],
  ["Seven Island", "north", "Trainer Tower"], ["One Island", "ship", "Navel Rock"],
  ["Six Island", "ship", "Birth Island"]
  ],
  johto: [
    ["New Bark Town", "west", "Route 29"], ["Route 29", "west", "Cherrygrove City"],
    ["Cherrygrove City", "north", "Route 30"], ["Route 30", "north", "Route 31"],
    ["Route 31", "west", "Violet City"], ["Route 31", "south", "Dark Cave"],
    ["Violet City", "north", "Sprout Tower"], ["Violet City", "south", "Route 32"],
    ["Route 32", "east", "Ruins of Alph"], ["Route 32", "south", "Union Cave"],
    ["Union Cave", "south", "Route 33"], ["Route 33", "west", "Azalea Town"],
    ["Azalea Town", "south", "Slowpoke Well"], ["Azalea Town", "west", "Ilex Forest"],
    ["Ilex Forest", "west", "Route 34"], ["Route 34", "north", "Goldenrod City"],
    ["Goldenrod City", "north", "Route 35"], ["Route 35", "north", "National Park"],
    ["National Park", "north", "Route 36"], ["Route 36", "east", "Route 37"],
    ["Route 37", "north", "Ecruteak City"], ["Ecruteak City", "north", "Burned Tower"],
    ["Ecruteak City", "south", "Bell Tower"], ["Ecruteak City", "west", "Route 38"],
    ["Route 38", "west", "Route 39"], ["Route 39", "south", "Olivine City"],
    ["Olivine City", "north", "Olivine Lighthouse"], ["Olivine City", "west", "Route 40"],
    ["Route 40", "west", "Route 41"], ["Route 41", "west", "Cianwood City"],
    ["Route 41", "south", "Whirl Islands"], ["Ecruteak City", "east", "Route 42"],
    ["Route 42", "east", "Mt. Mortar"], ["Mt. Mortar", "east", "Mahogany Town"],
    ["Mahogany Town", "north", "Route 43"], ["Route 43", "north", "Lake of Rage"],
    ["Mahogany Town", "east", "Route 44"], ["Route 44", "east", "Ice Path"],
    ["Ice Path", "east", "Blackthorn City"], ["Blackthorn City", "north", "Dragon's Den"],
    ["Blackthorn City", "south", "Route 45"], ["Route 45", "south", "Route 46"],
    ["Route 46", "south", "Route 29"], ["Dark Cave", "north", "Route 46"],
    ["Cianwood City", "west", "Route 47"], ["Route 47", "north", "Safari Zone Gate"],
    ["Safari Zone Gate", "north", "Route 48"], ["Route 48", "east", "Route 42"]
  ],
  alola: [
    // Melemele Island.
    ["Iki Town", "south", "Route 1"], ["Route 1", "west", "Hau'oli City"],
    ["Route 1", "east", "Trainers' School"], ["Iki Town", "north", "Mahalo Trail"],
    ["Mahalo Trail", "north", "Ruins of Conflict"], ["Route 1", "south", "Ten Carat Hill"],
    ["Hau'oli City", "north", "Route 2"], ["Route 2", "north", "Verdant Cavern"],
    ["Route 2", "east", "Route 3"], ["Route 3", "north", "Melemele Meadow"],
    ["Melemele Meadow", "north", "Seaward Cave"], ["Route 3", "west", "Kala'e Bay"],
    // Akala Island.
    ["Heahea City", "north", "Route 4"], ["Route 4", "north", "Paniola Town"],
    ["Paniola Town", "north", "Route 5"], ["Route 5", "north", "Brooklet Hill"],
    ["Route 5", "east", "Lush Jungle"], ["Brooklet Hill", "north", "Route 6"],
    ["Route 6", "east", "Royal Avenue"], ["Royal Avenue", "east", "Battle Royal Dome"],
    ["Royal Avenue", "north", "Route 7"], ["Route 7", "north", "Wela Volcano Park"],
    ["Wela Volcano Park", "north", "Route 8"], ["Route 8", "east", "Diglett's Tunnel"],
    ["Diglett's Tunnel", "east", "Route 9"], ["Route 9", "south", "Konikoni City"],
    ["Konikoni City", "south", "Memorial Hill"], ["Konikoni City", "east", "Hano Grand Resort"],
    // Ula'ula Island.
    ["Malie City", "north", "Route 10"], ["Route 10", "north", "Mount Hokulani"],
    ["Mount Hokulani", "north", "Hokulani Observatory"], ["Malie City", "east", "Route 11"],
    ["Route 11", "east", "Route 12"], ["Route 12", "north", "Blush Mountain"],
    ["Route 12", "east", "Route 13"], ["Route 13", "east", "Haina Desert"],
    ["Route 13", "north", "Tapu Village"], ["Tapu Village", "north", "Route 14"],
    ["Route 14", "west", "Thrifty Megamart"], ["Route 14", "north", "Route 15"],
    ["Route 15", "east", "Aether House"], ["Route 15", "north", "Route 16"],
    ["Route 16", "north", "Ula'ula Meadow"], ["Ula'ula Meadow", "west", "Lake of the Moone"],
    ["Haina Desert", "east", "Lake of the Sunne"], ["Ula'ula Meadow", "north", "Route 17"],
    ["Route 17", "north", "Po Town"], ["Tapu Village", "east", "Mount Lanakila"],
    ["Mount Lanakila", "north", "Alola Pokémon League"],
    // Poni Island.
    ["Seafolk Village", "north", "Poni Wilds"], ["Poni Wilds", "north", "Ancient Poni Path"],
    ["Ancient Poni Path", "north", "Vast Poni Canyon"], ["Vast Poni Canyon", "north", "Altar of the Sunne"],
    ["Vast Poni Canyon", "east", "Poni Plains"], ["Poni Plains", "north", "Poni Meadow"],
    ["Poni Meadow", "east", "Battle Tree"], ["Poni Plains", "east", "Resolution Cave"],
    ["Seafolk Village", "ship", "Exeggutor Island"],
    // Inter-island ferries — Alola is crossed only by sea. Seafolk Village is the hub.
    ["Hau'oli City", "ship", "Heahea City"], ["Heahea City", "ship", "Malie City"],
    ["Malie City", "ship", "Aether Paradise"], ["Seafolk Village", "ship", "Hau'oli City"],
    ["Seafolk Village", "ship", "Heahea City"], ["Seafolk Village", "ship", "Malie City"],
    ["Seafolk Village", "ship", "Aether Paradise"]
  ],
  hoenn: [
    ["Littleroot Town", "north", "Route 101"], ["Route 101", "north", "Oldale Town"],
    ["Oldale Town", "west", "Route 102"], ["Route 102", "west", "Petalburg City"],
    ["Oldale Town", "north", "Route 103"], ["Route 103", "east", "Route 110"],
    ["Petalburg City", "north", "Route 104"], ["Route 104", "west", "Petalburg Woods"],
    ["Route 104", "north", "Rustboro City"], ["Route 104", "south", "Route 105"],
    ["Route 105", "south", "Route 106"], ["Route 106", "south", "Dewford Town"],
    ["Dewford Town", "south", "Granite Cave"], ["Dewford Town", "east", "Route 107"],
    ["Route 107", "east", "Route 108"], ["Route 108", "east", "Route 109"],
    ["Route 109", "north", "Slateport City"], ["Slateport City", "north", "Route 110"],
    ["Route 110", "north", "Mauville City"], ["Mauville City", "west", "Route 117"],
    ["Route 117", "west", "Verdanturf Town"], ["Verdanturf Town", "west", "Rusturf Tunnel"],
    ["Rusturf Tunnel", "north", "Route 116"], ["Route 116", "west", "Rustboro City"],
    ["Mauville City", "north", "Route 111"], ["Route 111", "north", "Route 112"],
    ["Route 112", "north", "Lavaridge Town"], ["Route 112", "east", "Fiery Path"],
    ["Lavaridge Town", "north", "Jagged Pass"], ["Jagged Pass", "north", "Mt. Chimney"],
    ["Route 111", "west", "Route 113"], ["Route 113", "west", "Fallarbor Town"],
    ["Fallarbor Town", "south", "Route 114"], ["Route 114", "south", "Meteor Falls"],
    ["Meteor Falls", "south", "Route 115"], ["Route 115", "south", "Rustboro City"],
    ["Mauville City", "east", "Route 118"], ["Route 118", "north", "Route 119"],
    ["Route 119", "north", "Fortree City"], ["Route 119", "east", "Weather Institute"],
    ["Fortree City", "east", "Route 120"], ["Route 120", "east", "Route 121"],
    ["Route 121", "east", "Lilycove City"], ["Route 121", "south", "Hoenn Safari Zone"],
    ["Lilycove City", "south", "Route 122"], ["Route 122", "south", "Mt. Pyre"],
    ["Route 122", "west", "Route 123"], ["Route 123", "west", "Route 118"],
    ["Lilycove City", "east", "Route 124"], ["Route 124", "east", "Mossdeep City"],
    ["Route 124", "south", "Route 126"], ["Mossdeep City", "north", "Route 125"],
    ["Route 125", "north", "Shoal Cave"], ["Mossdeep City", "south", "Route 127"],
    ["Route 127", "west", "Route 126"], ["Route 126", "west", "Sootopolis City"],
    ["Sootopolis City", "north", "Cave of Origin"], ["Route 127", "south", "Route 128"],
    ["Route 128", "south", "Ever Grande City"], ["Route 128", "east", "Seafloor Cavern"],
    ["Ever Grande City", "north", "Hoenn Victory Road"], ["Hoenn Victory Road", "north", "Hoenn Pokémon League"],
    ["Route 128", "west", "Route 129"], ["Route 129", "west", "Route 130"],
    ["Route 130", "west", "Route 131"], ["Route 131", "west", "Pacifidlog Town"],
    ["Route 131", "south", "Sky Pillar"], ["Pacifidlog Town", "west", "Route 132"],
    ["Route 132", "west", "Route 133"], ["Route 133", "west", "Route 134"],
    ["Route 134", "north", "Slateport City"], ["Lilycove City", "north", "Battle Frontier"]
  ],
  sinnoh: [
    ["Twinleaf Town", "north", "Route 201"], ["Route 201", "west", "Lake Verity"],
    ["Route 201", "east", "Sandgem Town"], ["Sandgem Town", "north", "Route 202"],
    ["Route 202", "north", "Jubilife City"], ["Jubilife City", "east", "Route 203"],
    ["Route 203", "east", "Oreburgh Gate"], ["Oreburgh Gate", "south", "Oreburgh City"],
    ["Oreburgh City", "south", "Oreburgh Mine"], ["Jubilife City", "north", "Route 204"],
    ["Route 204", "north", "Ravaged Path"], ["Route 204", "north", "Floaroma Town"],
    ["Floaroma Town", "east", "Route 205"], ["Route 205", "west", "Valley Windworks"],
    ["Route 205", "north", "Eterna Forest"], ["Eterna Forest", "north", "Old Chateau"],
    ["Eterna Forest", "east", "Eterna City"], ["Oreburgh City", "north", "Route 207"],
    ["Route 207", "north", "Route 206"], ["Route 206", "north", "Eterna City"],
    ["Route 206", "east", "Wayward Cave"], ["Eterna City", "east", "Route 211"],
    ["Route 211", "east", "Mount Coronet"], ["Mount Coronet", "east", "Celestic Town"],
    ["Mount Coronet", "north", "Spear Pillar"], ["Hearthome City", "north", "Route 208"],
    ["Route 208", "north", "Mount Coronet"], ["Hearthome City", "east", "Route 209"],
    ["Route 209", "east", "Lost Tower"], ["Route 209", "north", "Solaceon Town"],
    ["Solaceon Town", "east", "Solaceon Ruins"], ["Solaceon Town", "south", "Route 210"],
    ["Route 210", "north", "Celestic Town"], ["Route 210", "south", "Route 215"],
    ["Route 215", "west", "Veilstone City"], ["Hearthome City", "south", "Route 212"],
    ["Route 212", "south", "Pastoria City"], ["Pastoria City", "west", "Great Marsh"],
    ["Route 212", "east", "Pokémon Mansion"], ["Pastoria City", "east", "Route 213"],
    ["Route 213", "east", "Lake Valor"], ["Veilstone City", "south", "Route 214"],
    ["Route 214", "south", "Lake Valor"], ["Lake Valor", "east", "Route 222"],
    ["Route 222", "east", "Sunyshore City"], ["Sunyshore City", "east", "Route 223"],
    ["Route 223", "north", "Sinnoh Victory Road"], ["Sinnoh Victory Road", "north", "Sinnoh Pokémon League"],
    ["Sinnoh Pokémon League", "north", "Route 224"], ["Jubilife City", "west", "Route 218"],
    ["Route 218", "west", "Canalave City"], ["Canalave City", "west", "Iron Island"],
    ["Sandgem Town", "south", "Route 219"], ["Route 219", "south", "Route 220"],
    ["Route 220", "west", "Route 221"], ["Celestic Town", "north", "Route 211"],
    ["Route 216", "north", "Route 217"], ["Route 217", "north", "Snowpoint City"],
    ["Route 216", "south", "Mount Coronet"], ["Route 217", "east", "Lake Acuity"],
    ["Snowpoint City", "north", "Snowpoint Temple"],
    // The Battle Zone in the far north, reached by boat from Snowpoint after the League.
    ["Snowpoint City", "ship", "Fight Area"], ["Fight Area", "north", "Route 225"],
    ["Route 225", "north", "Route 226"], ["Route 226", "north", "Route 227"],
    ["Route 227", "north", "Stark Mountain"], ["Fight Area", "east", "Survival Area"],
    ["Survival Area", "east", "Route 228"], ["Route 228", "south", "Route 229"],
    ["Route 229", "east", "Resort Area"], ["Resort Area", "east", "Sinnoh Battle Tower"],
    ["Route 230", "north", "Resort Area"]
  ],
  unova: [
    ["Nuvema Town", "north", "Route 1"], ["Route 1", "north", "Accumula Town"],
    ["Route 1", "east", "Route 17"], ["Route 17", "south", "Route 18"],
    ["Accumula Town", "north", "Route 2"], ["Route 2", "north", "Striaton City"],
    ["Striaton City", "north", "Route 3"], ["Route 3", "west", "Wellspring Cave"],
    ["Route 3", "west", "Nacrene City"], ["Nacrene City", "west", "Pinwheel Forest"],
    ["Pinwheel Forest", "west", "Skyarrow Bridge"], ["Skyarrow Bridge", "south", "Castelia City"],
    ["Castelia City", "north", "Route 4"], ["Route 4", "west", "Desert Resort"],
    ["Desert Resort", "south", "Relic Castle"], ["Route 4", "north", "Nimbasa City"],
    ["Nimbasa City", "west", "Route 5"], ["Route 5", "west", "Driftveil Drawbridge"],
    ["Driftveil Drawbridge", "west", "Driftveil City"], ["Driftveil City", "north", "Route 6"],
    ["Route 6", "north", "Chargestone Cave"], ["Chargestone Cave", "north", "Mistralton City"],
    ["Mistralton City", "north", "Route 7"], ["Route 7", "east", "Twist Mountain"],
    ["Twist Mountain", "north", "Icirrus City"], ["Icirrus City", "east", "Route 8"],
    ["Route 8", "east", "Moor of Icirrus"], ["Route 8", "east", "Tubeline Bridge"],
    ["Tubeline Bridge", "south", "Route 9"], ["Route 9", "south", "Opelucid City"],
    ["Route 9", "north", "Challenger's Cave"], ["Opelucid City", "north", "Route 10"],
    ["Route 10", "north", "Unova Victory Road"], ["Unova Victory Road", "north", "Unova Pokémon League"],
    ["Opelucid City", "east", "Route 11"], ["Route 11", "east", "Village Bridge"],
    ["Village Bridge", "south", "Route 12"], ["Route 12", "south", "Lacunosa Town"],
    ["Lacunosa Town", "east", "Route 13"], ["Route 13", "north", "Giant Chasm"],
    ["Route 13", "south", "Undella Town"], ["Undella Town", "west", "Route 14"],
    ["Route 14", "west", "Black City"], ["Black City", "west", "Route 15"],
    ["Route 15", "west", "White Forest"], ["Route 15", "west", "Marvelous Bridge"],
    ["Marvelous Bridge", "west", "Route 16"], ["Route 16", "west", "Lostlorn Forest"],
    ["Lostlorn Forest", "west", "Nimbasa City"],
    // Southwestern Unova (Black 2 & White 2 start).
    ["Aspertia City", "east", "Route 19"], ["Route 19", "east", "Floccesy Town"],
    ["Floccesy Town", "north", "Route 20"], ["Route 20", "north", "Floccesy Ranch"],
    ["Route 20", "east", "Virbank City"], ["Virbank City", "ship", "Castelia City"],
    ["Humilau City", "north", "Route 21"], ["Route 21", "north", "Seaside Cave"],
    ["Humilau City", "west", "Route 22"], ["Route 22", "west", "Giant Chasm"],
    ["Giant Chasm", "west", "Route 23"], ["Route 23", "west", "Unova Victory Road"]
  ],
  kalos: [
    ["Vaniville Town", "north", "Route 1"], ["Route 1", "north", "Aquacorde Town"],
    ["Aquacorde Town", "north", "Route 2"], ["Route 2", "north", "Santalune Forest"],
    ["Santalune Forest", "north", "Route 3"], ["Route 3", "east", "Santalune City"],
    ["Santalune City", "north", "Route 4"], ["Route 4", "north", "Lumiose City"],
    ["Lumiose City", "north", "Route 5"], ["Route 5", "north", "Camphrier Town"],
    ["Camphrier Town", "north", "Route 7"], ["Route 7", "north", "Route 6"],
    ["Route 6", "north", "Parfum Palace"], ["Route 7", "west", "Connecting Cave"],
    ["Connecting Cave", "west", "Route 8"], ["Route 8", "west", "Cyllage City"],
    ["Route 8", "south", "Ambrette Town"], ["Ambrette Town", "south", "Route 9"],
    ["Route 9", "east", "Glittering Cave"], ["Cyllage City", "north", "Route 10"],
    ["Route 10", "north", "Geosenge Town"], ["Geosenge Town", "north", "Route 11"],
    ["Geosenge Town", "east", "Team Flare Secret HQ"], ["Route 11", "north", "Reflection Cave"],
    ["Reflection Cave", "north", "Shalour City"], ["Shalour City", "west", "Tower of Mastery"],
    ["Shalour City", "north", "Route 12"], ["Route 12", "north", "Azure Bay"],
    ["Route 12", "east", "Coumarine City"], ["Coumarine City", "east", "Route 13"],
    ["Route 13", "east", "Kalos Power Plant"], ["Route 13", "east", "Lumiose City"],
    ["Lumiose City", "east", "Route 14"], ["Route 14", "east", "Laverre City"],
    ["Laverre City", "north", "Route 15"], ["Route 15", "north", "Dendemille Town"],
    ["Route 15", "south", "Route 16"], ["Route 16", "south", "Lumiose City"],
    ["Route 15", "east", "Lost Hotel"], ["Dendemille Town", "west", "Frost Cavern"],
    ["Dendemille Town", "east", "Route 17"], ["Route 17", "east", "Anistar City"],
    ["Anistar City", "south", "Route 18"], ["Route 18", "south", "Couriway Town"],
    ["Route 18", "east", "Terminus Cave"], ["Couriway Town", "south", "Route 19"],
    ["Route 19", "south", "Snowbelle City"], ["Snowbelle City", "west", "Route 20"],
    ["Route 20", "west", "Pokémon Village"], ["Snowbelle City", "north", "Route 21"],
    ["Route 21", "north", "Kalos Victory Road"], ["Kalos Victory Road", "north", "Kalos Pokémon League"],
    ["Kalos Victory Road", "south", "Route 22"], ["Route 22", "south", "Santalune City"],
    ["Lumiose City", "ship", "Kiloude City"], ["Kiloude City", "south", "Battle Maison"]
  ],
  galar: [
    ["Postwick", "north", "Route 1"], ["Route 1", "north", "Wedgehurst"],
    ["Postwick", "west", "Slumbering Weald"], ["Wedgehurst", "north", "Route 2"],
    ["Route 2", "north", "Wild Area"], ["Wild Area", "north", "Motostoke"],
    ["Wild Area", "east", "Hammerlocke"], ["Motostoke", "north", "Route 3"],
    ["Route 3", "north", "Galar Mine"], ["Galar Mine", "north", "Route 4"],
    ["Route 4", "north", "Turffield"], ["Turffield", "east", "Route 5"],
    ["Route 5", "east", "Hulbury"], ["Hulbury", "north", "Galar Mine No. 2"],
    ["Galar Mine No. 2", "north", "Motostoke Outskirts"], ["Motostoke Outskirts", "west", "Motostoke"],
    ["Hammerlocke", "north", "Route 6"], ["Route 6", "north", "Stow-on-Side"],
    ["Stow-on-Side", "east", "Glimwood Tangle"], ["Glimwood Tangle", "east", "Ballonlea"],
    ["Hammerlocke", "west", "Route 7"], ["Route 7", "north", "Route 8"],
    ["Route 8", "north", "Circhester"], ["Circhester", "north", "Route 9"],
    ["Route 9", "north", "Route 9 Tunnel"], ["Route 9 Tunnel", "north", "Spikemuth"],
    ["Hammerlocke", "east", "Route 10"], ["Route 10", "east", "Wyndon"],
    ["Wyndon", "north", "Galar Pokémon League"],
    // Expansion Pass islands, reached by the Galar rail network.
    ["Wedgehurst", "ship", "Isle of Armor"], ["Isle of Armor", "east", "Master Dojo"],
    ["Wyndon", "ship", "Crown Tundra"], ["Crown Tundra", "north", "Freezington"]
  ],
  paldea: [
    // Southern start: the coast up to Mesagoza.
    ["Cabo Poco", "north", "Poco Path"], ["Poco Path", "north", "Los Platos"],
    ["Los Platos", "north", "South Province (Area One)"], ["South Province (Area One)", "north", "Mesagoza"],
    ["Cabo Poco", "south", "South Paldean Sea"], ["Mesagoza", "west", "Cortondo"],
    ["Mesagoza", "east", "South Province (Area Two)"], ["South Province (Area Two)", "east", "Artazon"],
    ["Mesagoza", "north", "South Province (Area Three)"], ["Mesagoza", "south", "Paldea Pokémon League"],
    ["Cortondo", "south", "South Province (Area Four)"], ["South Province (Area Four)", "south", "Alfornada Cavern"],
    ["Alfornada Cavern", "south", "Alfornada"],
    // West Province.
    ["Cortondo", "west", "West Province (Area One)"], ["West Province (Area One)", "west", "Cascarrafa"],
    ["Cascarrafa", "west", "Asado Desert"], ["Asado Desert", "north", "West Province (Area Two)"],
    ["West Province (Area Two)", "north", "Medali"], ["Cascarrafa", "south", "Porto Marinada"],
    ["Porto Marinada", "west", "West Paldean Sea"], ["Medali", "north", "West Province (Area Three)"],
    ["West Province (Area Three)", "north", "Glaseado Mountain"],
    // East Province.
    ["Artazon", "east", "East Province (Area One)"], ["East Province (Area One)", "east", "Levincia"],
    ["Levincia", "east", "East Paldean Sea"], ["Levincia", "north", "East Province (Area Two)"],
    ["East Province (Area Two)", "north", "Zapapico"], ["Zapapico", "east", "Tagtree Thicket"],
    ["Tagtree Thicket", "north", "East Province (Area Three)"], ["Zapapico", "north", "Dalizapa Passage"],
    // North Province & Glaseado Mountain.
    ["Dalizapa Passage", "north", "North Province (Area One)"], ["North Province (Area One)", "west", "Montenevera"],
    ["Montenevera", "north", "Glaseado Mountain"], ["Glaseado Mountain", "east", "North Province (Area Two)"],
    ["North Province (Area Two)", "east", "North Province (Area Three)"], ["North Province (Area Three)", "west", "Casseroya Lake"],
    ["North Province (Area Three)", "north", "North Paldean Sea"],
    // The Great Crater — Area Zero.
    ["Glaseado Mountain", "south", "Zero Gate"], ["Zero Gate", "south", "Area Zero"], ["Area Zero", "south", "Zero Lab"],
    // Expansion field trips.
    ["Mesagoza", "ship", "Kitakami"], ["Kitakami", "north", "Mossui Town"], ["Mesagoza", "ship", "Blueberry Academy"]
  ],
  hisui: [
    // Expeditions launch from Jubilife Village to each open area.
    ["Jubilife Village", "north", "Obsidian Fieldlands"], ["Jubilife Village", "east", "Crimson Mirelands"],
    ["Jubilife Village", "west", "Cobalt Coastlands"], ["Jubilife Village", "south", "Coronet Highlands"],
    ["Coronet Highlands", "north", "Alabaster Icelands"],
    ["Obsidian Fieldlands", "east", "The Heartwood"], ["Obsidian Fieldlands", "south", "Ramanas Island"],
    ["Obsidian Fieldlands", "west", "Lake Verity"], ["Crimson Mirelands", "north", "Diamond Settlement"],
    ["Crimson Mirelands", "east", "Solaceon Ruins"], ["Crimson Mirelands", "south", "Lake Valor"],
    ["Cobalt Coastlands", "west", "Firespit Island"], ["Coronet Highlands", "east", "Wayward Cave"],
    ["Coronet Highlands", "west", "Ancient Quarry"], ["Coronet Highlands", "south", "Temple of Sinnoh"],
    ["Temple of Sinnoh", "north", "Spear Pillar"], ["Alabaster Icelands", "north", "Pearl Settlement"],
    ["Alabaster Icelands", "east", "Snowpoint Temple"], ["Alabaster Icelands", "west", "Lake Acuity"],
    ["Alabaster Icelands", "south", "Icepeak Cavern"]
  ]
};

// Cross-region links: [regionA, placeA, edge, regionB, placeB, ticket?].
// A compass edge is a land border; "ship" is a ticketed ferry/flight.
const INTER_REGION = [
  // Johto joins Kanto by land: New Bark Town ↔ Kanto's Route 27 (via Tohjo Falls).
  ["johto", "New Bark Town", "east", "kanto", "Route 27"],
  // Alola is reachable only by sea — a cruise from Vermilion Harbor to Hau'oli City.
  ["kanto", "Vermilion City", "ship", "alola", "Hau'oli City", "S.S. Ticket"],
  // Hoenn by sea — the S.S. Tidal ferry runs from Olivine (Johto) to Slateport.
  ["johto", "Olivine City", "ship", "hoenn", "Slateport City", "S.S. Ticket"],
  // Sinnoh by sea — a ferry from Lilycove (Hoenn) to the port of Canalave City.
  ["hoenn", "Lilycove City", "ship", "sinnoh", "Canalave City", "S.S. Ticket"],
  // Unova, far across the ocean — the international liner from Vermilion to Castelia.
  ["kanto", "Vermilion City", "ship", "unova", "Castelia City", "S.S. Ticket"],
  // Kalos across the sea — a ferry from Canalave (Sinnoh) to the port of Coumarine City.
  ["sinnoh", "Canalave City", "ship", "kalos", "Coumarine City", "S.S. Ticket"],
  // Galar across the sea — a ferry from Coumarine (Kalos) to the seaside town of Hulbury.
  ["kalos", "Coumarine City", "ship", "galar", "Hulbury", "S.S. Ticket"],
  // Paldea (neighbouring Kalos, as Spain neighbours France) — a ferry to Porto Marinada.
  ["kalos", "Coumarine City", "ship", "paldea", "Porto Marinada", "S.S. Ticket"],
  // Hisui — the ancient past of Sinnoh, reached by a lone voyage from Canalave City.
  ["sinnoh", "Canalave City", "ship", "hisui", "Jubilife Village", "S.S. Ticket"]
];

const OPPOSITE = { north: "south", south: "north", east: "west", west: "east" };
// Map dimensions per kind (grid = 100px). Expansive but capped at ~4000px so the
// rasterized background never exceeds a GPU's max texture size (a common cause
// of a fully black scene on lower-end hardware).
const KIND_DIMS = { town: [3200, 2400], route: [4000, 2400], forest: [3800, 3800], cave: [3600, 2800], ocean: [4000, 3200], venue: [2800, 2200] };

// Wild-encounter level band per habitat (rougher terrain trends higher-level).
const HABITAT_LEVELS = {
  grass: [2, 12], forest: [3, 14], water: [5, 20], fishing: [5, 25], urban: [3, 12],
  cave: [6, 22], mountain: [8, 26], sand: [7, 22], night: [5, 18]
};
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const KIND_FILL = { town: "#cdbd8f", route: "#8ec98e", forest: "#3f7a3f", cave: "#5a5560", ocean: "#4a86c5", venue: "#b08a5a" };

// Global name resolver: Kanto keeps bare names (stable); any place name shared
// across regions gets its region prefixed — so "Route 1" stays Kanto's while the
// others become "Unova Route 1", "Kalos Route 1", etc. Unique names stay bare.
function buildQualifier() {
  const counts = {};
  for (const defs of Object.values(REGION_MAPS)) for (const bare of Object.keys(defs)) counts[bare] = (counts[bare] || 0) + 1;
  // Kanto stays fully bare (stable). Elsewhere, numbered routes are always
  // region-prefixed (route numbers are region-scoped, à la "Johto Route 29"),
  // and any other name is prefixed only when it collides across regions.
  return (region, bare) => {
    if (region === "kanto") return bare;
    if (counts[bare] === 1 && !/^Route \d+$/.test(bare)) return bare;
    return `${REGION_LABEL[region]} ${bare}`;
  };
}
const qualifyName = buildQualifier();

/** Build each map's exit list from the (symmetric) per-region + inter-region graph. */
function exitsByMap() {
  const out = {};
  const add = (name, exit) => { (out[name] ??= []).push(exit); };
  for (const [region, conns] of Object.entries(REGION_CONNECTIONS)) {
    for (const [a, edge, b, ticket] of conns) {
      const A = qualifyName(region, a);
      const B = qualifyName(region, b);
      if (edge === "ship") { add(A, { ship: true, to: B, ticket }); add(B, { ship: true, to: A, ticket }); }
      else { add(A, { edge, to: B }); add(B, { edge: OPPOSITE[edge], to: A }); }
    }
  }
  // Cross-region links: [regionA, placeA, edge, regionB, placeB, ticket?].
  // edge === "ship" is a ticketed ferry/flight; a compass edge is a land border.
  for (const [ra, a, edge, rb, b, ticket] of INTER_REGION) {
    const A = qualifyName(ra, a);
    const B = qualifyName(rb, b);
    if (edge === "ship") { add(A, { ship: true, to: B, ticket }); add(B, { ship: true, to: A, ticket }); }
    else { add(A, { edge, to: B, ticket }); add(B, { edge: OPPOSITE[edge], to: A, ticket }); }
  }
  return out;
}

/** Every map across every region as a full object (name, region, kind, dims, exits). */
function allMaps() {
  const exits = exitsByMap();
  const maps = [];
  for (const [region, defs] of Object.entries(REGION_MAPS)) {
    for (const [bare, def] of Object.entries(defs)) {
      const name = qualifyName(region, bare);
      const [w, h] = KIND_DIMS[def.kind] ?? [2600, 1800];
      maps.push({ key: slug(name), name, region, w, h, exits: exits[name] ?? [], ...def });
    }
  }
  return maps;
}
const DIMS = Object.fromEntries(allMaps().map((m) => [m.name, [m.w, m.h]]));

const edgeRect = (e, w, h) => ({ north: [w / 2 - 150, 0, 300, 120], south: [w / 2 - 150, h - 120, 300, 120], east: [w - 120, h / 2 - 150, 120, 300], west: [0, h / 2 - 150, 120, 300] }[e]);
const arriveEntry = (e, w, h) => ({ north: [w / 2, h - 320], south: [w / 2, 320], east: [320, h / 2], west: [w - 320, h / 2] }[e]);
const edgeLabelPos = (e, w, h) => ({ north: [w / 2, 150], south: [w / 2, h - 150], east: [w - 220, h / 2], west: [220, h / 2] }[e]);
const dockRect = (w, h, i = 0) => [w - 360 - i * 340, h - 360, 300, 300];
const dockEntry = (w, h) => [w - 560, h - 560];

/** Escape text for embedding in SVG (a stray "&" in a name breaks the XML). */
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Deterministic RNG so a given map always renders identically. */
function seededRng(str) {
  let s = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { s ^= str.charCodeAt(i); s = Math.imul(s, 16777619) >>> 0; }
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
/** Road palette per terrain (a path that contrasts with the ground). */
const ROAD = { town: "#c8c2b0", route: "#cbb37a", forest: "#b79b62", cave: "#7d7686", ocean: null, venue: "#d8c7a6" };

/** A door + a highlighted "step here" entrance mat at the front-centre of a building. */
function buildingWithDoor(x, y, bw, bh, wall, roof, label, roadCol) {
  const cx = x + bw / 2;
  const door = 46;
  return `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="10" fill="${wall}" stroke="#8a8a8a" stroke-width="4"/>`
    + `<rect x="${x}" y="${y}" width="${bw}" height="60" fill="${roof}"/>`
    // path from below up to the door + a bright entrance mat on the door tile
    + (roadCol ? `<rect x="${cx - 26}" y="${y + bh}" width="52" height="90" fill="${roadCol}"/>` : "")
    + `<rect x="${cx - door / 2}" y="${y + bh - door - 6}" width="${door}" height="${door + 6}" rx="6" fill="#3a2f2a"/>`
    + `<rect x="${cx - 40}" y="${y + bh + 4}" width="80" height="26" rx="6" fill="#ffd94a" stroke="#b28a00" stroke-width="3"/>`
    + `<text x="${cx}" y="${y + bh - 74}" font-family="Arial" font-size="22" fill="#333" text-anchor="middle">${xml(label)}</text>`;
}

/** A clear exit gate (arrow + destination) at an edge, aligned to its warp tile. */
function exitGate(edge, w, h, to) {
  const [x, y, gw, gh] = edgeRect(edge, w, h);
  const arrow = { north: "▲", south: "▼", east: "▶", west: "◀" }[edge] ?? "▲";
  const cx = x + gw / 2, cy = y + gh / 2;
  const lx = edge === "east" ? cx - 120 : edge === "west" ? cx + 120 : cx;
  const ly = edge === "north" ? y + gh + 34 : edge === "south" ? y - 16 : cy + 8;
  return `<rect x="${x}" y="${y}" width="${gw}" height="${gh}" rx="8" fill="#ffd94a" stroke="#1c3c5c" stroke-width="6"/>`
    + `<text x="${cx}" y="${cy + 18}" font-family="Arial" font-size="52" fill="#1c3c5c" text-anchor="middle">${arrow}</text>`
    + `<text x="${lx}" y="${ly}" font-family="Arial" font-size="28" font-weight="bold" fill="#12324f" text-anchor="middle">${xml(to)}</text>`;
}

function mapSvg(map) {
  const w = map.w ?? 2400;
  const h = map.h ?? 1600;
  const kind = map.kind;
  const fill = KIND_FILL[kind] ?? "#8ec98e";
  const rng = seededRng(map.key);
  const road = ROAD[kind] ?? null;
  const cx = w / 2, cy = h / 2;
  // Town roads/NPCs meet on the street just below the building row; elsewhere the
  // paths meet at the map centre.
  const hubY = kind === "town" ? cy + 140 : cy;
  const p = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`, `<rect width="${w}" height="${h}" fill="${fill}"/>`];

  // ---- Terrain texture (scattered features, kept clear of the centre hub) ----
  const nearCenter = (fx, fy) => Math.abs(fx - cx) < w * 0.16 && Math.abs(fy - cy) < h * 0.16;
  const scatter = (n, draw) => { for (let i = 0; i < n; i++) { const fx = 120 + rng() * (w - 240), fy = 160 + rng() * (h - 320); if (!nearCenter(fx, fy)) p.push(draw(fx, fy)); } };
  if (kind === "route") {
    p.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="#7dbf7d" opacity="0.0"/>`);
    scatter(70, (x, y) => `<circle cx="${x}" cy="${y}" r="${18 + rng() * 16}" fill="#5fa85f" opacity="0.7"/>`); // tall-grass tufts
    scatter(18, (x, y) => `<circle cx="${x}" cy="${y}" r="${34 + rng() * 18}" fill="#2f7d32"/><rect x="${x - 6}" y="${y}" width="12" height="34" fill="#6b4a2a"/>`); // trees
  } else if (kind === "forest") {
    scatter(120, (x, y) => `<circle cx="${x}" cy="${y}" r="${30 + rng() * 26}" fill="#2c5f2c"/><circle cx="${x}" cy="${y - 8}" r="${18 + rng() * 14}" fill="#367a36"/>`);
  } else if (kind === "cave") {
    scatter(60, (x, y) => `<polygon points="${x},${y - 40} ${x + 34},${y + 26} ${x - 34},${y + 26}" fill="#6b6674"/>`); // rocks
  } else if (kind === "ocean") {
    for (let i = 0; i < 60; i++) { const yy = 160 + rng() * (h - 320), xx = 60 + rng() * (w - 200); p.push(`<path d="M${xx} ${yy} q 30 -18 60 0 t 60 0" stroke="#6fa8dd" stroke-width="6" fill="none" opacity="0.7"/>`); }
  } else if (kind === "venue") {
    p.push(`<rect x="${w * 0.08}" y="${h * 0.08}" width="${w * 0.84}" height="${h * 0.84}" rx="20" fill="#c9a875" stroke="#8a6a3a" stroke-width="8"/>`);
    for (let gx = w * 0.12; gx < w * 0.88; gx += 220) p.push(`<line x1="${gx}" y1="${h * 0.08}" x2="${gx}" y2="${h * 0.92}" stroke="#b8975f" stroke-width="2"/>`);
  }

  // ---- Road network: a hub with a path to every land exit ----
  if (road) {
    for (const ex of map.exits) {
      if (ex.ship) continue;
      const [ex2, ey2] = arriveEntry(ex.edge, w, h);
      p.push(`<line x1="${cx}" y1="${hubY}" x2="${ex2}" y2="${ey2}" stroke="${road}" stroke-width="70" stroke-linecap="round"/>`);
    }
    p.push(`<circle cx="${cx}" cy="${hubY}" r="60" fill="${road}"/>`);
  }

  // ---- Town: a main street + the service buildings (aligned with their region
  //      tiles at cy-120), each with a door and a bright entrance mat. ----
  if (kind === "town") {
    p.push(`<rect x="${cx - 560}" y="${cy + 84}" width="1320" height="120" rx="20" fill="${road}"/>`); // main street below the buildings
    p.push(buildingWithDoor(cx - 500, cy - 120, 200, 200, "#f3efe6", "#e0554f", "Pokémon Center", road));
    p.push(buildingWithDoor(cx - 100, cy - 120, 200, 200, "#f3efe6", "#4f7fd0", "Poké Mart", road));
    p.push(buildingWithDoor(cx + 220, cy - 120, 200, 200, "#eef2f7", "#2f5aa8", "Police 🚓", road));
    if (map.gym) p.push(buildingWithDoor(cx + 520, cy - 120, 200, 200, "#efe6ff", "#7b2ff7", `${map.gym.leader}'s Gym ★`, road));
  }

  // ---- Ship docks (ferry/flight exits) ----
  map.exits.filter((e) => e.ship).forEach((ex, i) => {
    const [dx, dy, dw, dh] = dockRect(w, h, i);
    p.push(`<rect x="${dx}" y="${dy}" width="${dw}" height="${dh}" rx="8" fill="#8a6d3b" stroke="#5c4522" stroke-width="6"/>`
      + `<text x="${dx + dw / 2}" y="${dy + dh / 2 + 8}" font-family="Arial" font-size="26" fill="#fff" text-anchor="middle">⚓ ${xml(ex.to)}</text>`);
  });

  // ---- Land exit gates (clearly marked, aligned to the warp tiles) ----
  for (const ex of map.exits) { if (!ex.ship) p.push(exitGate(ex.edge, w, h, ex.to)); }

  // ---- Title banner ----
  p.push(`<rect x="${cx - 320}" y="24" width="640" height="60" rx="12" fill="#ffffff" opacity="0.72"/>`);
  p.push(`<text x="${cx}" y="68" font-family="Arial" font-size="46" font-weight="bold" fill="#222" text-anchor="middle">${xml(map.name)}${map.island ? " (Island)" : ""}</text>`);
  p.push("</svg>");
  return p.join("\n");
}

// Building interiors are a fixed small room: a service counter up top, an exit
// door at the bottom. The player walks in through the building's door tile.
const INT_W = 1600, INT_H = 1100;
const INT_FLOOR = { center: "#f6e9f0", mart: "#e8f1fb", police: "#e9eef6", gym: "#efe7ff" };
const INT_TRIM = { center: "#e0554f", mart: "#4f7fd0", police: "#2f5aa8", gym: "#7b2ff7" };
function interiorSvg(kind, title) {
  const floor = INT_FLOOR[kind] ?? "#efe6da", trim = INT_TRIM[kind] ?? "#8a6a3a";
  const cx = INT_W / 2;
  const p = [`<svg xmlns="http://www.w3.org/2000/svg" width="${INT_W}" height="${INT_H}" viewBox="0 0 ${INT_W} ${INT_H}">`];
  p.push(`<rect width="${INT_W}" height="${INT_H}" fill="${floor}"/>`);
  for (let gx = 0; gx <= INT_W; gx += 100) p.push(`<line x1="${gx}" y1="0" x2="${gx}" y2="${INT_H}" stroke="#00000010" stroke-width="2"/>`);
  for (let gy = 0; gy <= INT_H; gy += 100) p.push(`<line x1="0" y1="${gy}" x2="${INT_W}" y2="${gy}" stroke="#00000010" stroke-width="2"/>`);
  p.push(`<rect x="0" y="0" width="${INT_W}" height="120" fill="${trim}"/>`);              // back wall
  p.push(`<rect x="${cx - 260}" y="230" width="520" height="150" rx="12" fill="#c9a06a" stroke="#8a6a3a" stroke-width="6"/>`); // counter
  p.push(`<text x="${cx}" y="200" font-family="Arial" font-size="34" font-weight="bold" fill="#fff" text-anchor="middle">${xml(title)}</text>`);
  p.push(`<text x="${cx}" y="470" font-family="Arial" font-size="24" fill="#555" text-anchor="middle">Step up to the counter</text>`);
  p.push(`<rect x="${cx - 90}" y="${INT_H - 150}" width="180" height="150" rx="8" fill="#3a2f2a"/>`);  // exit door
  p.push(`<rect x="${cx - 70}" y="${INT_H - 200}" width="140" height="40" rx="8" fill="#ffd94a" stroke="#b28a00" stroke-width="3"/>`);
  p.push(`<text x="${cx}" y="${INT_H - 210}" font-family="Arial" font-size="26" font-weight="bold" fill="#12324f" text-anchor="middle">▼ Exit</text>`);
  p.push("</svg>");
  return p.join("\n");
}

async function buildScenes() {
  const mapsDir = path.join(ROOT, "assets", "maps");
  await fs.mkdir(mapsDir, { recursive: true });

  const region = (name, color, x, y, w, h, type, sys) => ({
    _id: stableId("region", `${name}-${x}-${y}`),
    name, color,
    shapes: [{ type: "rectangle", x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h), rotation: 0, hole: false }],
    behaviors: [{ _id: stableId("beh", `${name}-${x}-${y}`), name, type, system: sys, disabled: false }],
    visibility: 0, locked: false
  });

  const sceneDoc = (name, key, w, h, regions) => ({
    _id: stableId("scene", key), name, width: w, height: h, padding: 0.25,
    background: { src: `systems/pokemon-masters/assets/maps/${key}.webp` },
    backgroundColor: "#000000", grid: { type: 1, size: 100 },
    tokenVision: false, fog: { exploration: false },
    environment: { globalLight: { enabled: true }, darknessLevel: 0 },
    // Interiors have no wild encounters, so no encounter-region tag.
    flags: { "pokemon-masters": { region: "" } },
    regions
  });

  // Build one building-interior scene (counter service + exit door). `gym` carries
  // the leader metadata for a gym interior; the 3 service interiors are shared.
  const gymInteriors = new Map(); // leader name -> gym info (deduped)
  async function makeInterior(name, kind, gym) {
    const key = slug(name);
    await fs.writeFile(path.join(mapsDir, `${key}.svg`), interiorSvg(kind, name));
    const cx = INT_W / 2;
    const svc = kind === "center" ? { kind: "center", healOnEnter: true, announce: true }
      : kind === "gym" ? { kind: "gym", announce: true, leader: gym.leader, gymRegion: gym.region, gymIndex: gym.gymIndex, gymType: gym.type, badge: gym.badge }
      : { kind, announce: true };
    const regions = [
      region("Indoors", KIND_FILL.venue, 40, 130, INT_W - 80, INT_H - 200, "safeZone", { kind: "indoor", announce: false }),
      region("Counter", INT_TRIM[kind] ?? "#8a6a3a", cx - 260, 230, 520, 260, "safeZone", svc),
      region("Exit", "#ffd94a", cx - 100, INT_H - 160, 200, 160, "zoneTransit", { returnDoor: true, announce: false, destX: 0, destY: 0 }),
    ];
    return sceneDoc(name, key, INT_W, INT_H, regions);
  }

  const scenes = [];
  for (const map of allMaps()) {
    const w = map.w ?? 2400;
    const h = map.h ?? 1600;
    map.gym = map.kind === "town" ? (GYM_BY_CITY.get(map.name) ?? null) : null;
    await fs.writeFile(path.join(mapsDir, `${map.key}.svg`), mapSvg(map));
    const regions = [];
    if (map.kind === "town") {
      // The building tiles are DOORS now — stepping on one walks you into the
      // building's interior (a separate scene). The interior's exit brings you
      // back to the town, just below the door.
      const door = (name, color, x, dest) => region(name, color, x, h / 2 - 120, 200, 200, "zoneTransit",
        { enterInterior: true, destinationSceneName: dest, destX: INT_W / 2, destY: INT_H - 320, announce: false });
      regions.push(region("Town", KIND_FILL.town, 120, 120, w - 240, h - 240, "safeZone", { kind: "town", announce: false }));
      regions.push(door("Poké Center", "#e0554f", w / 2 - 500, "Pokémon Center"));
      regions.push(door("Poké Mart", "#4f7fd0", w / 2 - 100, "Poké Mart"));
      regions.push(door("Police Station", "#2f5aa8", w / 2 + 220, "Police Station"));
      if (map.gym) {
        regions.push(door("Gym", "#7b2ff7", w / 2 + 520, `${map.gym.leader}'s Gym`));
        gymInteriors.set(map.gym.leader, map.gym);
      }
    } else if (map.habitat) {
      // A wild zone: its encounter category is the map's real habitat, never a
      // blanket default. Level band scales a little with the habitat's danger.
      const band = HABITAT_LEVELS[map.habitat] ?? [2, 12];
      regions.push(region("Wild Area", "rgba(0,0,0,0.1)", w * 0.10, h * 0.10, w * 0.80, h * 0.80, "wildTile", {
        category: map.habitat, chance: 25, poolSource: "requirements", announceOnly: true, minLevel: band[0], maxLevel: band[1]
      }));
    } else {
      // A venue with no habitat (lab, gate, resort, ship, academy…) is a safe
      // indoor area — it must NOT spawn wild grass Pokémon.
      regions.push(region("Indoors", KIND_FILL.venue, 120, 120, w - 240, h - 240, "safeZone", { kind: "indoor", announce: false }));
    }
    let shipIdx = 0;
    for (const ex of map.exits) {
      const [dw, dh] = DIMS[ex.to] ?? [2400, 1600];
      if (ex.ship) {
        const [rx, ry, rw, rh] = dockRect(w, h, shipIdx++);
        const [ex2, ey2] = dockEntry(dw, dh);
        regions.push(region(`Ship to ${ex.to}`, "#8a6d3b", rx, ry, rw, rh, "zoneTransit", {
          zoneName: `Ferry → ${ex.to}`, destinationSceneName: ex.to, destX: ex2, destY: ey2, announce: true, requiredItem: ex.ticket ?? ""
        }));
      } else {
        const [rx, ry, rw, rh] = edgeRect(ex.edge, w, h);
        const [ex2, ey2] = arriveEntry(ex.edge, dw, dh);
        regions.push(region(`To ${ex.to}`, "#ffd94a", rx, ry, rw, rh, "zoneTransit", {
          zoneName: ex.to, destinationSceneName: ex.to, destX: ex2, destY: ey2, announce: true
        }));
      }
    }
    scenes.push({
      _id: stableId("scene", map.key),
      name: map.name,
      width: w, height: h, padding: 0.25,
      background: { src: `systems/pokemon-masters/assets/maps/${map.key}.webp` },
      // A neutral ground colour so a scene is never pure black even if its
      // background is still loading.
      backgroundColor: "#000000",
      grid: { type: 1, size: 100 },
      // Overworld maps are fully visible — no token-vision fog (the #1 cause of a
      // "black scene"), full global light, day-time. (globalLight lives under
      // environment since v12; the old top-level boolean is dropped.)
      tokenVision: false,
      fog: { exploration: false },
      environment: { globalLight: { enabled: true }, darknessLevel: 0 },
      flags: { "pokemon-masters": { region: map.region } },
      regions
    });
  }

  // Building interiors: 3 shared service scenes (every town's doors point here)
  // plus one per gym (so each shows its own leader).
  for (const [nm, kind] of [["Pokémon Center", "center"], ["Poké Mart", "mart"], ["Police Station", "police"]]) {
    scenes.push(await makeInterior(nm, kind));
  }
  for (const gym of gymInteriors.values()) scenes.push(await makeInterior(`${gym.leader}'s Gym`, "gym", gym));

  // Surface any gym whose city isn't a town map (e.g. Alola trial sites) — those
  // leaders get no gym building placed, so the mismatch is visible, not silent.
  const townNames = new Set(scenes.filter((s) => s.regions?.some((r) => r.name === "Poké Center")).map((s) => s.name));
  for (const [city, gym] of GYM_BY_CITY) {
    if (!townNames.has(city)) console.warn(`Pokémon Masters | ${gym.leader}'s city "${city}" is not a town map — no gym placed.`);
  }
  return scenes;
}

/* -------------------------------------------- */
/*  Run                                          */
/* -------------------------------------------- */

async function main() {
  await fs.mkdir(SRC, { recursive: true });
  await fs.mkdir(OUT, { recursive: true });
  console.log(`Building Pokémon Masters packs (full National Dex${LIMIT !== Infinity ? `, limit ${LIMIT}` : ""})…`);
  await writePack("species", await buildSpecies());
  await writePack("moves", buildMoves());
  await writePack("abilities", buildAbilities());
  await writePack("gear", buildGear());
  await writePack("scenes", await buildScenes());
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
