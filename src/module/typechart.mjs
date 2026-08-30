/**
 * Pokémon Masters — type effectiveness chart (Gen 6+).
 *
 * `two` / `half` / `zero` list the defending types an attacking type is
 * super-effective / not-very-effective / immune against. Anything unlisted is 1×.
 * Verified cell-for-cell against the @pkmn dataset at build time (see
 * scripts — the chart test), so this stays canonical without a runtime data load.
 */

export const TYPE_CHART = {
  Normal:   { half: ["Rock", "Steel"], zero: ["Ghost"] },
  Fire:     { two: ["Grass", "Ice", "Bug", "Steel"], half: ["Fire", "Water", "Rock", "Dragon"] },
  Water:    { two: ["Fire", "Ground", "Rock"], half: ["Water", "Grass", "Dragon"] },
  Electric: { two: ["Water", "Flying"], half: ["Electric", "Grass", "Dragon"], zero: ["Ground"] },
  Grass:    { two: ["Water", "Ground", "Rock"], half: ["Fire", "Grass", "Poison", "Flying", "Bug", "Dragon", "Steel"] },
  Ice:      { two: ["Grass", "Ground", "Flying", "Dragon"], half: ["Fire", "Water", "Ice", "Steel"] },
  Fighting: { two: ["Normal", "Ice", "Rock", "Dark", "Steel"], half: ["Poison", "Flying", "Psychic", "Bug", "Fairy"], zero: ["Ghost"] },
  Poison:   { two: ["Grass", "Fairy"], half: ["Poison", "Ground", "Rock", "Ghost"], zero: ["Steel"] },
  Ground:   { two: ["Fire", "Electric", "Poison", "Rock", "Steel"], half: ["Grass", "Bug"], zero: ["Flying"] },
  Flying:   { two: ["Grass", "Fighting", "Bug"], half: ["Electric", "Rock", "Steel"] },
  Psychic:  { two: ["Fighting", "Poison"], half: ["Psychic", "Steel"], zero: ["Dark"] },
  Bug:      { two: ["Grass", "Psychic", "Dark"], half: ["Fire", "Fighting", "Poison", "Flying", "Ghost", "Steel", "Fairy"] },
  Rock:     { two: ["Fire", "Ice", "Flying", "Bug"], half: ["Fighting", "Ground", "Steel"] },
  Ghost:    { two: ["Psychic", "Ghost"], half: ["Dark"], zero: ["Normal"] },
  Dragon:   { two: ["Dragon"], half: ["Steel"], zero: ["Fairy"] },
  Dark:     { two: ["Psychic", "Ghost"], half: ["Fighting", "Dark", "Fairy"] },
  Steel:    { two: ["Ice", "Rock", "Fairy"], half: ["Fire", "Water", "Electric", "Steel"] },
  Fairy:    { two: ["Fighting", "Dragon", "Dark"], half: ["Fire", "Poison", "Steel"] }
};

/** Combined multiplier of an attacking type against one or two defending types. */
export function typeMultiplier(attackType, defendTypes = []) {
  const row = TYPE_CHART[attackType];
  if (!row) return 1;
  let mult = 1;
  for (const d of defendTypes) {
    if (row.zero?.includes(d)) return 0;
    if (row.two?.includes(d)) mult *= 2;
    else if (row.half?.includes(d)) mult *= 0.5;
  }
  return mult;
}

/** Human-readable effectiveness note for chat cards. */
export function effectivenessLabel(mult) {
  if (mult === 0) return "It doesn't affect the target…";
  if (mult >= 2) return "It's super effective!";
  if (mult > 0 && mult < 1) return "It's not very effective…";
  return "";
}
