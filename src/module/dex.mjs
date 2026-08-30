/**
 * Pokémon Masters — living Pokédex tracker.
 *
 * Records the species a trainer has seen (encountered) and caught. Regional
 * forms count as their own entries; the target is the 1025 unique National Dex
 * numbers. Powers completion goals and Researcher/Professor payouts.
 */

const TOTAL_DEX = 1025;

export async function markSeen(trainer, name) {
  if (trainer?.type !== "trainer" || !name) return;
  const seen = new Set(trainer.system.pokedex?.seen ?? []);
  if (seen.has(name)) return;
  seen.add(name);
  await trainer.update({ "system.pokedex.seen": [...seen] });
}

export async function markCaught(trainer, name) {
  if (trainer?.type !== "trainer" || !name) return;
  const p = trainer.system.pokedex ?? { seen: [], caught: [] };
  const seen = new Set(p.seen);
  const caught = new Set(p.caught);
  if (caught.has(name)) return;
  seen.add(name);
  caught.add(name);
  await trainer.update({ "system.pokedex.seen": [...seen], "system.pokedex.caught": [...caught] });
}

/** Whether the trainer has already caught a given species. */
export function hasCaught(trainer, name) {
  return (trainer?.system?.pokedex?.caught ?? []).includes(name);
}

export function dexProgress(trainer) {
  const caught = trainer?.system?.pokedex?.caught?.length ?? 0;
  const seen = trainer?.system?.pokedex?.seen?.length ?? 0;
  return { caught, seen, total: TOTAL_DEX, pct: Math.round((caught / TOTAL_DEX) * 100) };
}

export function registerDexApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    dex: { markSeen, markCaught, hasCaught, progress: dexProgress }
  });
}
