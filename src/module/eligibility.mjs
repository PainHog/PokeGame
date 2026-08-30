/**
 * Pokémon Masters — encounter eligibility.
 *
 * A species may only roll on a tile when EVERY non-empty requirement axis is
 * satisfied by the tile context: habitat (the tile category), region (the
 * scene's region tag), method (walk/surf/fishing), and time of day. An empty
 * axis on the species means "no restriction on that axis".
 *
 * The species pool is read once from the compendium *index* (with requirement
 * fields), so filtering is fast and never loads 1300+ full documents per step.
 */

import { PM } from "./config.mjs";

const INDEX_FIELDS = [
  "system.rarity",
  "system.requirements",
  "system.types",
  "system.nativeRegion",
  "system.variantRegion"
];

let _cache = null;

/** Load (and cache) the species index with the fields eligibility needs. */
export async function getSpeciesIndex() {
  if (_cache) return _cache;
  const pack = game.packs.get("pokemon-masters.species");
  if (!pack) return [];
  _cache = await pack.getIndex({ fields: INDEX_FIELDS });
  return _cache;
}

/** Drop the cache (call if species requirements are edited at runtime). */
export function clearEligibilityCache() { _cache = null; }

/** The habitat/method a tile category implies. */
export function methodForCategory(category) {
  if (category === "fishing") return "fishing";
  if (category === "water") return "surf";
  return "walk";
}

/** Pure predicate: does `requirements` allow this context? Exported for testing. */
export function matchesContext(requirements = {}, { habitat, region, method, time } = {}) {
  const r = requirements ?? {};
  const axis = (allowed, value) => !allowed?.length || (value && allowed.includes(value));
  return axis(r.habitats, habitat)
    && axis(r.regions, region)
    && axis(r.methods, method)
    && axis(r.times, time);
}

/** Relative encounter weight per rarity (rarer → far less common). */
const RARITY_WEIGHT = { common: 100, uncommon: 45, rare: 15, veryrare: 5, legendary: 1 };

/**
 * All species eligible for a tile context, each with a rarity-derived weight.
 * @returns {Promise<Array<{name:string, rarity:string, weight:number}>>}
 */
export async function eligibleSpecies({ habitat, region = "", method = "walk", time = "" } = {}) {
  const index = await getSpeciesIndex();
  const out = [];
  for (const entry of index) {
    const sys = entry.system ?? {};
    if (!matchesContext(sys.requirements, { habitat, region, method, time })) continue;
    out.push({ name: entry.name, rarity: sys.rarity ?? "common", weight: RARITY_WEIGHT[sys.rarity] ?? 50 });
  }
  return out;
}
