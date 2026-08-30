/**
 * Pokémon Masters — battle resolution.
 *
 * A move is used by an attacker Pokémon against a target. Damage follows the
 * mainline formula (level, power, the relevant attack/defence stat, STAB, type
 * effectiveness, a random spread, crits, and burn halving physical damage).
 * Moves can miss by accuracy, and Status moves / secondary effects inflict a
 * status condition. HP is applied and a faint fires `pmPokemonFainted`.
 *
 * `damageCalc` is pure and RNG-injectable for testing.
 */

import { typeMultiplier, effectivenessLabel } from "./typechart.mjs";

export const CRIT_CHANCE = 1 / 24;

/** End-of-turn chip damage as a fraction of max HP, per status. */
export const STATUS_CHIP = { burn: 1 / 16, poison: 1 / 8 };

/**
 * Mainline damage formula (no abilities/items/weather).
 * @returns {{damage:number, base:number, typeMult:number, stab:number, crit:boolean}}
 */
export function damageCalc({ level, power, atk, def, stab = 1, typeMult = 1, crit = false, burn = false, rng = Math.random }) {
  if (!power || power <= 0) return { damage: 0, base: 0, typeMult, stab, crit: false };
  if (typeMult === 0) return { damage: 0, base: 0, typeMult: 0, stab, crit: false };
  const base = Math.floor(Math.floor(Math.floor((2 * level) / 5 + 2) * power * (atk / Math.max(1, def))) / 50) + 2;
  const spread = 0.85 + rng() * 0.15;
  const mult = stab * typeMult * spread * (crit ? 1.5 : 1) * (burn ? 0.5 : 1);
  return { damage: Math.max(1, Math.floor(base * mult)), base, typeMult, stab, crit };
}

/** Extract type/category/power/accuracy/priority/status from a move Item or data. */
function moveFacts(move) {
  const s = move.system ?? move;
  return {
    name: move.name ?? s.name ?? "Move",
    moveType: s.moveType ?? "Normal",
    category: s.category ?? "Physical",
    power: s.power ?? 0,
    accuracy: s.accuracy ?? 100,
    alwaysHits: !!s.alwaysHits,
    priority: s.priority ?? 0,
    inflictStatus: s.inflictStatus ?? "",
    secondaryStatus: s.secondaryStatus ?? "",
    secondaryChance: s.secondaryChance ?? 0
  };
}

/** The user's current single target as a Pokémon actor + its token, if valid. */
export function currentTarget() {
  const t = [...(game.user.targets ?? [])][0];
  if (!t?.actor || t.actor.type !== "pokemon") return null;
  return { token: t.document, actor: t.actor };
}

/** Resolve a move from `attacker` against `target` (defaults to the user's target). */
export async function useMove(attacker, move, target = null) {
  if (!attacker || attacker.type !== "pokemon") return ui.notifications?.warn("Only a Pokémon can use a move.");
  target ??= currentTarget();
  if (!target?.actor) return ui.notifications?.warn("Target a Pokémon first.");

  const tgt = target.actor;
  const facts = moveFacts(move);
  const a = attacker.system;
  const d = tgt.system;
  const isPhysical = facts.category === "Physical";

  // Can the attacker act? (sleep / freeze / paralysis)
  if (a.status === "paralysis" && Math.random() < 0.25) {
    await ChatMessage.create({ speaker: { alias: attacker.name }, content: `<div class="pm-battle-card"><p>${attacker.name} is paralyzed and can't move!</p></div>` });
    return { skipped: true };
  }
  if (a.status === "freeze") {
    if (Math.random() < 0.2) await attacker.update({ "system.status": "none" });
    else { await ChatMessage.create({ speaker: { alias: attacker.name }, content: `<div class="pm-battle-card"><p>${attacker.name} is frozen solid!</p></div>` }); return { skipped: true }; }
  }
  if (a.status === "sleep") {
    if (Math.random() < 0.33) await attacker.update({ "system.status": "none" });
    else { await ChatMessage.create({ speaker: { alias: attacker.name }, content: `<div class="pm-battle-card"><p>${attacker.name} is fast asleep!</p></div>` }); return { skipped: true }; }
  }

  // Accuracy — always-hit moves skip; Status moves with <100% accuracy can still miss.
  if (!facts.alwaysHits && facts.accuracy > 0
      && Math.floor(Math.random() * 100) >= facts.accuracy) {
    await ChatMessage.create({ speaker: { alias: attacker.name }, content: `<div class="pm-battle-card"><h3>${attacker.name} used ${facts.name}!</h3><p><em>But it missed!</em></p></div>` });
    return { missed: true };
  }

  const crit = facts.category !== "Status" && Math.random() < CRIT_CHANCE;
  const burned = a.status === "burn" && isPhysical;

  let result = { damage: 0, typeMult: typeMultiplier(facts.moveType, d.types ?? []) };
  let applied = 0;
  if (facts.category !== "Status") {
    const atkStat = isPhysical ? a.stats?.atk : a.stats?.spa;
    const defStat = isPhysical ? d.stats?.def : d.stats?.spd;
    const stab = (a.types ?? []).includes(facts.moveType) ? 1.5 : 1;
    result = damageCalc({ level: a.level ?? 5, power: facts.power, atk: atkStat ?? 1, def: defStat ?? 1, stab, typeMult: result.typeMult, crit, burn: burned });
    const cur = d.hp?.value ?? d.hp?.max ?? 0;
    const newHp = Math.max(0, cur - result.damage);
    applied = cur - newHp;
    try { await tgt.update({ "system.hp.value": newHp }); }
    catch (err) { ui.notifications?.warn(`Couldn't apply damage to ${tgt.name} (permission?).`); }
  }

  // Status infliction: a Status move's primary, or a damaging move's secondary.
  let inflicted = null;
  if ((tgt.system.hp?.value ?? 1) > 0 && tgt.system.status === "none") {
    if (facts.category === "Status" && facts.inflictStatus) inflicted = facts.inflictStatus;
    else if (facts.secondaryStatus && facts.secondaryChance && Math.floor(Math.random() * 100) < facts.secondaryChance) inflicted = facts.secondaryStatus;
    if (inflicted) { try { await tgt.update({ "system.status": inflicted }); } catch (err) { /* perms */ } }
  }

  const eff = effectivenessLabel(result.typeMult);
  const fainted = tgt.system.hp?.value <= 0 && facts.category !== "Status";
  await ChatMessage.create({
    speaker: { alias: attacker.name },
    content: `
      <div class="pm-battle-card">
        <h3>${attacker.name} used <strong>${facts.name}</strong>!</h3>
        ${facts.category === "Status"
          ? `<p><em>${facts.name} is a status move.</em></p>`
          : `<p>Dealt <strong>${applied}</strong> damage to ${tgt.name}.${crit ? " <em>A critical hit!</em>" : ""} ${eff ? `<em>${eff}</em>` : ""}</p>
             <p><small>${tgt.name}: ${tgt.system.hp?.value ?? 0} / ${tgt.system.hp?.max ?? 0} HP</small></p>`}
        ${inflicted ? `<p>${tgt.name} was <strong>${inflicted}</strong>!</p>` : ""}
        ${fainted ? `<p class="pm-faint">${tgt.name} fainted!</p>` : ""}
      </div>`
  });

  if (fainted) Hooks.callAll("pmPokemonFainted", { attacker, target: tgt });
  return result;
}

/** Apply end-of-turn status chip (burn/poison, toxic ramp) to a Pokémon. */
export async function applyEndOfTurn(pokemon) {
  const status = pokemon.system?.status;
  const max = pokemon.system.hp?.max ?? 0;
  const update = {};
  let dmg = 0;
  if (status === "toxic") {
    const counter = (pokemon.system.toxicCounter || 0) + 1;
    update["system.toxicCounter"] = counter;
    dmg = Math.max(1, Math.floor((max * counter) / 16));
  } else if (STATUS_CHIP[status]) {
    dmg = Math.max(1, Math.floor(max * STATUS_CHIP[status]));
  }
  if (!dmg) return;
  const newHp = Math.max(0, (pokemon.system.hp?.value ?? max) - dmg);
  update["system.hp.value"] = newHp;
  await pokemon.update(update);
  await ChatMessage.create({ speaker: { alias: pokemon.name }, content: `<p>${pokemon.name} is hurt by ${status === "toxic" ? "toxic poison" : `its ${status}`} (−${dmg}).</p>` });
  if (newHp <= 0) Hooks.callAll("pmPokemonFainted", { attacker: null, target: pokemon });
}

export function registerBattleApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    battle: { useMove, damageCalc, currentTarget, applyEndOfTurn }
  });
}
