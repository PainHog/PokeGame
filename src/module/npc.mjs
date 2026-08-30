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

import { damageCalc } from "./battle.mjs";
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

  const strike = (attacker, defender) => {
    const move = chooseBestMove(attacker, defender);
    const isPhysical = move.category === "Physical";
    const res = damageCalc({
      level: attacker.level,
      power: move.power,
      atk: isPhysical ? attacker.stats.atk : attacker.stats.spa,
      def: isPhysical ? defender.stats.def : defender.stats.spd,
      stab: attacker.types.includes(move.moveType) ? 1.5 : 1,
      typeMult: typeMultiplier(move.moveType, defender.types),
      rng
    });
    defender.hp.value = Math.max(0, defender.hp.value - res.damage);
    log.push(`${attacker.name} used ${move.name} → ${res.damage} dmg (${defender.name} ${defender.hp.value}/${defender.hp.max})`);
  };

  while (a < A.length && b < B.length && turns < maxTurns) {
    turns++;
    const atkA = A[a]; const atkB = B[b];
    // Faster acts first; ties broken randomly.
    const aFirst = atkA.stats.spe > atkB.stats.spe || (atkA.stats.spe === atkB.stats.spe && rng() < 0.5);
    const order = aFirst ? [[atkA, atkB], [atkB, atkA]] : [[atkB, atkA], [atkA, atkB]];

    for (const [attacker, defender] of order) {
      if (attacker.hp.value <= 0 || defender.hp.value <= 0) continue;
      strike(attacker, defender);
      if (defender.hp.value <= 0) {
        log.push(`${defender.name} fainted!`);
        if (defender === atkA) a++;
        else b++;
      }
    }
  }

  const winner = a >= A.length && b >= B.length ? "draw" : a >= A.length ? "B" : b >= B.length ? "A" : "draw";
  return { winner, log, turns };
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
    hp: { value: s.hp?.value ?? s.stats?.hp, max: s.hp?.max ?? s.stats?.hp },
    moves: actor.items.filter((i) => i.type === "move").map((m) => ({
      name: m.name, moveType: m.system.moveType, category: m.system.category, power: m.system.power
    }))
  };
}

async function teamOf(trainer) {
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
