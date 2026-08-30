/**
 * Pokémon Masters — progression: XP, level-up, move learning, evolution.
 *
 * Winning a battle awards XP (fires off the `pmPokemonFainted` hook). Crossing a
 * threshold levels the Pokémon up, which re-derives its stats, teaches any
 * level-up moves for the new level, and triggers a level-based evolution.
 */

/** XP needed to advance *from* the given level to the next (a gentle escalating curve). */
export function xpToNext(level) {
  return 10 + level * 12;
}

/** XP a victor earns for defeating the given Pokémon. */
export function xpFromDefeat(defeated) {
  return Math.max(1, Math.round((defeated?.system?.level ?? 5) * 8));
}

async function findInPack(packId, name) {
  const pack = game.packs.get(packId);
  if (!pack) return null;
  const key = String(name).toLowerCase();
  const entry = pack.index.find((e) => e.name.toLowerCase() === key);
  return entry ? pack.getDocument(entry._id) : null;
}

/** Teach any level-up moves the Pokémon gains at exactly `level` (max 4 known). */
async function learnMovesAt(pokemon, level) {
  const entries = (pokemon.system.learnset ?? []).filter((l) => l.level === level);
  for (const entry of entries) {
    const already = pokemon.items.some((i) => i.type === "move" && i.name.toLowerCase() === entry.move.toLowerCase());
    if (already) continue;
    const moveDoc = await findInPack("pokemon-masters.moves", entry.move);
    if (!moveDoc) continue;
    const known = pokemon.items.filter((i) => i.type === "move").length;
    if (known >= 4) {
      await ChatMessage.create({
        speaker: { alias: pokemon.name },
        content: `<p>${pokemon.name} wants to learn <strong>${entry.move}</strong>, but already knows four moves. Teach it manually to replace one.</p>`
      });
      continue;
    }
    await pokemon.createEmbeddedDocuments("Item", [moveDoc.toObject()]);
    await ChatMessage.create({
      speaker: { alias: pokemon.name },
      content: `<p>${pokemon.name} learned <strong>${entry.move}</strong>!</p>`
    });
  }
}

/** Add XP; handle any resulting level-ups, move learning, and evolution. */
export async function awardXp(pokemon, amount) {
  if (pokemon?.type !== "pokemon" || !amount) return;
  if (!pokemon.isOwner) return; // the client that owns the victor resolves it

  let level = pokemon.system.level ?? 5;
  let xp = (pokemon.system.xp ?? 0) + amount;
  const gained = [];
  while (level < 100 && xp >= xpToNext(level)) {
    xp -= xpToNext(level);
    level += 1;
    gained.push(level);
  }
  await pokemon.update({ "system.level": level, "system.xp": xp });

  await ChatMessage.create({
    speaker: { alias: pokemon.name },
    content: `<p>${pokemon.name} gained <strong>${amount}</strong> XP.${gained.length ? ` Grew to <strong>Lv ${level}</strong>!` : ""}</p>`
  });

  for (const lv of gained) await learnMovesAt(pokemon, lv);
  if (gained.length) await maybeEvolve(pokemon);
}

/** Evolve if a level-based evolution is now satisfied. */
export async function maybeEvolve(pokemon) {
  const evo = pokemon.system.evolution;
  if (!evo?.into?.length || !evo.level) return;
  if ((pokemon.system.level ?? 1) < evo.level) return;
  return evolve(pokemon, evo.into[0]);
}

/** Transform a Pokémon into a target species, keeping level/XP/HP-ratio/nickname. */
export async function evolve(pokemon, targetName) {
  const species = await findInPack("pokemon-masters.species", targetName);
  if (!species) {
    console.warn(`Pokémon Masters | Evolution target not found: ${targetName}`);
    return;
  }

  const DialogV2 = foundry.applications?.api?.DialogV2;
  let allow = true;
  try {
    if (DialogV2) {
      allow = await DialogV2.confirm({
        window: { title: "Evolution" },
        content: `<p>${pokemon.name} is about to evolve into <strong>${species.name}</strong>. Allow it?</p>`
      });
    }
  } catch (err) { /* fall through and evolve */ }
  if (!allow) return;

  const isNicknamed = pokemon.name !== (pokemon.system.species?.name ?? pokemon.name);
  const hpRatio = pokemon.system.hp?.max ? (pokemon.system.hp.value ?? pokemon.system.hp.max) / pokemon.system.hp.max : 1;
  const s = species.system;

  const update = {
    "system.species": s.species,
    "system.types": s.types,
    "system.baseStats": s.baseStats,
    "system.abilities": s.abilities,
    "system.rarity": s.rarity,
    "system.catchRate": s.catchRate,
    "system.learnset": s.learnset,
    "system.evolution": s.evolution,
    "system.nativeRegion": s.nativeRegion,
    "system.variantRegion": s.variantRegion,
    "system.hp.value": null // re-topped from new max next prepare; keep ratio below
  };
  if (!isNicknamed) update.name = species.name;
  if (species.img && pokemon.img === "icons/svg/mystery-man.svg") update.img = species.img;
  await pokemon.update(update);

  // Preserve the HP ratio against the new max.
  const newMax = pokemon.system.hp?.max ?? 0;
  if (newMax) await pokemon.update({ "system.hp.value": Math.max(1, Math.round(newMax * hpRatio)) });

  await ChatMessage.create({
    speaker: { alias: "Evolution" },
    content: `<div class="pm-encounter-card"><h3>${isNicknamed ? pokemon.name : species.name} evolved into ${species.name}!</h3></div>`
  });
}

export function registerProgressionHooks() {
  Hooks.on("pmPokemonFainted", async ({ attacker, target }) => {
    if (attacker?.type === "pokemon" && attacker.isOwner) {
      await awardXp(attacker, xpFromDefeat(target));
    }
  });
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    progression: { awardXp, evolve, maybeEvolve, xpToNext, xpFromDefeat }
  });
}
