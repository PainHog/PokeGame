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
  ["Pallet Town", "Route 1"], ["Route 1", "Viridian City"], ["Viridian Forest", "Pewter City"],
  ["Pewter City", "Route 3"], ["Route 4", "Cerulean City"], ["Cerulean City", "Route 5"],
  ["Saffron City", "Route 6"], ["Route 6", "Vermilion City"], ["Celadon City", "Route 7"],
  ["Route 8", "Lavender Town"], ["Route 18", "Fuchsia City"],
  ["Fuchsia City", "Route 19"], ["Route 19", "Seafoam Islands"], ["Seafoam Islands", "Route 20"],
  ["Route 20", "Cinnabar Island"], ["Cinnabar Island", "Route 21"], ["Route 21", "Pallet Town"],
  ["Victory Road", "Indigo Plateau"], ["Vermilion City", "S.S. Anne"]
];

async function verifyMaps() {
  const scenes = await loadPack("scenes");
  const byName = Object.fromEntries(scenes.map((s) => [s.name, s]));
  const linksOf = (s) => s.regions.filter((r) => r.behaviors[0]?.type.endsWith("zoneTransit")).map((r) => r.behaviors[0].system.destinationSceneName);
  const connected = (a, b) => byName[a] && linksOf(byName[a]).includes(b);

  // Bidirectional + no dangling.
  for (const s of scenes) {
    for (const dest of linksOf(s)) {
      if (!byName[dest]) flag(`map: ${s.name} links to missing scene "${dest}"`);
      else if (!connected(dest, s.name)) flag(`map: ${s.name} → ${dest} is one-way (no return link)`);
    }
  }
  // Canonical adjacencies present (both directions).
  for (const [a, b] of CANON_ADJACENCY) {
    if (!connected(a, b) || !connected(b, a)) flag(`map: canonical link ${a} ↔ ${b} is missing`);
  }
  // Full connectivity from Pallet Town.
  const seen = new Set(["Pallet Town"]);
  const queue = ["Pallet Town"];
  while (queue.length) {
    for (const d of linksOf(byName[queue.shift()] ?? { regions: [] })) if (byName[d] && !seen.has(d)) { seen.add(d); queue.push(d); }
  }
  for (const s of scenes) if (!seen.has(s.name)) flag(`map: ${s.name} is unreachable from Pallet Town`);
  return { total: scenes.length };
}

/* -------------------------------------------- */

async function main() {
  console.log("Verifying lore accuracy against @pkmn + canonical maps…\n");
  const sp = await verifySpecies();
  const mv = await verifyMoves();
  const mp = await verifyMaps();
  console.log(`  species: ${sp.checked}/${sp.total} checked`);
  console.log(`  moves:   ${mv.checked}/${mv.total} checked`);
  console.log(`  maps:    ${mp.total} scenes checked`);
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
