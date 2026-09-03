/**
 * Pokémon Masters — individual variation rolled at acquisition.
 *
 * Gives each caught/hatched/spawned Pokémon its own gender, nature, IVs, ability,
 * and shiny status, so two Level-20 Wartortle are no longer identical. Applied to
 * a source's `system` object before the Actor is created. Pure (RNG-injectable).
 */

import { PM } from "./config.mjs";

const NATURES = Object.keys(PM.natures);

export function rollIvs(rng = Math.random) {
  const v = () => Math.floor(rng() * 32);
  return { hp: v(), atk: v(), def: v(), spa: v(), spd: v(), spe: v() };
}

export function rollGender(system, rng = Math.random) {
  if (system.genderless) return "";
  return rng() < (system.femaleRate ?? 0.5) ? "F" : "M";
}

export function rollNature(rng = Math.random) {
  return NATURES[Math.floor(rng() * NATURES.length)];
}

export function rollShiny(rng = Math.random) {
  return rng() < (PM.shinyRate ?? 1 / 4096);
}

/** A regular ability, chosen evenly (50/50 for two). Hidden Abilities don't
 *  appear from ordinary wild encounters, so they're not rolled here. */
export function rollAbility(system, rng = Math.random) {
  const abilities = system.abilities ?? [];
  if (!abilities.length) return system.ability ?? "";
  return abilities[Math.floor(rng() * abilities.length)];
}

/** Roll and apply gender/nature/IVs/ability/shiny onto a Pokémon system object. */
export function applyIndividuality(system, rng = Math.random) {
  if (!system) return system;
  system.gender = rollGender(system, rng);
  system.nature = rollNature(rng);
  system.ivs = rollIvs(rng);
  system.shiny = rollShiny(rng);
  system.ability = rollAbility(system, rng);
  return system;
}
