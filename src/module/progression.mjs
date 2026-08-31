/**
 * Pokémon Masters — progression: XP, level-up, move learning, evolution.
 *
 * Winning a battle awards XP (fires off the `pmPokemonFainted` hook). Crossing a
 * threshold levels the Pokémon up, which re-derives its stats, teaches any
 * level-up moves for the new level, and triggers a level-based evolution.
 */

import { teachMove } from "./tms.mjs";

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
    const known = pokemon.items.filter((i) => i.type === "move").length;
    if (known >= 4) {
      // Already knows four — let the player choose whether to replace one
      // (teachMove runs the "forget which move?" prompt on the owning client).
      await teachMove(pokemon, entry.move);
      continue;
    }
    const moveDoc = await findInPack("pokemon-masters.moves", entry.move);
    if (!moveDoc) continue;
    await pokemon.createEmbeddedDocuments("Item", [moveDoc.toObject()]);
    await ChatMessage.create({
      speaker: { alias: pokemon.name },
      content: `<p>${pokemon.name} learned <strong>${entry.move}</strong>!</p>`
    });
  }
}

/**
 * Seed a freshly-obtained Pokémon with the moves it would know at its level —
 * the four most-recent level-up moves at or below its current level. Without
 * this a new starter/catch/egg/wild owns zero moves and can only Struggle.
 * No-op if it already knows a move (e.g. a bred egg with inherited moves).
 */
export async function seedMoves(pokemon) {
  if (pokemon?.type !== "pokemon") return;
  if (pokemon.items.some((i) => i.type === "move")) return;
  const level = pokemon.system.level ?? 5;
  const learnable = (pokemon.system.learnset ?? [])
    .filter((l) => l.level > 0 && l.level <= level)
    .sort((a, b) => a.level - b.level);
  // De-dupe keeping the latest occurrence, then take the last four learned.
  const names = [];
  for (const l of learnable) { const k = l.move; if (!names.includes(k)) names.push(k); }
  const chosen = names.slice(-4);
  const docs = [];
  for (const name of chosen) {
    const moveDoc = await findInPack("pokemon-masters.moves", name);
    if (moveDoc) docs.push(moveDoc.toObject());
  }
  if (docs.length) await pokemon.createEmbeddedDocuments("Item", docs);
}

/**
 * Award effort values (EVs) for defeating a Pokémon. Yields go into the
 * defeated species' two highest base stats — approximating canon yields — and
 * respect the 252-per-stat / 510-total caps. The stat formula already consumes
 * EVs, so this makes stat-training actually matter.
 */
export async function awardEvs(winner, defeated) {
  if (winner?.type !== "pokemon" || !winner.isOwner || defeated?.type !== "pokemon") return;
  const base = defeated.system?.baseStats ?? {};
  const ranked = Object.entries(base).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const gains = { [ranked[0]]: 2, [ranked[1]]: 1 };
  const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...(winner.system.evs ?? {}) };
  let total = Object.values(evs).reduce((a, b) => a + b, 0);
  const update = {};
  for (const [stat, amt] of Object.entries(gains)) {
    const room = Math.min(amt, 252 - (evs[stat] ?? 0), 510 - total);
    if (room > 0) { evs[stat] += room; total += room; update[`system.evs.${stat}`] = evs[stat]; }
  }
  if (Object.keys(update).length) await winner.update(update);
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
  const friendship = Math.min(255, (pokemon.system.friendship ?? 0) + (gained.length ? 5 * gained.length : 2));
  await pokemon.update({ "system.level": level, "system.xp": xp, "system.friendship": friendship });

  await ChatMessage.create({
    speaker: { alias: pokemon.name },
    content: `<p>${pokemon.name} gained <strong>${amount}</strong> XP.${gained.length ? ` Grew to <strong>Lv ${level}</strong>!` : ""}</p>`
  });

  for (const lv of gained) await learnMovesAt(pokemon, lv);
  if (gained.length) await maybeEvolve(pokemon);
}

/** Rough day/night read from the current scene's darkness (0 = day … 1 = night). */
function isDaytime() {
  const d = canvas?.scene?.environment?.darknessLevel ?? canvas?.scene?.darkness ?? 0;
  return d < 0.5;
}

/** Does a non-level condition string (gender / time) hold for this Pokémon? */
function conditionMatches(pokemon, evo) {
  const cond = (evo.condition || "").toLowerCase();
  if (cond.includes("day") && !isDaytime()) return false;
  if (cond.includes("night") && isDaytime()) return false;
  if (cond.includes("female") && pokemon.system.gender !== "F") return false;
  if (cond.includes("male") && !cond.includes("female") && pokemon.system.gender !== "M") return false;
  return true;
}

/**
 * Is the transition into `targetEvo` (the evolved species' own evolution data,
 * describing how the prevo becomes it) satisfied for this trigger?
 */
function evoSatisfied(pokemon, targetEvo, trigger, itemName) {
  if (!conditionMatches(pokemon, targetEvo)) return false;
  const method = targetEvo.method || "level";
  const lvl = pokemon.system.level ?? 1;
  const friendship = pokemon.system.friendship ?? 0;
  switch (method) {
    case "level":
    case "levelExtra":
      return trigger === "level" && !!targetEvo.level && lvl >= targetEvo.level;
    case "levelFriendship":
      return trigger === "level" && friendship >= 160; // Gen 8+ threshold
    case "useItem":
      return trigger === "item" && !!itemName && (targetEvo.item || "").toLowerCase() === itemName.toLowerCase();
    case "trade":
      return trigger === "trade";
    case "levelMove":   // needs a specific known move (data not captured)
    case "levelHold":   // needs a held item (held items not yet modeled)
    case "other":
      return false;
    default:
      return trigger === "level" && !!targetEvo.level && lvl >= targetEvo.level;
  }
}

/**
 * Evolve if any of this Pokémon's `into` targets is now satisfied for `trigger`
 * ("level" | "item" | "trade"). Branches (Eevee, Tyrogue…) prompt a choice.
 * Returns the evolved species name, or null.
 */
export async function maybeEvolve(pokemon, { trigger = "level", itemName = null } = {}) {
  if ((pokemon.system.heldItem || "").toLowerCase() === "everstone") return null; // Everstone blocks evolution
  const into = pokemon.system.evolution?.into ?? [];
  if (!into.length) return null;

  const candidates = [];
  for (const name of into) {
    const sp = await findInPack("pokemon-masters.species", name);
    if (sp && evoSatisfied(pokemon, sp.system.evolution, trigger, itemName)) candidates.push(sp);
  }
  if (!candidates.length) return null;

  let target = candidates[0];
  if (candidates.length > 1) {
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (DialogV2) {
      const opts = candidates.map((c) => `<option value="${c.name}">${c.name}</option>`).join("");
      const chosen = await DialogV2.prompt({
        window: { title: `${pokemon.name} is evolving` },
        content: `<p>Into which Pokémon?</p><select name="t" style="width:100%">${opts}</select>`,
        ok: { label: "Evolve", callback: (event, button) => button.form.elements.t.value }
      }).catch(() => null);
      target = candidates.find((c) => c.name === chosen) ?? null;
    }
  }
  return target ? doEvolve(pokemon, target) : null;
}

/** Use an evolution stone/item: evolve if it matches an into target's requirement. */
export async function evolveWithItem(pokemon, itemName) {
  return maybeEvolve(pokemon, { trigger: "item", itemName });
}

/** Trade evolution trigger (called by the trade flow). */
export async function evolveByTrade(pokemon) {
  return maybeEvolve(pokemon, { trigger: "trade" });
}

/** Manually evolve into a named target (GM/console), skipping requirement checks. */
export async function evolve(pokemon, targetName) {
  const species = await findInPack("pokemon-masters.species", targetName);
  if (!species) {
    console.warn(`Pokémon Masters | Evolution target not found: ${targetName}`);
    return null;
  }
  return doEvolve(pokemon, species);
}

/** Transform a Pokémon into a target species, keeping level/XP/HP-ratio/nickname. */
async function doEvolve(pokemon, species) {
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
  if (!allow) return null;

  const isNicknamed = pokemon.name !== (pokemon.system.species?.name ?? pokemon.name);
  const hpRatio = pokemon.system.hp?.max ? (pokemon.system.hp.value ?? pokemon.system.hp.max) / pokemon.system.hp.max : 1;
  const s = species.system;

  const update = {
    "system.species": s.species,
    "system.types": s.types,
    "system.baseStats": s.baseStats,
    "system.abilities": s.abilities,
    "system.hiddenAbility": s.hiddenAbility,
    "system.rarity": s.rarity,
    "system.catchRate": s.catchRate,
    "system.learnset": s.learnset,
    "system.evolution": s.evolution,
    "system.nativeRegion": s.nativeRegion,
    "system.variantRegion": s.variantRegion,
    "system.populationCap": s.populationCap,
    "system.ultraBeast": s.ultraBeast,
    "system.eggGroups": s.eggGroups,
    "system.eggSpecies": s.eggSpecies,
    "system.genderless": s.genderless,
    "system.femaleRate": s.femaleRate,
    "system.hp.value": null // re-topped from new max next prepare; keep ratio below
  };
  if (!isNicknamed) update.name = species.name;
  if (species.img) { update.img = species.img; update["prototypeToken.texture.src"] = species.prototypeToken?.texture?.src ?? species.img; }
  await pokemon.update(update);

  // Preserve the HP ratio against the new max.
  const newMax = pokemon.system.hp?.max ?? 0;
  if (newMax) await pokemon.update({ "system.hp.value": Math.max(1, Math.round(newMax * hpRatio)) });

  await ChatMessage.create({
    speaker: { alias: "Evolution" },
    content: `<div class="pm-encounter-card"><h3>${isNicknamed ? pokemon.name : species.name} evolved into ${species.name}!</h3></div>`
  });
  return species.name;
}

export function registerProgressionHooks() {
  Hooks.on("pmPokemonFainted", async ({ attacker, target }) => {
    if (attacker?.type === "pokemon" && attacker.isOwner) {
      await awardXp(attacker, xpFromDefeat(target));
      await awardEvs(attacker, target);
    }
  });
  // Every newly-created Pokémon (starter, catch, egg, wild spawn) gets its
  // level-appropriate moves, so it never enters battle able only to Struggle.
  // Only the creating client runs it — createActor fires on every connected
  // client, so gate on userId (not isOwner) to avoid a double-seed race.
  Hooks.on("createActor", (actor, options, userId) => {
    if (game.userId === userId && actor?.type === "pokemon") {
      seedMoves(actor).catch((e) => console.warn("Pokémon Masters | seedMoves failed", e));
    }
  });
  // Backfill any pre-existing moveless Pokémon once, so older worlds catch up.
  for (const actor of game.actors ?? []) {
    if (actor.type === "pokemon" && actor.isOwner && !actor.items.some((i) => i.type === "move")) {
      seedMoves(actor).catch(() => {});
    }
  }
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    progression: { awardXp, awardEvs, evolve, maybeEvolve, evolveWithItem, evolveByTrade, seedMoves, xpToNext, xpFromDefeat }
  });
}
