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

/** Fallback move when a combatant knows none. */
function defaultMove(types) {
  return { name: "Struggle", moveType: types?.[0] ?? "Normal", category: "Physical", power: 50 };
}

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
  const moves = attacker.moves?.length ? attacker.moves : [defaultMove(attacker.types)];
  let best = moves[0];
  let bestScore = -1;
  for (const move of moves) {
    const score = expectedDamage(move, attacker, defender);
    if (score > bestScore) { bestScore = score; best = move; }
  }
  // While healthy, a setup sweeper first raises its own offensive stat (to +2)
  // instead of attacking — so Swords Dance / Nasty Plot actually get used.
  const hpFrac = (attacker.hp?.value ?? 1) / (attacker.hp?.max ?? 1);
  if (hpFrac > 0.7) {
    const setup = moves.find((m) => m.category === "Status" && m.boosts && m.boostTarget === "self"
      && Object.entries(m.boosts).some(([st, v]) => v > 0 && ["atk", "spa", "spe"].includes(st) && (attacker.boosts?.[st] ?? 0) < 2));
    if (setup) return setup;
  }
  return best;
}

/** Deep-ish copy of a combatant with working HP. */
function prep(c) {
  const maxHp = c.hp?.max ?? c.stats.hp;
  return {
    name: c.name,
    level: c.level ?? 5,
    types: [...(c.types ?? [])],
    stats: { ...c.stats },
    status: c.status ?? "none",
    statusTurns: 0,
    ability: (c.ability ?? "").toLowerCase(),
    boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
    flinch: false,
    moves: (c.moves ?? []).map((m) => ({ ...m })),
    hp: { value: c.hp?.value ?? maxHp, max: maxHp }
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
  const weather = { type: "none" };

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
      let typeMult = typeMultiplier(move.moveType, defender.types);
      if (defender.ability === "thick fat" && (move.moveType === "Fire" || move.moveType === "Ice")) typeMult *= 0.5;
      if (defender.ability === "wonder guard" && typeMult < 2) { log.push(`${defender.name}'s Wonder Guard blocked ${move.name}!`); return; }
      // Weather damage modifiers.
      if (weather.type === "rain") typeMult *= move.moveType === "Water" ? 1.5 : move.moveType === "Fire" ? 0.5 : 1;
      else if (weather.type === "sun") typeMult *= move.moveType === "Fire" ? 1.5 : move.moveType === "Water" ? 0.5 : 1;

      const atkStage = isPhysical ? attacker.boosts.atk : attacker.boosts.spa;
      const defStage = isPhysical ? defender.boosts.def : defender.boosts.spd;
      let atkRaw = isPhysical ? attacker.stats.atk : attacker.stats.spa;
      if (isPhysical && (attacker.ability === "huge power" || attacker.ability === "pure power")) atkRaw *= 2;
      const gutsActive = attacker.ability === "guts" && attacker.status !== "none";
      if (gutsActive && isPhysical) atkRaw *= 1.5;
      // Crits ignore the attacker's negative and the defender's positive stages.
      const atk = atkRaw * stageMult(crit ? Math.max(0, atkStage) : atkStage);
      const def = (isPhysical ? defender.stats.def : defender.stats.spd) * stageMult(crit ? Math.min(0, defStage) : defStage);
      const effBurn = burned && !gutsActive;

      const preFull = defender.hp.value >= defender.hp.max;
      const hits = move.multihit ? (move.multihit[0] === move.multihit[1] ? move.multihit[0] : move.multihit[0] + Math.floor(rng() * (move.multihit[1] - move.multihit[0] + 1))) : 1;
      let total = 0;
      for (let h = 0; h < hits && defender.hp.value > 0; h++) {
        const res = damageCalc({
          level: attacker.level, power: move.power, atk, def,
          stab: attacker.types.includes(move.moveType) ? 1.5 : 1,
          typeMult, crit, burn: effBurn, rng
        });
        defender.hp.value = Math.max(0, defender.hp.value - res.damage);
        total += res.damage;
      }
      // Sturdy: survive an OHKO from full HP.
      if (defender.ability === "sturdy" && preFull && defender.hp.value <= 0) { defender.hp.value = 1; log.push(`${defender.name} hung on with Sturdy!`); }
      log.push(`${attacker.name} used ${move.name} → ${total}${hits > 1 ? ` (${hits} hits)` : ""}${crit ? " (crit!)" : ""} (${defender.name} ${defender.hp.value}/${defender.hp.max})`);
      if (move.drain && total > 0) attacker.hp.value = Math.min(attacker.hp.max, attacker.hp.value + Math.max(1, Math.floor(total * move.drain)));
      if (move.recoil && total > 0) attacker.hp.value = Math.max(0, attacker.hp.value - Math.max(1, Math.floor(total * move.recoil)));
      if (defender.hp.value > 0 && defender.status === "none" && move.secondaryStatus && move.secondaryChance && Math.floor(rng() * 100) < move.secondaryChance) {
        defender.status = move.secondaryStatus; defender.statusTurns = 0; log.push(`${defender.name} was ${move.secondaryStatus}!`);
      }
      if (defender.hp.value > 0 && move.secondaryBoosts && move.secondaryChance && Math.floor(rng() * 100) < move.secondaryChance) applyBoosts(defender, move.secondaryBoosts);
      if (defender.hp.value > 0 && move.flinchChance && Math.floor(rng() * 100) < move.flinchChance) defender.flinch = true;
    } else {
      log.push(`${attacker.name} used ${move.name}.`);
      if (defender.hp.value > 0 && defender.status === "none" && move.inflictStatus) { defender.status = move.inflictStatus; defender.statusTurns = 0; log.push(`${defender.name} was ${move.inflictStatus}!`); }
      if (move.boosts) applyBoosts(move.boostTarget === "self" ? attacker : defender, move.boosts);
      if (move.healSelf) { attacker.hp.value = Math.min(attacker.hp.max, attacker.hp.value + Math.max(1, Math.floor(attacker.hp.max * move.healSelf))); log.push(`${attacker.name} restored HP.`); }
    }
  };

  const speed = (mon) => mon.stats.spe * stageMult(mon.boosts.spe) * (mon.status === "paralysis" ? 0.5 : 1);

  // Entry (lead) abilities: Intimidate + weather setters.
  const onEntry = (mon, foe) => {
    if (!mon) return;
    switch (mon.ability) {
      case "intimidate": if (foe) { foe.boosts.atk = clampStage(foe.boosts.atk - 1); log.push(`${mon.name}'s Intimidate cut ${foe.name}'s Attack!`); } break;
      case "drizzle": weather.type = "rain"; log.push(`${mon.name} made it rain!`); break;
      case "drought": weather.type = "sun"; log.push(`${mon.name} intensified the sun!`); break;
      case "sand stream": weather.type = "sand"; log.push(`${mon.name} kicked up a sandstorm!`); break;
      case "snow warning": weather.type = "snow"; log.push(`${mon.name} summoned a snowstorm!`); break;
    }
  };
  onEntry(A[0], B[0]);
  onEntry(B[0], A[0]);

  while (a < A.length && b < B.length && turns < maxTurns) {
    // Skip past any fainted lead (e.g. HP carried in from a previous gauntlet fight).
    while (a < A.length && A[a].hp.value <= 0) a++;
    while (b < B.length && B[b].hp.value <= 0) b++;
    if (a >= A.length || b >= B.length) break;
    // Switch-ins trigger entry abilities (Intimidate, weather).
    if (a !== prevA) { onEntry(A[a], B[b]); prevA = a; }
    if (b !== prevB) { onEntry(B[b], A[a]); prevB = b; }
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
      const frac = STATUS_CHIP[mon.status];
      if (!frac) continue;
      const dmg = Math.max(1, Math.floor(mon.hp.max * frac));
      mon.hp.value = Math.max(0, mon.hp.value - dmg);
      log.push(`${mon.name} is hurt by ${mon.status} (−${dmg}).`);
      if (mon.hp.value <= 0) { log.push(`${mon.name} fainted!`); if (isA) a++; else b++; }
    }
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
    status: s.status ?? "none",
    ability: s.ability ?? "",
    hp: { value: s.hp?.value ?? s.stats?.hp, max: s.hp?.max ?? s.stats?.hp },
    moves: actor.items.filter((i) => i.type === "move").map((m) => ({
      name: m.name, moveType: m.system.moveType, category: m.system.category, power: m.system.power,
      priority: m.system.priority ?? 0, accuracy: m.system.accuracy ?? 100, alwaysHits: !!m.system.alwaysHits,
      inflictStatus: m.system.inflictStatus ?? "", secondaryStatus: m.system.secondaryStatus ?? "", secondaryChance: m.system.secondaryChance ?? 0,
      boosts: m.system.boosts ?? null, boostTarget: m.system.boostTarget ?? "target", secondaryBoosts: m.system.secondaryBoosts ?? null,
      drain: m.system.drain ?? 0, recoil: m.system.recoil ?? 0, healSelf: m.system.healSelf ?? 0,
      flinchChance: m.system.flinchChance ?? 0, multihit: m.system.multihit ?? null
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
