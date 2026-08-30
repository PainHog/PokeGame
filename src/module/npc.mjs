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
    moves: (c.moves ?? []).map((m) => ({ ...m })),
    hp: { value: c.hp?.value ?? maxHp, max: maxHp }
  };
}

/**
 * Resolve a full battle between two teams of combatants.
 * @returns {{winner:"A"|"B"|"draw", log:string[], turns:number}}
 */
export function simulateBattle(teamAIn, teamBIn, { maxTurns = 300, rng = Math.random } = {}) {
  const A = teamAIn.map(prep);
  const B = teamBIn.map(prep);
  let a = 0; let b = 0;
  const log = [];
  let turns = 0;

  // Can this Pokémon act? Handles sleep (1–3 turns), freeze (20% thaw), paralysis (25% skip).
  const canAct = (mon) => {
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

  const strike = (attacker, defender) => {
    const move = chooseBestMove(attacker, defender);
    if (!move.alwaysHits && move.category !== "Status" && (move.accuracy ?? 100) > 0
        && Math.floor(rng() * 100) >= move.accuracy) { log.push(`${attacker.name}'s ${move.name} missed!`); return; }
    const isPhysical = move.category === "Physical";
    const crit = move.category !== "Status" && rng() < CRIT_CHANCE;
    const burned = attacker.status === "burn" && isPhysical;
    if (move.category !== "Status") {
      const res = damageCalc({
        level: attacker.level, power: move.power,
        atk: isPhysical ? attacker.stats.atk : attacker.stats.spa,
        def: isPhysical ? defender.stats.def : defender.stats.spd,
        stab: attacker.types.includes(move.moveType) ? 1.5 : 1,
        typeMult: typeMultiplier(move.moveType, defender.types),
        crit, burn: burned, rng
      });
      defender.hp.value = Math.max(0, defender.hp.value - res.damage);
      log.push(`${attacker.name} used ${move.name} → ${res.damage}${crit ? " (crit!)" : ""} (${defender.name} ${defender.hp.value}/${defender.hp.max})`);
    } else {
      log.push(`${attacker.name} used ${move.name}.`);
    }
    if (defender.hp.value > 0 && defender.status === "none") {
      let inflict = null;
      if (move.category === "Status" && move.inflictStatus) inflict = move.inflictStatus;
      else if (move.secondaryStatus && move.secondaryChance && Math.floor(rng() * 100) < move.secondaryChance) inflict = move.secondaryStatus;
      if (inflict) { defender.status = inflict; defender.statusTurns = 0; log.push(`${defender.name} was ${inflict}!`); }
    }
  };

  const speed = (mon) => mon.stats.spe * (mon.status === "paralysis" ? 0.5 : 1);

  while (a < A.length && b < B.length && turns < maxTurns) {
    // Skip past any fainted lead (e.g. HP carried in from a previous gauntlet fight).
    while (a < A.length && A[a].hp.value <= 0) a++;
    while (b < B.length && B[b].hp.value <= 0) b++;
    if (a >= A.length || b >= B.length) break;
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
      if (mon.hp.value <= 0) continue;
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
    hp: { value: s.hp?.value ?? s.stats?.hp, max: s.hp?.max ?? s.stats?.hp },
    moves: actor.items.filter((i) => i.type === "move").map((m) => ({
      name: m.name, moveType: m.system.moveType, category: m.system.category, power: m.system.power,
      priority: m.system.priority ?? 0, accuracy: m.system.accuracy ?? 100, alwaysHits: !!m.system.alwaysHits,
      inflictStatus: m.system.inflictStatus ?? "", secondaryStatus: m.system.secondaryStatus ?? "", secondaryChance: m.system.secondaryChance ?? 0
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
