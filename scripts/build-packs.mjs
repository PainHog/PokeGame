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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Dex } from "@pkmn/dex";
import { Sprites } from "@pkmn/img";
import { compilePack } from "@foundryvtt/foundryvtt-cli";

/** Animated Pokémon Showdown sprite URL for a species (loaded by the Foundry client). */
function spriteFor(name) {
  try { return Sprites.getPokemon(name, { gen: "ani" }).url; }
  catch { return "icons/svg/mystery-man.svg"; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
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
 * context satisfies EVERY non-empty axis. Sensible, tunable defaults:
 *  - habitats: the union of its types' habitats (bugs → forest, etc.).
 *  - regions:  variant → its region; legendary/very-rare → its native region;
 *              everything else → any region (empty).
 *  - methods:  water-types are surf/fishing; everyone else walks.
 */
function deriveRequirements(s, rarity, nativeReg, varReg) {
  const habitats = [...new Set((s.types || []).flatMap((t) => TYPE_HABITATS[t] || []))];
  const isWater = (s.types || []).includes("Water");
  const methods = isWater ? ["surf", "fishing"] : ["walk"];
  let regions = [];
  if (varReg) regions = [varReg];
  else if ((rarity === "legendary" || rarity === "veryrare") && nativeReg) regions = [nativeReg];
  return { habitats, regions, methods, times: [] };
}

const BALL_MODIFIERS = {
  "poke ball": 1, "great ball": 1.5, "ultra ball": 2, "master ball": 255,
  "net ball": 3.5, "dive ball": 3.5, "nest ball": 4, "repeat ball": 3.5,
  "timer ball": 4, "dusk ball": 3, "quick ball": 5, "heal ball": 1, "luxury ball": 1,
  "premier ball": 1
};

async function writePack(name, docs) {
  const dir = path.join(SRC, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  for (const doc of docs) {
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

    const sprite = spriteFor(s.name);
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
        price: 0,
        quantity: 1,
        catchModifier: isBall ? (BALL_MODIFIERS[lower] ?? 1) : 1,
        description: it.desc || it.shortDesc || ""
      }
    });
  }
  return docs;
}

/* -------------------------------------------- */
/*  Scenes  ->  a ready-to-play test map         */
/* -------------------------------------------- */

const MAP_W = 2400;
const MAP_H = 1600;

/** A small connected Kanto slice. Each map is its own Scene, linked by edge exits. */
const MAPS = [
  { key: "pallet", name: "Pallet Town", kind: "town", region: "kanto", exits: [{ edge: "north", to: "Route 1" }] },
  { key: "route1", name: "Route 1", kind: "route", region: "kanto", habitat: "grass", exits: [{ edge: "south", to: "Pallet Town" }, { edge: "north", to: "Viridian City" }] },
  { key: "viridian", name: "Viridian City", kind: "town", region: "kanto", exits: [{ edge: "south", to: "Route 1" }, { edge: "north", to: "Viridian Forest" }] },
  { key: "vforest", name: "Viridian Forest", kind: "forest", region: "kanto", habitat: "forest", exits: [{ edge: "south", to: "Viridian City" }, { edge: "north", to: "Pewter City" }] },
  { key: "pewter", name: "Pewter City", kind: "town", region: "kanto", exits: [{ edge: "south", to: "Viridian Forest" }] }
];

const KIND_FILL = { town: "#cdbd8f", route: "#8ec98e", forest: "#3f7a3f", cave: "#5a5560", ocean: "#4a86c5" };
const EDGE_RECT = {
  north: [MAP_W / 2 - 150, 0, 300, 120], south: [MAP_W / 2 - 150, MAP_H - 120, 300, 120],
  east: [MAP_W - 120, MAP_H / 2 - 150, 120, 300], west: [0, MAP_H / 2 - 150, 120, 300]
};
// Where you land on the DESTINATION, arriving from a given exit edge (opposite side, clear of its return exit).
const ARRIVE_ENTRY = { north: [MAP_W / 2, MAP_H - 300], south: [MAP_W / 2, 300], east: [300, MAP_H / 2], west: [MAP_W - 300, MAP_H / 2] };
const EDGE_LABEL_POS = {
  north: [MAP_W / 2, 150], south: [MAP_W / 2, MAP_H - 140], east: [MAP_W - 180, MAP_H / 2], west: [180, MAP_H / 2]
};

function mapSvg(map) {
  const fill = KIND_FILL[map.kind] ?? "#8ec98e";
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${MAP_W}" height="${MAP_H}" viewBox="0 0 ${MAP_W} ${MAP_H}">`];
  parts.push(`<rect width="${MAP_W}" height="${MAP_H}" fill="${fill}"/>`);
  if (map.kind === "town") {
    parts.push(`<rect x="${MAP_W / 2 - 500}" y="${MAP_H / 2 - 120}" width="200" height="200" rx="10" fill="#f0f0f0" stroke="#ccc" stroke-width="4"/><rect x="${MAP_W / 2 - 500}" y="${MAP_H / 2 - 120}" width="200" height="64" fill="#e0554f"/><text x="${MAP_W / 2 - 400}" y="${MAP_H / 2 + 130}" font-family="Arial" font-size="26" fill="#444" text-anchor="middle">Center</text>`);
    parts.push(`<rect x="${MAP_W / 2 - 100}" y="${MAP_H / 2 - 120}" width="200" height="200" rx="10" fill="#f0f0f0" stroke="#ccc" stroke-width="4"/><rect x="${MAP_W / 2 - 100}" y="${MAP_H / 2 - 120}" width="200" height="64" fill="#4f7fd0"/><text x="${MAP_W / 2}" y="${MAP_H / 2 + 130}" font-family="Arial" font-size="26" fill="#444" text-anchor="middle">Mart</text>`);
  } else {
    // A wild patch cue.
    parts.push(`<rect x="400" y="400" width="${MAP_W - 800}" height="${MAP_H - 800}" rx="20" fill="rgba(0,0,0,0.08)"/>`);
  }
  parts.push(`<text x="${MAP_W / 2}" y="70" font-family="Arial" font-size="52" font-weight="bold" fill="#333" text-anchor="middle">${map.name}</text>`);
  for (const ex of map.exits) {
    const [lx, ly] = EDGE_LABEL_POS[ex.edge];
    parts.push(`<text x="${lx}" y="${ly}" font-family="Arial" font-size="30" font-weight="bold" fill="#1c3c5c" text-anchor="middle">▲ ${ex.to}</text>`);
  }
  parts.push("</svg>");
  return parts.join("\n");
}

async function buildScenes() {
  const mapsDir = path.join(ROOT, "assets", "maps");
  await fs.mkdir(mapsDir, { recursive: true });

  const region = (name, color, x, y, w, h, type, sys) => ({
    _id: stableId("region", `${name}-${x}-${y}`),
    name, color,
    shapes: [{ type: "rectangle", x, y, width: w, height: h, rotation: 0, hole: false }],
    behaviors: [{ _id: stableId("beh", `${name}-${x}-${y}`), name, type: `pokemon-masters.${type}`, system: sys, disabled: false }],
    visibility: 0, locked: false
  });

  const scenes = [];
  for (const map of MAPS) {
    await fs.writeFile(path.join(mapsDir, `${map.key}.svg`), mapSvg(map));
    const regions = [];
    if (map.kind === "town") {
      regions.push(region("Town", KIND_FILL.town, 160, 160, MAP_W - 320, MAP_H - 320, "safeZone", { kind: "town", announce: false }));
      regions.push(region("Poké Center", "#e0554f", MAP_W / 2 - 500, MAP_H / 2 - 120, 200, 200, "safeZone", { kind: "center", healOnEnter: true }));
      regions.push(region("Poké Mart", "#4f7fd0", MAP_W / 2 - 100, MAP_H / 2 - 120, 200, 200, "safeZone", { kind: "mart" }));
    } else {
      regions.push(region("Wild Area", "rgba(0,0,0,0.1)", 300, 300, MAP_W - 600, MAP_H - 600, "wildTile", {
        category: map.habitat ?? "grass", chance: 25, poolSource: "requirements", announceOnly: true, minLevel: 2, maxLevel: 8
      }));
    }
    for (const ex of map.exits) {
      const [rx, ry, rw, rh] = EDGE_RECT[ex.edge];
      const [ex2, ey2] = ARRIVE_ENTRY[ex.edge];
      regions.push(region(`To ${ex.to}`, "#ffd94a", rx, ry, rw, rh, "zoneTransit", {
        zoneName: ex.to, destinationSceneName: ex.to, destX: ex2, destY: ey2, announce: true
      }));
    }
    scenes.push({
      _id: stableId("scene", map.key),
      name: map.name,
      width: MAP_W, height: MAP_H, padding: 0.25,
      background: { src: `systems/pokemon-masters/assets/maps/${map.key}.svg` },
      grid: { type: 1, size: 100 },
      flags: { "pokemon-masters": { region: map.region } },
      regions
    });
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
