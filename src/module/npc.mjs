/**
 * Pokémon Masters — NPC simulation: auto-battle and dialogue.
 *
 * The battle engine (battle.mjs, typechart.mjs) lets two teams fight by rule.
 * This module adds an AI that picks each side's move, so gym leaders, rivals,
 * and wandering trainers can battle each other (or a player's team) unattended —
 * the heart of "the world plays itself".
 *
 * `simulateBattle` / `chooseBestMove` are pure (operate on plain combatant
 * objects, RNG-injectable) so they can be unit tested outside Foundry.
 */

import { damageCalc, CRIT_CHANCE, STATUS_CHIP } from "./battle.mjs";
import { typeMultiplier } from "./typechart.mjs";

/** Struggle — used when all moves are out of PP (typeless, recoils). */
const STRUGGLE = { name: "Struggle", moveType: "Normal", category: "Physical", power: 50, accuracy: 100, recoil: 0.25, contact: true, pp: Infinity };

/** Expected damage of a move from attacker vs defender (for AI ranking). */
function expectedDamage(move, attacker, defender) {
  if (!move.power) return 0;
  const isPhysical = move.category === "Physical";
  const atk = isPhysical ? attacker.stats.atk : attacker.stats.spa;
  const def = isPhysical ? defender.stats.def : defender.stats.spd;
  const stab = attacker.types.includes(move.moveType) ? 1.5 : 1;
  const mult = typeMultiplier(move.moveType, defender.types);
  return move.power * (atk / Math.max(1, def)) * stab * mult;
}

/** The move an attacker should use against a defender (highest expected damage). */
export function chooseBestMove(attacker, defender) {
  const moves = (attacker.moves ?? []).filter((m) => m.pp === undefined || m.pp > 0);
  if (!moves.length) return STRUGGLE; // all out of PP
  let best = moves[0];
  let bestScore = -1;
  for (const move of moves) {
    const score = expectedDamage(move, attacker, defender);
    if (score > bestScore) { bestScore = score; best = move; }
  }
  // While healthy, a setup sweeper first raises its own offensive stat (to +2)
  // instead of attacking — so Swords Dance / Nasty Plot actually get used.
  const hpFrac = (attacker.hp?.value ?? 1) / (attacker.hp?.max ?? 1);
  // On its first action, a healthy lead sets field control (hazards/screen/weather/status).
  if ((attacker.turnsSeen ?? 0) === 0 && hpFrac > 0.6) {
    const util = moves.find((m) => m.category === "Status" && (m.sideCondition || m.weather || m.inflictStatus || m.confuseChance));
    if (util) return util;
  }
  if (hpFrac > 0.7) {
    const setup = moves.find((m) => m.category === "Status" && m.boosts && m.boostTarget === "self"
      && Object.entries(m.boosts).some(([st, v]) => v > 0 && ["atk", "spa", "spe"].includes(st) && (attacker.boosts?.[st] ?? 0) < 2));
    if (setup) return setup;
  }
  return best;
}

/** Deep-ish copy of a combatant with working HP. */
function prep(c) {
  let maxHp = c.hp?.max ?? c.stats.hp;
  let value = c.hp?.value ?? maxHp;
  const dynamax = !!c.dynamax;
  if (dynamax) { maxHp *= 2; value *= 2; } // Dynamax doubles current & max HP for the duration.
  return {
    name: c.name,
    level: c.level ?? 5,
    types: [...(c.types ?? [])],
    stats: { ...c.stats },
    baseStats: { ...(c.baseStats ?? c.stats) },
    status: c.status ?? "none",
    statusTurns: 0,
    toxicCounter: c.toxicCounter ?? 0,
    ability: (c.ability ?? "").toLowerCase(),
    heldItem: (c.heldItem ?? "").toLowerCase(),
    megaData: c.megaData ?? [],
    teraType: c.teraType || (c.types ?? [])[0] || "Normal",
    // Gimmick state: one-shot flags + Dynamax countdown.
    megaUsed: false, teraUsed: false, zUsed: false,
    dynamaxTurns: dynamax ? 3 : 0,
    boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
    flinch: false, sashUsed: false, berryUsed: false, confusion: 0, turnsSeen: 0,
    moves: (c.moves ?? []).map((m) => ({ ...m, pp: m.pp ?? 15 })),
    hp: { value, max: maxHp }
  };
}

/** Stat-stage multiplier (−6…+6). */
const stageMult = (s) => (s >= 0 ? (2 + s) / 2 : 2 / (2 - s));
const clampStage = (s) => Math.max(-6, Math.min(6, s));

/**
 * Resolve a full battle between two teams of combatants.
 * @returns {{winner:"A"|"B"|"draw", log:string[], turns:number}}
 */
export function simulateBattle(teamAIn, teamBIn, { maxTurns = 300, rng = Math.random } = {}) {
  const A = teamAIn.map(prep);
  const B = teamBIn.map(prep);
  let a = 0; let b = 0;
  let prevA = 0; let prevB = 0;
  const log = [];
  let turns = 0;
  const weather = { type: "none", turns: 0 };
  const side = {
    A: { reflect: 0, lightscreen: 0, stealthrock: false, spikes: 0, toxicspikes: 0 },
    B: { reflect: 0, lightscreen: 0, stealthrock: false, spikes: 0, toxicspikes: 0 }
  };
  const sideOf = (mon) => (A.includes(mon) ? "A" : "B");

  // Entry-hazard damage/effects when a Pokémon switches in.
  const applyHazards = (mon) => {
    if (!mon || mon.ability === "magic guard") return;
    const grounded = !mon.types.includes("Flying") && mon.ability !== "levitate";
    const s = side[sideOf(mon)];
    if (s.stealthrock) {
      const dmg = Math.max(1, Math.floor(mon.hp.max * 0.125 * typeMultiplier("Rock", mon.types)));
      mon.hp.value = Math.max(0, mon.hp.value - dmg); log.push(`${mon.name} was hurt by Stealth Rock (−${dmg}).`);
    }
    if (grounded && s.spikes) {
      const frac = [0, 1 / 8, 1 / 6, 1 / 4][Math.min(3, s.spikes)];
      const dmg = Math.max(1, Math.floor(mon.hp.max * frac));
      mon.hp.value = Math.max(0, mon.hp.value - dmg); log.push(`${mon.name} was hurt by Spikes (−${dmg}).`);
    }
    if (grounded && s.toxicspikes && mon.status === "none" && !mon.types.includes("Steel")) {
      if (mon.types.includes("Poison")) { s.toxicspikes = 0; log.push(`${mon.name} absorbed the Toxic Spikes.`); }
      else { mon.status = s.toxicspikes >= 2 ? "toxic" : "poison"; log.push(`${mon.name} was poisoned by Toxic Spikes!`); }
    }
  };

  // Defender-ability immunities / absorptions for a move type.
  const absorbCheck = (move, defender) => {
    const ab = defender.ability; const t = move.moveType;
    if (ab === "levitate" && t === "Ground") return { immune: true };
    if ((ab === "water absorb" || ab === "dry skin") && t === "Water") return { immune: true, heal: 0.25 };
    if (ab === "volt absorb" && t === "Electric") return { immune: true, heal: 0.25 };
    if (ab === "flash fire" && t === "Fire") return { immune: true };
    if (ab === "sap sipper" && t === "Grass") return { immune: true, boost: { atk: 1 } };
    if (ab === "lightning rod" && t === "Electric") return { immune: true, boost: { spa: 1 } };
    return null;
  };

  // Can this Pokémon act? Handles sleep (1–3 turns), freeze (20% thaw), paralysis (25% skip).
  const canAct = (mon) => {
    if (mon.flinch) { mon.flinch = false; log.push(`${mon.name} flinched!`); return false; }
    if (mon.status === "sleep") {
      if (mon.statusTurns <= 0) mon.statusTurns = 1 + Math.floor(rng() * 3);
      mon.statusTurns--;
      if (mon.statusTurns <= 0) { mon.status = "none"; log.push(`${mon.name} woke up!`); return true; }
      log.push(`${mon.name} is fast asleep.`); return false;
    }
    if (mon.status === "freeze") {
      if (rng() < 0.2) { mon.status = "none"; log.push(`${mon.name} thawed out!`); return true; }
      log.push(`${mon.name} is frozen solid.`); return false;
    }
    if (mon.status === "paralysis" && rng() < 0.25) { log.push(`${mon.name} is paralyzed!`); return false; }
    if (mon.confusion > 0) {
      mon.confusion--;
      if (rng() < 1 / 3) {
        const res = damageCalc({ level: mon.level, power: 40, atk: mon.stats.atk, def: mon.stats.def, stab: 1, typeMult: 1, rng });
        mon.hp.value = Math.max(0, mon.hp.value - res.damage);
        log.push(`${mon.name} is confused and hurt itself (−${res.damage})!`);
        return false;
      }
      if (mon.confusion === 0) log.push(`${mon.name} snapped out of its confusion.`);
    }
    return true;
  };

  const applyBoosts = (mon, boosts) => {
    if (!boosts) return;
    for (const [stat, delta] of Object.entries(boosts)) {
      if (!(stat in mon.boosts) || !delta) continue;
      const before = mon.boosts[stat];
      mon.boosts[stat] = clampStage(before + delta);
      if (mon.boosts[stat] !== before) log.push(`${mon.name}'s ${stat} ${delta > 0 ? "rose" : "fell"}${Math.abs(delta) > 1 ? " sharply" : ""}.`);
    }
  };

  const strike = (attacker, defender) => {
    const move = chooseBestMove(attacker, defender);
    attacker.turnsSeen = (attacker.turnsSeen ?? 0) + 1;
    if (move.pp !== undefined && move.pp !== Infinity) move.pp = Math.max(0, move.pp - 1);
    if (!move.alwaysHits && (move.accuracy ?? 100) > 0
        && Math.floor(rng() * 100) >= move.accuracy) { log.push(`${attacker.name}'s ${move.name} missed!`); return; }
    const isPhysical = move.category === "Physical";
    const crit = move.category !== "Status" && rng() < CRIT_CHANCE;
    const burned = attacker.status === "burn" && isPhysical;

    if (move.category !== "Status") {
      // Defender ability immunities / absorptions.
      const abs = absorbCheck(move, defender);
      if (abs) {
        if (abs.heal) { defender.hp.value = Math.min(defender.hp.max, defender.hp.value + Math.floor(defender.hp.max * abs.heal)); log.push(`${defender.name} absorbed ${move.name} and healed!`); }
        else if (abs.boost) { applyBoosts(defender, abs.boost); log.push(`${defender.name}'s ${defender.ability} drew in ${move.name}!`); }
        else log.push(`${defender.name}'s ${defender.ability} made ${move.name} have no effect!`);
        return;
      }
      let typeMult = move.name === "Struggle" ? 1 : typeMultiplier(move.moveType, defender.types);
      if (defender.ability === "thick fat" && (move.moveType === "Fire" || move.moveType === "Ice")) typeMult *= 0.5;
      if (defender.ability === "wonder guard" && move.name !== "Struggle" && typeMult < 2) { log.push(`${defender.name}'s Wonder Guard blocked ${move.name}!`); return; }
      if (move.power <= 60 && attacker.ability === "technician") typeMult *= 1.5;
      if (defender.ability === "multiscale" && defender.hp.value >= defender.hp.max) typeMult *= 0.5;
      const dSide = side[sideOf(defender)];
      if (!crit && ((isPhysical && dSide.reflect) || (!isPhysical && dSide.lightscreen))) typeMult *= 0.5;
      // Weather damage modifiers.
      if (weather.type === "rain") typeMult *= move.moveType === "Water" ? 1.5 : move.moveType === "Fire" ? 0.5 : 1;
      else if (weather.type === "sun") typeMult *= move.moveType === "Fire" ? 1.5 : move.moveType === "Water" ? 0.5 : 1;

      const atkStage = isPhysical ? attacker.boosts.atk : attacker.boosts.spa;
      const defStage = isPhysical ? defender.boosts.def : defender.boosts.spd;
      let atkRaw = isPhysical ? attacker.stats.atk : attacker.stats.spa;
      if (isPhysical && (attacker.ability === "huge power" || attacker.ability === "pure power")) atkRaw *= 2;
      const gutsActive = attacker.ability === "guts" && attacker.status !== "none";
      if (gutsActive && isPhysical) atkRaw *= 1.5;
      if (isPhysical && attacker.heldItem === "choice band") atkRaw *= 1.5;
      if (!isPhysical && attacker.heldItem === "choice specs") atkRaw *= 1.5;
      const pinch = { blaze: "Fire", torrent: "Water", overgrow: "Grass", swarm: "Bug" }[attacker.ability];
      if (pinch && pinch === move.moveType && attacker.hp.value <= attacker.hp.max / 3) atkRaw *= 1.5;
      // Crits ignore the attacker's negative and the defender's positive stages.
      const atk = atkRaw * stageMult(crit ? Math.max(0, atkStage) : atkStage);
      let defRaw = isPhysical ? defender.stats.def : defender.stats.spd;
      if (!isPhysical && defender.heldItem === "assault vest") defRaw *= 1.5;
      const def = defRaw * stageMult(crit ? Math.min(0, defStage) : defStage);
      const effBurn = burned && !gutsActive;
      if (attacker.heldItem === "life orb") typeMult *= 1.3;

      // Z-Move: a held Z-Crystal empowers a single attack (1.6×), then is spent.
      if (attacker.heldItem === "z-crystal" && !attacker.zUsed) {
        typeMult *= 1.6; attacker.zUsed = true; log.push(`${attacker.name} unleashed its Z-Power!`);
      }
      // Dynamax: Max Moves strike harder while the transformation lasts (~1.5×).
      if (attacker.dynamaxTurns > 0) typeMult *= 1.5;

      const preFull = defender.hp.value >= defender.hp.max;
      const hits = move.multihit ? (move.multihit[0] === move.multihit[1] ? move.multihit[0] : move.multihit[0] + Math.floor(rng() * (move.multihit[1] - move.multihit[0] + 1))) : 1;
      let total = 0;
      for (let h = 0; h < hits && defender.hp.value > 0; h++) {
        const res = damageCalc({
          level: attacker.level, power: move.power, atk, def,
          stab: attacker.types.includes(move.moveType) ? (attacker.ability === "adaptability" ? 2 : 1.5) : 1,
          typeMult, crit, burn: effBurn, rng
        });
        defender.hp.value = Math.max(0, defender.hp.value - res.damage);
        total += res.damage;
      }
      // Sturdy / Focus Sash: survive an OHKO from full HP.
      if (preFull && defender.hp.value <= 0 && (defender.ability === "sturdy" || (defender.heldItem === "focus sash" && !defender.sashUsed))) {
        defender.hp.value = 1;
        if (defender.heldItem === "focus sash") defender.sashUsed = true;
        log.push(`${defender.name} hung on!`);
      }
      // Contact / item recoil (Magic Guard skips all of it).
      if (attacker.ability !== "magic guard") {
        if (attacker.heldItem === "life orb" && total > 0) attacker.hp.value = Math.max(0, attacker.hp.value - Math.max(1, Math.floor(attacker.hp.max / 10)));
        if (move.contact && total > 0 && defender.hp.value > 0 && defender.heldItem === "rocky helmet") {
          attacker.hp.value = Math.max(0, attacker.hp.value - Math.max(1, Math.floor(attacker.hp.max / 6)));
          log.push(`${attacker.name} was hurt by ${defender.name}'s Rocky Helmet!`);
        }
        if (move.contact && total > 0 && defender.hp.value > 0 && (defender.ability === "rough skin" || defender.ability === "iron barbs")) {
          attacker.hp.value = Math.max(0, attacker.hp.value - Math.max(1, Math.floor(attacker.hp.max / 8)));
          log.push(`${attacker.name} was hurt by ${defender.name}'s ${defender.ability}!`);
        }
      }
      if (!defender.berryUsed && defender.heldItem === "sitrus berry" && defender.hp.value > 0 && defender.hp.value <= defender.hp.max / 2) {
        defender.hp.value = Math.min(defender.hp.max, defender.hp.value + Math.floor(defender.hp.max / 4));
        defender.berryUsed = true; log.push(`${defender.name} ate its Sitrus Berry!`);
      }
      log.push(`${attacker.name} used ${move.name} → ${total}${hits > 1 ? ` (${hits} hits)` : ""}${crit ? " (crit!)" : ""} (${defender.name} ${defender.hp.value}/${defender.hp.max})`);
      if (move.drain && total > 0) attacker.hp.value = Math.min(attacker.hp.max, attacker.hp.value + Math.max(1, Math.floor(total * move.drain)));
      if (move.recoil && total > 0 && attacker.ability !== "magic guard") attacker.hp.value = Math.max(0, attacker.hp.value - Math.max(1, Math.floor(total * move.recoil)));
      if (defender.hp.value > 0 && defender.status === "none" && move.secondaryStatus && move.secondaryChance && Math.floor(rng() * 100) < move.secondaryChance) {
        defender.status = move.secondaryStatus; defender.statusTurns = 0; log.push(`${defender.name} was ${move.secondaryStatus}!`);
      }
      if (defender.hp.value > 0 && move.secondaryBoosts && move.secondaryChance && Math.floor(rng() * 100) < move.secondaryChance) applyBoosts(defender, move.secondaryBoosts);
      if (defender.hp.value > 0 && move.flinchChance && Math.floor(rng() * 100) < move.flinchChance) defender.flinch = true;
      if (defender.hp.value > 0 && defender.confusion <= 0 && move.confuseChance && Math.floor(rng() * 100) < move.confuseChance) { defender.confusion = 2 + Math.floor(rng() * 4); log.push(`${defender.name} became confused!`); }
    } else {
      log.push(`${attacker.name} used ${move.name}.`);
      if (defender.hp.value > 0 && defender.status === "none" && move.inflictStatus) { defender.status = move.inflictStatus; defender.statusTurns = 0; log.push(`${defender.name} was ${move.inflictStatus}!`); }
      if (move.boosts) applyBoosts(move.boostTarget === "self" ? attacker : defender, move.boosts);
      if (move.healSelf) { attacker.hp.value = Math.min(attacker.hp.max, attacker.hp.value + Math.max(1, Math.floor(attacker.hp.max * move.healSelf))); log.push(`${attacker.name} restored HP.`); }
      if (move.weather) { const w = { raindance: "rain", sunnyday: "sun", sandstorm: "sand", hail: "snow", snowscape: "snow" }[move.weather]; if (w) { weather.type = w; weather.turns = 5; log.push(`The weather turned to ${w}.`); } }
      if (move.sideCondition) {
        const sc = move.sideCondition;
        if (sc === "reflect") { side[sideOf(attacker)].reflect = 5; log.push("Reflect raised Defense!"); }
        else if (sc === "lightscreen") { side[sideOf(attacker)].lightscreen = 5; log.push("Light Screen raised Sp. Def!"); }
        else if (sc === "stealthrock") { side[sideOf(defender)].stealthrock = true; log.push("Pointed stones float around the foe!"); }
        else if (sc === "spikes") { const ds = side[sideOf(defender)]; ds.spikes = Math.min(3, ds.spikes + 1); log.push("Spikes were scattered!"); }
        else if (sc === "toxicspikes") { const ds = side[sideOf(defender)]; ds.toxicspikes = Math.min(2, ds.toxicspikes + 1); log.push("Toxic Spikes were scattered!"); }
      }
      if (defender.hp.value > 0 && defender.confusion <= 0 && move.confuseChance && Math.floor(rng() * 100) < move.confuseChance) { defender.confusion = 2 + Math.floor(rng() * 4); log.push(`${defender.name} became confused!`); }
    }
  };

  const speed = (mon) => {
    let s = mon.stats.spe * stageMult(mon.boosts.spe) * (mon.status === "paralysis" ? 0.5 : 1) * (mon.heldItem === "choice scarf" ? 1.5 : 1);
    if ((mon.ability === "swift swim" && weather.type === "rain")
        || (mon.ability === "chlorophyll" && weather.type === "sun")
        || (mon.ability === "sand rush" && weather.type === "sand")) s *= 2;
    return s;
  };

  // Battle gimmicks fired on switch-in (once per battle, whichever the mon can do).
  //  · Mega Evolution — holding the matching Mega Stone: scale stats by the mega's
  //    base-stat ratio, swap types + ability.
  //  · Terastallization — holding a Tera Orb: the mon becomes its single Tera type.
  //  (Z-Moves are per-attack, handled in strike; Dynamax is set up in prep.)
  const activateGimmick = (mon) => {
    if (!mon || mon.hp.value <= 0) return;
    if (!mon.megaUsed && mon.heldItem && mon.megaData?.length) {
      const mega = mon.megaData.find((m) => (m.item || "").toLowerCase() === mon.heldItem);
      if (mega && mega.stats) {
        mon.megaUsed = true;
        const oldMax = mon.hp.max;
        for (const k of ["hp", "atk", "def", "spa", "spd", "spe"]) {
          const base = mon.baseStats?.[k] || 1;
          const ratio = (mega.stats[k] ?? base) / base;
          mon.stats[k] = Math.max(1, Math.round((mon.stats[k] ?? base) * ratio));
        }
        mon.hp.max = mon.stats.hp;
        mon.hp.value = Math.min(mon.hp.max, Math.max(1, Math.round(mon.hp.value * mon.hp.max / oldMax)));
        if (Array.isArray(mega.types) && mega.types.length) mon.types = [...mega.types];
        if (mega.ability) mon.ability = mega.ability.toLowerCase();
        log.push(`${mon.name} Mega Evolved into ${mega.name}!`);
        return;
      }
    }
    if (!mon.teraUsed && mon.heldItem === "tera orb") {
      mon.teraUsed = true;
      mon.types = [mon.teraType || mon.types[0] || "Normal"];
      log.push(`${mon.name} Terastallized into the ${mon.types[0]} type!`);
    }
  };

  // Entry (lead) abilities: Intimidate + weather setters.
  const onEntry = (mon, foe) => {
    if (!mon) return;
    activateGimmick(mon);
    switch (mon.ability) {
      case "intimidate": if (foe) { foe.boosts.atk = clampStage(foe.boosts.atk - 1); log.push(`${mon.name}'s Intimidate cut ${foe.name}'s Attack!`); } break;
      case "drizzle": weather.type = "rain"; weather.turns = 5; log.push(`${mon.name} made it rain!`); break;
      case "drought": weather.type = "sun"; weather.turns = 5; log.push(`${mon.name} intensified the sun!`); break;
      case "sand stream": weather.type = "sand"; weather.turns = 5; log.push(`${mon.name} kicked up a sandstorm!`); break;
      case "snow warning": weather.type = "snow"; weather.turns = 5; log.push(`${mon.name} summoned a snowstorm!`); break;
    }
  };
  onEntry(A[0], B[0]);
  onEntry(B[0], A[0]);

  while (a < A.length && b < B.length && turns < maxTurns) {
    // Skip past any fainted lead (e.g. HP carried in from a previous gauntlet fight).
    while (a < A.length && A[a].hp.value <= 0) a++;
    while (b < B.length && B[b].hp.value <= 0) b++;
    if (a >= A.length || b >= B.length) break;
    // Switch-ins trigger entry abilities (Intimidate, weather) and take hazards.
    if (a !== prevA) { onEntry(A[a], B[b]); applyHazards(A[a]); prevA = a; }
    if (b !== prevB) { onEntry(B[b], A[a]); applyHazards(B[b]); prevB = b; }
    if (A[a].hp.value <= 0 || B[b].hp.value <= 0) continue; // hazards may KO a switch-in
    turns++;
    const atkA = A[a]; const atkB = B[b];
    // Order by move priority, then paralysis-adjusted Speed, ties random.
    const mvA = chooseBestMove(atkA, atkB); const mvB = chooseBestMove(atkB, atkA);
    let aFirst;
    if ((mvA.priority ?? 0) !== (mvB.priority ?? 0)) aFirst = (mvA.priority ?? 0) > (mvB.priority ?? 0);
    else if (speed(atkA) !== speed(atkB)) aFirst = speed(atkA) > speed(atkB);
    else aFirst = rng() < 0.5;
    const order = aFirst ? [[atkA, atkB], [atkB, atkA]] : [[atkB, atkA], [atkA, atkB]];

    for (const [attacker, defender] of order) {
      if (attacker.hp.value <= 0 || defender.hp.value <= 0) continue;
      if (!canAct(attacker)) continue;
      strike(attacker, defender);
      if (defender.hp.value <= 0) { log.push(`${defender.name} fainted!`); if (defender === atkA) a++; else b++; }
    }

    // End-of-turn chip (burn/poison) on the still-standing actives.
    for (const [mon, isA] of [[atkA, true], [atkB, false]]) {
      mon.flinch = false;
      if (mon.hp.value <= 0) continue;
      // Dynamax wears off after 3 turns: HP max halves back, current HP clamps.
      if (mon.dynamaxTurns > 0 && --mon.dynamaxTurns === 0) {
        const half = Math.max(1, Math.round(mon.hp.max / 2));
        mon.hp.max = half; mon.hp.value = Math.min(mon.hp.value, half);
        log.push(`${mon.name} returned to its normal size.`);
      }
      // Speed Boost.
      if (mon.ability === "speed boost" && mon.boosts.spe < 6) { mon.boosts.spe = clampStage(mon.boosts.spe + 1); log.push(`${mon.name}'s Speed Boost raised its Speed!`); }
      // Sandstorm chip (non Rock/Ground/Steel; sand/guard abilities are exempt).
      if (weather.type === "sand" && !mon.types.some((t) => ["Rock", "Ground", "Steel"].includes(t))
          && !["sand veil", "sand rush", "sand force", "magic guard", "overcoat"].includes(mon.ability)) {
        const s = Math.max(1, Math.floor(mon.hp.max / 16));
        mon.hp.value = Math.max(0, mon.hp.value - s);
        log.push(`${mon.name} is buffeted by the sandstorm (−${s}).`);
        if (mon.hp.value <= 0) { log.push(`${mon.name} fainted!`); if (isA) a++; else b++; continue; }
      }
      // Leftovers / Black Sludge recovery.
      if ((mon.heldItem === "leftovers" || (mon.heldItem === "black sludge" && mon.types.includes("Poison"))) && mon.hp.value < mon.hp.max) {
        const heal = Math.max(1, Math.floor(mon.hp.max / 16));
        mon.hp.value = Math.min(mon.hp.max, mon.hp.value + heal);
      }
      // Poison Heal recovers HP from poison; Magic Guard blocks all chip.
      if ((mon.status === "poison" || mon.status === "toxic") && mon.ability === "poison heal") {
        if (mon.hp.value < mon.hp.max) mon.hp.value = Math.min(mon.hp.max, mon.hp.value + Math.max(1, Math.floor(mon.hp.max / 8)));
        continue;
      }
      if (mon.ability === "magic guard") continue;
      // Status chip: toxic ramps 1/16 → 2/16 → …; poison 1/8; burn 1/16.
      let dmg = 0;
      if (mon.status === "toxic") { mon.toxicCounter = (mon.toxicCounter || 0) + 1; dmg = Math.max(1, Math.floor(mon.hp.max * mon.toxicCounter / 16)); }
      else if (STATUS_CHIP[mon.status]) dmg = Math.max(1, Math.floor(mon.hp.max * STATUS_CHIP[mon.status]));
      if (!dmg) continue;
      mon.hp.value = Math.max(0, mon.hp.value - dmg);
      log.push(`${mon.name} is hurt by ${mon.status === "toxic" ? "toxic poison" : mon.status} (−${dmg}).`);
      if (mon.hp.value <= 0) { log.push(`${mon.name} fainted!`); if (isA) a++; else b++; }
    }

    // Field effects tick down.
    if (weather.type !== "none" && --weather.turns <= 0) { log.push(`The ${weather.type} let up.`); weather.type = "none"; }
    for (const k of ["A", "B"]) { if (side[k].reflect > 0) side[k].reflect--; if (side[k].lightscreen > 0) side[k].lightscreen--; }
  }

  const winner = a >= A.length && b >= B.length ? "draw" : a >= A.length ? "B" : b >= B.length ? "A" : "draw";
  return { winner, log, turns, A, B };
}

/* -------------------------------------------- */
/*  Foundry wrappers                             */
/* -------------------------------------------- */

/** Build a combatant from a Pokémon Actor (its derived stats + move Items). */
export function combatantFromActor(actor) {
  const s = actor.system;
  return {
    name: actor.name,
    level: s.level,
    types: s.types ?? [],
    stats: s.stats ?? { hp: 20, atk: 10, def: 10, spa: 10, spd: 10, spe: 10 },
    baseStats: s.baseStats ?? { hp: 50, atk: 50, def: 50, spa: 50, spd: 50, spe: 50 },
    status: s.status ?? "none",
    ability: s.ability ?? "",
    heldItem: s.heldItem ?? "",
    megaData: s.megaData ?? [],
    teraType: s.teraType || s.types?.[0] || "Normal",
    dynamax: false,
    toxicCounter: s.toxicCounter ?? 0,
    hp: { value: s.hp?.value ?? s.stats?.hp, max: s.hp?.max ?? s.stats?.hp },
    moves: actor.items.filter((i) => i.type === "move").map((m) => ({
      name: m.name, moveType: m.system.moveType, category: m.system.category, power: m.system.power,
      priority: m.system.priority ?? 0, accuracy: m.system.accuracy ?? 100, alwaysHits: !!m.system.alwaysHits,
      inflictStatus: m.system.inflictStatus ?? "", secondaryStatus: m.system.secondaryStatus ?? "", secondaryChance: m.system.secondaryChance ?? 0,
      boosts: m.system.boosts ?? null, boostTarget: m.system.boostTarget ?? "target", secondaryBoosts: m.system.secondaryBoosts ?? null,
      drain: m.system.drain ?? 0, recoil: m.system.recoil ?? 0, healSelf: m.system.healSelf ?? 0,
      flinchChance: m.system.flinchChance ?? 0, multihit: m.system.multihit ?? null,
      contact: !!m.system.contact, pp: m.system.pp ?? 15,
      sideCondition: m.system.sideCondition ?? "", weather: m.system.weather ?? "", confuseChance: m.system.confuseChance ?? 0
    }))
  };
}

export async function teamOf(trainer) {
  const party = trainer.type === "trainer" ? await trainer.getParty() : [trainer];
  return party.filter((p) => p?.type === "pokemon").map(combatantFromActor);
}

/** Auto-resolve a battle between two trainers (or Pokémon) and post the log. */
export async function autoBattle(sideA, sideB) {
  const teamA = await teamOf(sideA);
  const teamB = await teamOf(sideB);
  if (!teamA.length || !teamB.length) return ui.notifications?.warn("Both sides need at least one Pokémon.");

  const { winner, log, turns } = simulateBattle(teamA, teamB);
  const winnerName = winner === "A" ? sideA.name : winner === "B" ? sideB.name : "Nobody (draw)";
  const shown = log.slice(0, 40);
  await ChatMessage.create({
    speaker: { alias: "Auto-Battle" },
    content: `
      <div class="pm-battle-card">
        <h3>${sideA.name} vs ${sideB.name}</h3>
        <p><strong>Winner: ${winnerName}</strong> <small>(${turns} turns)</small></p>
        <details><summary>Battle log</summary>
          <ol class="pm-battle-log">${shown.map((l) => `<li>${l}</li>`).join("")}${log.length > shown.length ? `<li>… ${log.length - shown.length} more</li>` : ""}</ol>
        </details>
      </div>`
  });
  return winner;
}

/**
 * Run a simple branching dialogue. `script` = { start, nodes: { key: { text,
 * choices:[{label, next, action?}] } } }. A choice's `action` (async) can start
 * a battle, give an item, etc.
 */
export async function startDialogue(script, { speaker = "NPC" } = {}) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2) return;
  let key = script.start ?? "start";
  for (let guard = 0; guard < 50 && key; guard++) {
    const node = script.nodes?.[key];
    if (!node) break;
    const choices = node.choices ?? [{ label: "Continue", next: node.next ?? null }];
    const idx = await DialogV2.wait({
      window: { title: speaker },
      content: `<p>${node.text}</p>`,
      buttons: choices.map((c, i) => ({ action: String(i), label: c.label, callback: () => i })),
      rejectClose: false
    }).catch(() => null);
    if (idx == null) break;
    const picked = choices[idx];
    if (picked.action) await picked.action();
    key = picked.next;
  }
}

export function registerNpcApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    npc: { autoBattle, simulateBattle, chooseBestMove, combatantFromActor, dialogue: startDialogue }
  });
}
