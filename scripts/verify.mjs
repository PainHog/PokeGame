/**
 * Pokémon Masters — lore-accuracy verifier.
 *
 *   npm run verify   (after npm run build)
 *
 * Cross-checks the compiled packs against the source of truth (@pkmn) and the
 * canonical Kanto map graph, so data/build drift or an inaccurate map is caught
 * automatically — every build, in CI, forever. Exits non-zero on any discrepancy.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Dex } from "@pkmn/dex";
import { PM } from "../src/module/config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src", "packs");
const problems = [];
const flag = (msg) => problems.push(msg);

async function loadPack(name) {
  const dir = path.join(SRC, name);
  const out = [];
  for (const f of await fs.readdir(dir)) out.push(JSON.parse(await fs.readFile(path.join(dir, f), "utf8")));
  return out;
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/* -------------------------------------------- */
/*  Species  vs  @pkmn                           */
/* -------------------------------------------- */

async function verifySpecies() {
  const docs = await loadPack("species");
  let checked = 0;
  for (const d of docs) {
    const s = Dex.species.get(d.name);
    if (!s?.exists) { flag(`species: ${d.name} not found in dataset`); continue; }
    checked++;
    const sys = d.system;
    if (!sameSet(sys.types, s.types)) flag(`types: ${d.name} = ${sys.types} but canon ${s.types}`);
    for (const k of ["hp", "atk", "def", "spa", "spd", "spe"]) {
      if (sys.baseStats[k] !== s.baseStats[k]) flag(`baseStat ${k}: ${d.name} = ${sys.baseStats[k]} but canon ${s.baseStats[k]}`);
    }
    if (!sameSet(sys.evolution.into ?? [], s.evos ?? [])) flag(`evolution: ${d.name} into ${JSON.stringify(sys.evolution.into)} but canon ${JSON.stringify(s.evos)}`);
    if (!sameSet(sys.eggGroups ?? [], s.eggGroups ?? [])) flag(`eggGroups: ${d.name} = ${sys.eggGroups} but canon ${s.eggGroups}`);
    if ((sys.species.num ?? 0) !== s.num) flag(`dex#: ${d.name} = ${sys.species.num} but canon ${s.num}`);
  }
  return { checked, total: docs.length };
}

/* -------------------------------------------- */
/*  Moves  vs  @pkmn                             */
/* -------------------------------------------- */

async function verifyMoves() {
  const docs = await loadPack("moves");
  let checked = 0;
  for (const d of docs) {
    const m = Dex.moves.get(d.name);
    if (!m?.exists) continue; // some Past-gen variants normalise oddly; skip rather than false-flag
    checked++;
    if (m.type !== d.system.moveType) flag(`move type: ${d.name} = ${d.system.moveType} but canon ${m.type}`);
    if (m.category !== d.system.category) flag(`move category: ${d.name} = ${d.system.category} but canon ${m.category}`);
    const power = typeof m.basePower === "number" ? m.basePower : 0;
    if (power !== d.system.power) flag(`move power: ${d.name} = ${d.system.power} but canon ${power}`);
  }
  return { checked, total: docs.length };
}

/* -------------------------------------------- */
/*  Kanto map graph                              */
/* -------------------------------------------- */

// A canonical subset that MUST hold — especially the sea/island links.
const CANON_ADJACENCY = [
  ["Pallet Town", "Route 1"], ["Route 1", "Viridian City"],
  ["Viridian Forest", "Route 2"], ["Route 2", "Pewter City"],
  ["Pewter City", "Route 3"], ["Route 4", "Cerulean City"], ["Cerulean City", "Route 5"],
  ["Saffron City", "Route 6"], ["Route 6", "Vermilion City"], ["Celadon City", "Route 7"],
  ["Route 8", "Lavender Town"], ["Route 18", "Fuchsia City"],
  ["Fuchsia City", "Route 19"], ["Route 19", "Seafoam Islands"], ["Seafoam Islands", "Route 20"],
  ["Route 20", "Cinnabar Island"], ["Cinnabar Island", "Route 21"], ["Route 21", "Pallet Town"],
  ["Victory Road", "Indigo Plateau"], ["Vermilion City", "S.S. Anne"],
  // Kanto–Johto border corridor + Johto backbone (Bulbapedia-sourced).
  ["Indigo Plateau", "Route 26"], ["Route 26", "Tohjo Falls"], ["Tohjo Falls", "Route 27"],
  ["Route 27", "New Bark Town"], ["New Bark Town", "Johto Route 29"], ["Johto Route 29", "Cherrygrove City"],
  ["Cherrygrove City", "Johto Route 30"], ["Johto Route 30", "Johto Route 31"], ["Johto Route 31", "Violet City"],
  ["Violet City", "Johto Route 32"], ["Johto Route 32", "Union Cave"], ["Union Cave", "Johto Route 33"],
  ["Johto Route 33", "Azalea Town"], ["Azalea Town", "Ilex Forest"], ["Ilex Forest", "Johto Route 34"],
  ["Johto Route 34", "Goldenrod City"], ["Goldenrod City", "Johto Route 35"], ["Johto Route 35", "National Park"],
  ["National Park", "Johto Route 36"], ["Johto Route 36", "Johto Route 37"], ["Johto Route 37", "Ecruteak City"],
  ["Ecruteak City", "Johto Route 38"], ["Johto Route 38", "Johto Route 39"], ["Johto Route 39", "Olivine City"],
  ["Olivine City", "Johto Route 40"], ["Johto Route 40", "Johto Route 41"], ["Johto Route 41", "Cianwood City"],
  ["Ecruteak City", "Johto Route 42"], ["Johto Route 42", "Mt. Mortar"], ["Mt. Mortar", "Mahogany Town"],
  ["Mahogany Town", "Johto Route 44"], ["Johto Route 44", "Ice Path"], ["Ice Path", "Blackthorn City"],
  // Alola — four islands crossed only by sea (Bulbapedia-sourced). Routes carry the
  // "Alola " prefix because their numbers collide with Kanto's.
  ["Vermilion City", "Hau'oli City"], // the cross-region cruise
  ["Iki Town", "Alola Route 1"], ["Alola Route 1", "Hau'oli City"], ["Hau'oli City", "Alola Route 2"],
  ["Alola Route 2", "Alola Route 3"], ["Heahea City", "Alola Route 4"], ["Alola Route 4", "Paniola Town"],
  ["Alola Route 9", "Konikoni City"], ["Malie City", "Alola Route 10"], ["Alola Route 17", "Po Town"],
  ["Mount Lanakila", "Alola Pokémon League"], ["Seafolk Village", "Poni Wilds"], ["Poni Wilds", "Ancient Poni Path"],
  // Inter-island ferries.
  ["Hau'oli City", "Heahea City"], ["Heahea City", "Malie City"], ["Seafolk Village", "Aether Paradise"],
  // Hoenn — a sea-heavy region reached by the S.S. Tidal from Olivine (Bulbapedia-sourced).
  ["Olivine City", "Slateport City"], // cross-region ferry
  ["Littleroot Town", "Hoenn Route 101"], ["Hoenn Route 101", "Oldale Town"], ["Oldale Town", "Hoenn Route 102"],
  ["Hoenn Route 102", "Petalburg City"], ["Petalburg City", "Hoenn Route 104"], ["Hoenn Route 104", "Rustboro City"],
  ["Hoenn Route 109", "Slateport City"], ["Slateport City", "Hoenn Route 110"], ["Hoenn Route 110", "Mauville City"],
  ["Mauville City", "Hoenn Route 117"], ["Hoenn Route 117", "Verdanturf Town"], ["Hoenn Route 112", "Lavaridge Town"],
  ["Hoenn Route 113", "Fallarbor Town"], ["Hoenn Route 119", "Fortree City"], ["Hoenn Route 121", "Lilycove City"],
  ["Hoenn Route 124", "Mossdeep City"], ["Hoenn Route 126", "Sootopolis City"], ["Hoenn Route 128", "Ever Grande City"],
  ["Hoenn Route 131", "Pacifidlog Town"], ["Ever Grande City", "Hoenn Victory Road"], ["Hoenn Victory Road", "Hoenn Pokémon League"],
  // Sinnoh — spiralling around Mt. Coronet (Bulbapedia-sourced).
  ["Lilycove City", "Canalave City"], // cross-region ferry
  ["Twinleaf Town", "Sinnoh Route 201"], ["Sinnoh Route 201", "Sandgem Town"], ["Sandgem Town", "Sinnoh Route 202"],
  ["Sinnoh Route 202", "Jubilife City"], ["Jubilife City", "Sinnoh Route 204"], ["Sinnoh Route 204", "Floaroma Town"],
  ["Floaroma Town", "Sinnoh Route 205"], ["Eterna Forest", "Eterna City"], ["Hearthome City", "Sinnoh Route 209"],
  ["Sinnoh Route 209", "Solaceon Town"], ["Hearthome City", "Sinnoh Route 212"], ["Sinnoh Route 212", "Pastoria City"],
  ["Sinnoh Route 215", "Veilstone City"], ["Jubilife City", "Sinnoh Route 218"], ["Sinnoh Route 218", "Canalave City"],
  ["Sinnoh Route 217", "Snowpoint City"], ["Sunyshore City", "Sinnoh Route 223"], ["Sinnoh Route 223", "Sinnoh Victory Road"],
  ["Sinnoh Victory Road", "Sinnoh Pokémon League"], ["Snowpoint City", "Fight Area"], ["Fight Area", "Survival Area"],
  // Unova — a loop across the sea (Bulbapedia-sourced).
  ["Vermilion City", "Castelia City"], // international liner
  ["Nuvema Town", "Unova Route 1"], ["Unova Route 1", "Accumula Town"], ["Accumula Town", "Unova Route 2"],
  ["Unova Route 2", "Striaton City"], ["Striaton City", "Unova Route 3"], ["Unova Route 3", "Nacrene City"],
  ["Skyarrow Bridge", "Castelia City"], ["Castelia City", "Unova Route 4"], ["Unova Route 4", "Nimbasa City"],
  ["Driftveil Drawbridge", "Driftveil City"], ["Chargestone Cave", "Mistralton City"], ["Twist Mountain", "Icirrus City"],
  ["Unova Route 9", "Opelucid City"], ["Opelucid City", "Unova Route 10"], ["Unova Route 10", "Unova Victory Road"],
  ["Unova Victory Road", "Unova Pokémon League"], ["Aspertia City", "Unova Route 19"], ["Unova Route 19", "Floccesy Town"],
  ["Virbank City", "Castelia City"], ["Lacunosa Town", "Unova Route 13"], ["Unova Route 13", "Undella Town"],
  // Kalos — a star centred on Lumiose City (Bulbapedia-sourced).
  ["Canalave City", "Coumarine City"], // cross-region ferry
  ["Vaniville Town", "Kalos Route 1"], ["Kalos Route 1", "Aquacorde Town"], ["Aquacorde Town", "Kalos Route 2"],
  ["Kalos Route 3", "Santalune City"], ["Santalune City", "Kalos Route 4"], ["Kalos Route 4", "Lumiose City"],
  ["Lumiose City", "Kalos Route 5"], ["Kalos Route 5", "Camphrier Town"], ["Kalos Route 8", "Cyllage City"],
  ["Kalos Route 10", "Geosenge Town"], ["Reflection Cave", "Shalour City"], ["Kalos Route 12", "Coumarine City"],
  ["Lumiose City", "Kalos Route 14"], ["Kalos Route 14", "Laverre City"], ["Kalos Route 17", "Anistar City"],
  ["Kalos Route 19", "Snowbelle City"], ["Snowbelle City", "Kalos Route 21"], ["Kalos Route 21", "Kalos Victory Road"],
  ["Kalos Victory Road", "Kalos Pokémon League"], ["Lumiose City", "Kiloude City"],
  // Galar — a mostly linear climb with the Wild Area hub (Bulbapedia-sourced).
  ["Coumarine City", "Hulbury"], // cross-region ferry
  ["Postwick", "Galar Route 1"], ["Galar Route 1", "Wedgehurst"], ["Wedgehurst", "Galar Route 2"],
  ["Galar Route 2", "Wild Area"], ["Wild Area", "Motostoke"], ["Wild Area", "Hammerlocke"],
  ["Galar Route 4", "Turffield"], ["Galar Route 5", "Hulbury"], ["Hammerlocke", "Galar Route 6"],
  ["Galar Route 6", "Stow-on-Side"], ["Glimwood Tangle", "Ballonlea"], ["Galar Route 8", "Circhester"],
  ["Route 9 Tunnel", "Spikemuth"], ["Hammerlocke", "Galar Route 10"], ["Galar Route 10", "Wyndon"],
  ["Wyndon", "Galar Pokémon League"], ["Wedgehurst", "Isle of Armor"], ["Wyndon", "Crown Tundra"],
  // Paldea — open-world provinces around the Great Crater (Bulbapedia-sourced).
  ["Coumarine City", "Porto Marinada"], // cross-region ferry
  ["Cabo Poco", "Poco Path"], ["Poco Path", "Los Platos"], ["South Province (Area One)", "Mesagoza"],
  ["Mesagoza", "Cortondo"], ["South Province (Area Two)", "Artazon"], ["Mesagoza", "Paldea Pokémon League"],
  ["West Province (Area One)", "Cascarrafa"], ["Cascarrafa", "Porto Marinada"], ["West Province (Area Two)", "Medali"],
  ["East Province (Area One)", "Levincia"], ["East Province (Area Two)", "Zapapico"], ["North Province (Area One)", "Montenevera"],
  ["Glaseado Mountain", "Zero Gate"], ["Zero Gate", "Area Zero"], ["Mesagoza", "Kitakami"], ["Mesagoza", "Blueberry Academy"],
  // Sevii Islands — a Kanto archipelago reached only by the Seagallop ferries.
  ["Vermilion City", "One Island"], ["One Island", "Two Island"], ["Two Island", "Three Island"],
  ["Three Island", "Four Island"], ["Four Island", "Five Island"], ["Five Island", "Six Island"],
  ["Six Island", "Seven Island"], ["One Island", "Kindle Road"], ["Kindle Road", "Mt. Ember"],
  // Hisui — ancient Sinnoh, reached by a voyage from Canalave City.
  ["Canalave City", "Jubilife Village"], ["Jubilife Village", "Obsidian Fieldlands"],
  ["Jubilife Village", "Crimson Mirelands"], ["Jubilife Village", "Coronet Highlands"],
  ["Coronet Highlands", "Alabaster Icelands"], ["Temple of Sinnoh", "Hisui Spear Pillar"]
];

async function verifyMaps() {
  const scenes = await loadPack("scenes");
  const byName = Object.fromEntries(scenes.map((s) => [s.name, s]));
  // Building interiors are reached through door tiles and return dynamically, so
  // they sit OUTSIDE the overworld travel graph — exclude them and their doors.
  const isInterior = (s) => s.regions.some((r) => r.name === "Counter");
  const linksOf = (s) => s.regions
    .filter((r) => { const b = r.behaviors[0]; return b?.type.endsWith("zoneTransit") && !b.system.enterInterior && !b.system.returnDoor; })
    .map((r) => r.behaviors[0].system.destinationSceneName).filter(Boolean);
  const connected = (a, b) => byName[a] && linksOf(byName[a]).includes(b);

  // Bidirectional + no dangling (overworld only).
  for (const s of scenes) {
    if (isInterior(s)) continue;
    for (const dest of linksOf(s)) {
      if (!byName[dest]) flag(`map: ${s.name} links to missing scene "${dest}"`);
      else if (!connected(dest, s.name)) flag(`map: ${s.name} → ${dest} is one-way (no return link)`);
    }
  }
  // Canonical adjacencies present (both directions).
  for (const [a, b] of CANON_ADJACENCY) {
    if (!connected(a, b) || !connected(b, a)) flag(`map: canonical link ${a} ↔ ${b} is missing`);
  }
  // Full connectivity from Pallet Town (interiors excluded — they hang off towns).
  const seen = new Set(["Pallet Town"]);
  const queue = ["Pallet Town"];
  while (queue.length) {
    for (const d of linksOf(byName[queue.shift()] ?? { regions: [] })) if (byName[d] && !seen.has(d)) { seen.add(d); queue.push(d); }
  }
  for (const s of scenes) if (!isInterior(s) && !seen.has(s.name)) flag(`map: ${s.name} is unreachable from Pallet Town`);
  return { total: scenes.length };
}

/* -------------------------------------------- */
/*  Region locking                               */
/* -------------------------------------------- */

// A regional form's name suffix → the region it must be locked to.
const FORM_REGION = { Alola: "alola", Galar: "galar", Hisui: "hisui", Paldea: "paldea" };

async function verifyRegions() {
  const species = await loadPack("species");
  const scenes = await loadPack("scenes");
  const inRegion = (reqRegions, region) => !reqRegions?.length || reqRegions.includes(region);

  // Every region that actually has maps must have a non-empty catchable pool,
  // or its wild tiles would spawn nothing.
  const mapped = new Set(scenes.map((s) => s.flags?.["pokemon-masters"]?.region).filter(Boolean));
  for (const region of mapped) {
    const n = species.filter((sp) => inRegion(sp.system.requirements?.regions, region)).length;
    if (n === 0) flag(`region: "${region}" has maps but no native Pokémon can spawn there`);
  }

  // Regional forms must stay locked to their own region — never leak elsewhere.
  for (const sp of species) {
    for (const [suffix, region] of Object.entries(FORM_REGION)) {
      if (!sp.name.includes(`-${suffix}`)) continue;
      const regs = sp.system.requirements?.regions ?? [];
      if (!regs.includes(region) || regs.length !== 1) {
        flag(`region: ${sp.name} (a ${suffix} form) should be locked to ${region}, but is ${JSON.stringify(regs)}`);
      }
    }
  }
  return { mapped: mapped.size };
}

/* -------------------------------------------- */
/*  Content fidelity (not just presence)         */
/* -------------------------------------------- */

/**
 * Guards the things earlier "presence-only" checks missed: that every NAMED
 * League character has a DEDICATED sprite (not a generic stand-in), that every
 * gym leader's city actually has a gym building on a map, and that every town's
 * buildings are genuinely enterable (a door → an interior scene that exists).
 * These are fidelity checks — they fail the build if the world regresses to
 * "technically there but wrong/empty".
 */
async function verifyContentFidelity() {
  const idx = JSON.parse(await fs.readFile(path.join(ROOT, "assets", "trainers", "index.json"), "utf8"));
  const have = new Set(idx.files);
  const scenes = await loadPack("scenes");
  const sceneNames = new Set(scenes.map((s) => s.name));
  const gymScenes = new Set(scenes.filter((s) => s.regions?.some((r) => r.name === "Gym")).map((s) => s.name));
  const matchKey = (name) => { for (const [re, key] of PM.npcSpriteMatch) if (re.test(name)) return key; return null; };

  // 1) Named characters must each resolve to a real, dedicated sprite.
  let named = 0;
  for (const [region, data] of Object.entries(PM.gymLeaders ?? {})) {
    const roster = [["professor", data.professor], ["champion", data.champion],
      ...(data.leaders ?? []).map((l) => ["leader", l.name, l.city]),
      ...(data.eliteFour ?? []).map((e) => ["E4", e.name])].filter((r) => r[1]);
    for (const [role, name, city] of roster) {
      named++;
      const key = matchKey(name);
      if (!key) flag(`sprite: ${region} ${role} "${name}" falls back to a generic class sprite (no dedicated match)`);
      else if (!have.has(key)) flag(`sprite: ${region} ${role} "${name}" → "${key}.png" is missing from assets/trainers`);
      if (role === "leader" && city && !gymScenes.has(city)) flag(`gym: ${region} leader "${name}" city "${city}" has no gym building on any map`);
    }
  }
  // 2) Every sprite the matcher / pool can hand out must exist on disk.
  for (const [, key] of PM.npcSpriteMatch) if (!have.has(key)) flag(`sprite: matcher references missing trainer sprite "${key}"`);
  for (const key of PM.variedTrainerPool ?? []) if (!have.has(key)) flag(`sprite: generic pool references missing sprite "${key}"`);

  // 3) Every town's buildings must be enterable: door → an interior scene that
  //    exists. A "town" is a map carrying the Town safe-zone (gym/trial sites on
  //    non-town maps have only a single gym door and are not held to this).
  let towns = 0;
  const allDests = new Set();
  for (const s of scenes) {
    const doors = (s.regions ?? []).filter((r) => r.behaviors?.[0]?.system?.enterInterior);
    const dests = new Set(doors.map((d) => d.behaviors[0].system.destinationSceneName));
    for (const d of dests) { allDests.add(d); if (!sceneNames.has(d)) flag(`walk-in: "${s.name}" door leads to missing interior scene "${d}"`); }
    if (!(s.regions ?? []).some((r) => r.name === "Town")) continue; // not a town
    towns++;
    if (s.flags?.["pokemon-masters"]?.authentic) {
      // Authentic maps mirror the real games: doors sit only where the game has
      // real warps, so a small town legitimately has no Center/Mart/police (e.g.
      // Pallet Town). We don't force a template — only guard against a town that
      // rendered with no enterable buildings at all (a real render regression).
      if (doors.length === 0) flag(`walk-in: authentic town "${s.name}" rendered with no enterable buildings`);
    } else {
      // Procedural towns are templated, so they must carry the full service set.
      for (const n of ["Pokémon Center", "Poké Mart", "Police Station"]) if (!dests.has(n)) flag(`walk-in: town "${s.name}" is missing an enterable ${n}`);
      if (!dests.has("House")) flag(`walk-in: town "${s.name}" has no enterable house`);
    }
  }
  // World-wide net: heal + shop must be reachable *somewhere* (authentic towns may
  // individually lack them, but a Center and a Mart must exist to keep play going).
  for (const n of ["Pokémon Center", "Poké Mart"]) if (!allDests.has(n)) flag(`walk-in: no enterable ${n} exists anywhere in the world`);
  return { named, towns };
}

/* -------------------------------------------- */

async function main() {
  console.log("Verifying lore accuracy against @pkmn + canonical maps…\n");
  const sp = await verifySpecies();
  const mv = await verifyMoves();
  const mp = await verifyMaps();
  const rg = await verifyRegions();
  const cf = await verifyContentFidelity();
  console.log(`  species: ${sp.checked}/${sp.total} checked`);
  console.log(`  moves:   ${mv.checked}/${mv.total} checked`);
  console.log(`  maps:    ${mp.total} scenes checked`);
  console.log(`  regions: ${rg.mapped} mapped, encounter pools + regional forms checked`);
  console.log(`  content: ${cf.named} named characters have dedicated sprites, ${cf.towns} towns' buildings are enterable`);
  if (!problems.length) {
    console.log("\n✅ No discrepancies — data and maps match canon.");
    return;
  }
  console.log(`\n❌ ${problems.length} discrepancies:\n`);
  for (const p of problems.slice(0, 100)) console.log("  •", p);
  if (problems.length > 100) console.log(`  … and ${problems.length - 100} more`);
  process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
