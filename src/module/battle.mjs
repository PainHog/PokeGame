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

/**
 * Resolve a move from `attacker` against `target` (defaults to the user's
 * target). When `autoRetaliate` is set (a player picking a move on their sheet),
 * a surviving wild/NPC target fights back automatically with its best move — so
 * battles play out turn-by-turn with the player choosing and the NPC responding,
 * no GM required.
 */
export async function useMove(attacker, move, target = null, { autoRetaliate = false } = {}) {
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

  // Z-Move: a pending Z-Power (set by activateGimmick(actor, "z")) boosts one
  // damaging move by 1.6×, then is spent.
  const gimmick = attacker.getFlag?.("pokemon-masters", "gimmick") ?? null;
  let zPower = false;
  if (gimmick?.zAvailable && facts.category !== "Status") zPower = true;

  let result = { damage: 0, typeMult: typeMultiplier(facts.moveType, d.types ?? []) };
  let applied = 0;
  if (facts.category !== "Status") {
    const atkStat = isPhysical ? a.stats?.atk : a.stats?.spa;
    const defStat = isPhysical ? d.stats?.def : d.stats?.spd;
    const stab = (a.types ?? []).includes(facts.moveType) ? 1.5 : 1;
    const zMult = zPower ? 1.6 : 1;
    result = damageCalc({ level: a.level ?? 5, power: facts.power, atk: atkStat ?? 1, def: defStat ?? 1, stab, typeMult: result.typeMult * zMult, crit, burn: burned });
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

  // A spent Z-Power is consumed whether or not it landed.
  if (zPower) { try { await attacker.setFlag("pokemon-masters", "gimmick", { ...gimmick, zAvailable: false }); } catch (err) { /* perms */ } }

  const eff = effectivenessLabel(result.typeMult);
  const fainted = tgt.system.hp?.value <= 0 && facts.category !== "Status";
  await ChatMessage.create({
    speaker: { alias: attacker.name },
    content: `
      <div class="pm-battle-card">
        <h3>${attacker.name} used <strong>${facts.name}</strong>!${zPower ? " <em>(Z-Power!)</em>" : ""}</h3>
        ${facts.category === "Status"
          ? `<p><em>${facts.name} is a status move.</em></p>`
          : `<p>Dealt <strong>${applied}</strong> damage to ${tgt.name}.${crit ? " <em>A critical hit!</em>" : ""} ${eff ? `<em>${eff}</em>` : ""}</p>
             <p><small>${tgt.name}: ${tgt.system.hp?.value ?? 0} / ${tgt.system.hp?.max ?? 0} HP</small></p>`}
        ${inflicted ? `<p>${tgt.name} was <strong>${inflicted}</strong>!</p>` : ""}
        ${fainted ? `<p class="pm-faint">${tgt.name} fainted!</p>` : ""}
      </div>`
  });

  if (fainted) Hooks.callAll("pmPokemonFainted", { attacker, target: tgt });

  // The wild/NPC target fights back on its own (players never wait on a GM).
  if (autoRetaliate && (tgt.system.hp?.value ?? 0) > 0 && !tgt.hasPlayerOwner) {
    const npc = await import("./npc.mjs");
    const npcMove = npc.chooseBestMove(npc.combatantFromActor(tgt), npc.combatantFromActor(attacker));
    if (npcMove) await useMove(tgt, npcMove, { actor: attacker }, { autoRetaliate: false });
  }
  // End of the round: burn/poison/toxic chip both actives (the autoRetaliate
  // call owns the turn, so this fires once per exchange, not on the reply).
  if (autoRetaliate) {
    if ((attacker.system.hp?.value ?? 0) > 0) await applyEndOfTurn(attacker);
    if ((tgt.system.hp?.value ?? 0) > 0) await applyEndOfTurn(tgt);
  }
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

/**
 * Activate a battle gimmick on a player's Pokémon (they choose; NPCs auto-fire
 * theirs in the simulation engine). One transformation per Pokémon per battle.
 *   · "mega"     — needs the matching Mega Stone held; scales stats, swaps type/ability.
 *   · "tera"     — needs a Tera Orb held; the Pokémon becomes its single Tera type.
 *   · "dynamax"  — doubles current & max HP (wears off on revert / faint).
 *   · "z"        — needs a Z-Crystal held; arms one 1.6× Z-Move (consumed by useMove).
 * A snapshot of the pre-transform stats is stored on the `gimmick` flag so
 * `revertGimmick` can restore the Pokémon after the fight.
 */
export async function activateGimmick(actor, kind) {
  if (!actor || actor.type !== "pokemon") return ui.notifications?.warn("Only a Pokémon can use a battle gimmick.");
  const s = actor.system;
  const prior = actor.getFlag("pokemon-masters", "gimmick");
  if (prior?.used) return ui.notifications?.warn(`${actor.name} has already used its gimmick this battle.`);
  const held = (s.heldItem ?? "").toLowerCase();

  const say = (msg) => ChatMessage.create({ speaker: { alias: actor.name }, content: `<div class="pm-battle-card pm-gimmick"><p>${msg}</p></div>` });

  if (kind === "mega") {
    const mega = (s.megaData ?? []).find((m) => (m.item ?? "").toLowerCase() === held);
    if (!mega) return ui.notifications?.warn(`${actor.name} isn't holding the right Mega Stone.`);
    const base = s.baseStats ?? s.stats;
    const stats = { ...s.stats };
    for (const k of ["hp", "atk", "def", "spa", "spd", "spe"]) {
      const b = base?.[k] || 1;
      stats[k] = Math.max(1, Math.round((s.stats?.[k] ?? b) * ((mega.stats?.[k] ?? b) / b)));
    }
    const oldMax = s.hp?.max ?? s.stats?.hp ?? 1;
    const newMax = stats.hp;
    const newVal = Math.min(newMax, Math.max(1, Math.round((s.hp?.value ?? oldMax) * newMax / oldMax)));
    const snapshot = { types: [...(s.types ?? [])], stats: { ...s.stats }, ability: s.ability ?? "", hp: { value: s.hp?.value ?? oldMax, max: oldMax } };
    await actor.update({ "system.stats": stats, "system.types": [...(mega.types ?? s.types)], "system.ability": mega.ability || s.ability, "system.hp.max": newMax, "system.hp.value": newVal });
    await actor.setFlag("pokemon-masters", "gimmick", { used: true, form: "mega", snapshot });
    return say(`${actor.name} Mega Evolved into <strong>${mega.name}</strong>!`);
  }

  if (kind === "tera") {
    if (held !== "tera orb") return ui.notifications?.warn(`${actor.name} needs to hold a Tera Orb to Terastallize.`);
    const tera = s.teraType || (s.types ?? [])[0] || "Normal";
    const snapshot = { types: [...(s.types ?? [])] };
    await actor.update({ "system.types": [tera] });
    await actor.setFlag("pokemon-masters", "gimmick", { used: true, form: "tera", snapshot });
    return say(`${actor.name} Terastallized into the <strong>${tera}</strong> type!`);
  }

  if (kind === "dynamax") {
    const oldMax = s.hp?.max ?? s.stats?.hp ?? 1;
    const snapshot = { hp: { value: s.hp?.value ?? oldMax, max: oldMax } };
    await actor.update({ "system.hp.max": oldMax * 2, "system.hp.value": (s.hp?.value ?? oldMax) * 2 });
    await actor.setFlag("pokemon-masters", "gimmick", { used: true, form: "dynamax", snapshot });
    return say(`${actor.name} Dynamaxed! Its HP swelled enormously.`);
  }

  if (kind === "z") {
    if (held !== "z-crystal") return ui.notifications?.warn(`${actor.name} needs to hold a Z-Crystal.`);
    await actor.setFlag("pokemon-masters", "gimmick", { used: true, form: "z", zAvailable: true });
    return say(`${actor.name}'s Z-Power is ready — its next attacking move will be a Z-Move!`);
  }

  return ui.notifications?.warn(`Unknown gimmick "${kind}".`);
}

/** Undo a Pokémon's active gimmick (restore stats/types/HP) and clear the flag. */
export async function revertGimmick(actor) {
  if (!actor) return;
  const g = actor.getFlag("pokemon-masters", "gimmick");
  if (!g) return;
  const snap = g.snapshot ?? {};
  const update = {};
  if (snap.types) update["system.types"] = snap.types;
  if (snap.stats) update["system.stats"] = snap.stats;
  if (snap.ability !== undefined) update["system.ability"] = snap.ability;
  if (snap.hp) {
    update["system.hp.max"] = snap.hp.max;
    update["system.hp.value"] = Math.min(snap.hp.max, actor.system.hp?.value ?? snap.hp.max);
  }
  if (Object.keys(update).length) await actor.update(update);
  await actor.unsetFlag("pokemon-masters", "gimmick");
}

export function registerBattleApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    battle: { useMove, damageCalc, currentTarget, applyEndOfTurn, activateGimmick, revertGimmick }
  });
  // A fainted Pokémon automatically drops its gimmick transformation.
  Hooks.on("pmPokemonFainted", ({ target }) => { if (target?.getFlag?.("pokemon-masters", "gimmick")) revertGimmick(target); });
}
