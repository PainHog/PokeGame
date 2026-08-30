/**
 * Pokémon Masters — battle resolution.
 *
 * A move is used by an attacker Pokémon against a target Pokémon. Damage follows
 * the mainline formula (level, move power, the relevant attack/defence stat,
 * STAB, and type effectiveness, times a small random spread). HP is applied to
 * the target and a faint fires the `pmPokemonFainted` hook (progression listens).
 *
 * `damageCalc` is pure and RNG-injectable so it can be unit tested outside Foundry.
 */

import { typeMultiplier, effectivenessLabel } from "./typechart.mjs";

/**
 * Mainline damage formula (simplified: no abilities/items/weather/crit).
 * @returns {{damage:number, base:number, typeMult:number, stab:number}}
 */
export function damageCalc({ level, power, atk, def, stab = 1, typeMult = 1, rng = Math.random }) {
  if (!power || power <= 0) return { damage: 0, base: 0, typeMult, stab };
  if (typeMult === 0) return { damage: 0, base: 0, typeMult: 0, stab };
  const base = Math.floor(Math.floor(Math.floor((2 * level) / 5 + 2) * power * (atk / Math.max(1, def))) / 50) + 2;
  const spread = 0.85 + rng() * 0.15;
  const damage = Math.max(1, Math.floor(base * stab * typeMult * spread));
  return { damage, base, typeMult, stab };
}

/** Extract the elemental type / category / power from a move Item or plain data. */
function moveFacts(move) {
  const s = move.system ?? move;
  return {
    name: move.name ?? s.name ?? "Move",
    moveType: s.moveType ?? "Normal",
    category: s.category ?? "Physical",
    power: s.power ?? 0
  };
}

/** The user's current single target as a Pokémon actor + its token, if valid. */
export function currentTarget() {
  const t = [...(game.user.targets ?? [])][0];
  if (!t?.actor || t.actor.type !== "pokemon") return null;
  return { token: t.document, actor: t.actor };
}

/**
 * Resolve a move from `attacker` against `target` (defaults to the user's target).
 * Applies damage and posts a chat card.
 */
export async function useMove(attacker, move, target = null) {
  if (!attacker || attacker.type !== "pokemon") {
    return ui.notifications?.warn("Only a Pokémon can use a move.");
  }
  target ??= currentTarget();
  if (!target?.actor) return ui.notifications?.warn("Target a Pokémon first.");

  const tgt = target.actor;
  const facts = moveFacts(move);
  const a = attacker.system;
  const d = tgt.system;

  const isPhysical = facts.category === "Physical";
  const atkStat = isPhysical ? a.stats?.atk : a.stats?.spa;
  const defStat = isPhysical ? d.stats?.def : d.stats?.spd;
  const stab = (a.types ?? []).includes(facts.moveType) ? 1.5 : 1;
  const typeMult = typeMultiplier(facts.moveType, d.types ?? []);

  let result = { damage: 0, typeMult };
  let applied = 0;
  if (facts.category !== "Status") {
    result = damageCalc({ level: a.level ?? 5, power: facts.power, atk: atkStat ?? 1, def: defStat ?? 1, stab, typeMult });
    const newHp = Math.max(0, (d.hp?.value ?? d.hp?.max ?? 0) - result.damage);
    applied = (d.hp?.value ?? d.hp?.max ?? 0) - newHp;
    try {
      await tgt.update({ "system.hp.value": newHp });
    } catch (err) {
      ui.notifications?.warn(`Couldn't apply damage to ${tgt.name} (permission?). GM may need to resolve.`);
    }
  }

  const eff = effectivenessLabel(typeMult);
  const fainted = tgt.system.hp?.value <= 0 && facts.category !== "Status";
  await ChatMessage.create({
    speaker: { alias: attacker.name },
    content: `
      <div class="pm-battle-card">
        <h3>${attacker.name} used <strong>${facts.name}</strong>!</h3>
        ${facts.category === "Status"
          ? `<p><em>${facts.name} is a status move — no direct damage.</em></p>`
          : `<p>Dealt <strong>${applied}</strong> damage to ${tgt.name}. ${eff ? `<em>${eff}</em>` : ""}</p>
             <p><small>${tgt.name}: ${tgt.system.hp?.value ?? 0} / ${tgt.system.hp?.max ?? 0} HP</small></p>`}
        ${fainted ? `<p class="pm-faint">${tgt.name} fainted!</p>` : ""}
      </div>`
  });

  if (fainted) Hooks.callAll("pmPokemonFainted", { attacker, target: tgt });
  return result;
}

/** Public API installer. */
export function registerBattleApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    battle: { useMove, damageCalc, currentTarget }
  });
}
