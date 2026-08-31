/**
 * Pokémon Masters — regional Gym Leaders, Elite Four & Professors.
 *
 * Each region has an ordered roster of Gym Leaders (with a type specialty and a
 * team), an Elite Four, a Champion, and a starter Professor. Challenging a
 * leader auto-battles their team against yours; a win earns the region's badge
 * and (for the Elite Four gauntlet) the Champion title.
 *
 * Leader teams are built as ephemeral combatants from the species pack — no
 * persistent NPC actors are spawned — so a challenge is cheap and repeatable.
 */

import { PM } from "./config.mjs";
import { resolveTrainer } from "./catch.mjs";
import { simulateBattle, teamOf } from "./npc.mjs";
import { statsAtLevel } from "./events.mjs";
import { levelCap } from "./gyms.mjs";

async function findSpecies(name) {
  const pack = game.packs.get("pokemon-masters.species");
  if (!pack) return null;
  const key = String(name).toLowerCase();
  const entry = pack.index.find((e) => e.name.toLowerCase() === key);
  return entry ? pack.getDocument(entry._id) : null;
}

/** Resolve up to 4 usable move-data objects for a species at a level. */
async function movesFor(doc, level) {
  const pack = game.packs.get("pokemon-masters.moves");
  const s = doc.system;
  const names = (s.learnset ?? []).filter((l) => l.level && l.level <= level).slice(-8).map((l) => l.move);
  const picked = [];
  for (const name of names) {
    const entry = pack?.index.find((e) => e.name.toLowerCase() === String(name).toLowerCase());
    if (!entry) continue;
    const m = (await pack.getDocument(entry._id)).system;
    picked.push({
      name, moveType: m.moveType, category: m.category, power: m.power, accuracy: m.accuracy ?? 100,
      priority: m.priority ?? 0, pp: m.pp ?? 15, contact: !!m.contact, inflictStatus: m.inflictStatus ?? "",
      secondaryStatus: m.secondaryStatus ?? "", secondaryChance: m.secondaryChance ?? 0, boosts: m.boosts ?? null,
      boostTarget: m.boostTarget ?? "target", multihit: m.multihit ?? null, drain: m.drain ?? 0
    });
    if (picked.length >= 4) break;
  }
  if (!picked.some((m) => m.category !== "Status")) {
    picked.push({ name: "Tackle", moveType: (s.types ?? [])[0] ?? "Normal", category: "Physical", power: 40, accuracy: 100, pp: 35, contact: true });
  }
  return picked.slice(0, 4);
}

/** Build a leader's team as combatants at the given level. */
async function leaderCombatants(team, level) {
  const out = [];
  for (const name of team) {
    const doc = await findSpecies(name);
    if (!doc) continue;
    const s = doc.system;
    const stats = statsAtLevel(s.baseStats, level);
    out.push({
      name: doc.name, level, types: s.types ?? ["Normal"], stats, baseStats: s.baseStats,
      ability: Object.values(s.abilities ?? {})[0] ?? s.ability ?? "", heldItem: "",
      hp: { value: stats.hp, max: stats.hp }, moves: await movesFor(doc, level)
    });
  }
  return out;
}

/** The roster entry for a region's gym index, or null. */
function leaderOf(region, index) {
  return PM.gymLeaders?.[region]?.leaders?.[index] ?? null;
}

/**
 * Challenge a region's gym leader (0-indexed). Auto-battles their team vs the
 * player's; on a win, awards the badge and raises the level cap.
 */
export async function gymChallenge(player, region, index) {
  player ??= resolveTrainer();
  if (!player) return ui.notifications?.warn("Assign your Trainer first.");
  const leader = leaderOf(region, index);
  if (!leader) return ui.notifications?.warn(`No gym leader #${index + 1} in ${PM.regions?.[region] ?? region}.`);

  const myTeam = await teamOf(player);
  if (!myTeam.length) return ui.notifications?.warn("You need a Pokémon in your party.");
  // Scale the leader to the challenger (a real gym feels level-appropriate).
  const level = Math.min(100, Math.max(...myTeam.map((m) => m.level ?? 5)) + 2 + index);
  const foe = await leaderCombatants(leader.team, level);
  const { winner, log } = simulateBattle(myTeam.map((m) => ({ ...m, hp: { value: m.stats.hp, max: m.stats.hp } })), foe);
  const won = winner === "A";

  const badge = `${leader.badge} Badge`;
  if (won) {
    const badges = [...(player.system.badges ?? [])];
    if (!badges.includes(badge)) { badges.push(badge); await player.update({ "system.badges": badges }); }
  }
  await ChatMessage.create({
    speaker: { alias: `${leader.name}'s Gym` },
    content: `<div class="pm-encounter-card">
      <h3>${leader.name} — ${leader.type}-type Gym${leader.city ? ` (${leader.city})` : ""}</h3>
      <p>${won
        ? `<span class="pm-caught">Victory!</span> You earned the <strong>${badge}</strong>. Level cap is now ${levelCap(player)}.`
        : `${leader.name} was too strong. Train up and challenge them again!`}</p>
      <details><summary>Battle log</summary><ol class="pm-battle-log"><li>${log.slice(0, 30).join("</li><li>")}</li></ol></details>
    </div>`
  });
  return { won, badge };
}

/**
 * Run the region's Elite Four (and Champion) as a consecutive gauntlet. HP does
 * NOT restore between bouts, matching the League challenge.
 */
export async function eliteFourChallenge(player, region) {
  player ??= resolveTrainer();
  if (!player) return ui.notifications?.warn("Assign your Trainer first.");
  const four = PM.gymLeaders?.[region]?.eliteFour ?? [];
  const champ = PM.gymLeaders?.[region]?.champion;
  if (!four.length) return ui.notifications?.warn(`${PM.regions?.[region] ?? region} has no Elite Four.`);
  const need = (PM.gymLeaders?.[region]?.leaders ?? []).length || 8;
  if ((player.system.badges ?? []).length < need) {
    return ui.notifications?.warn(`You need all ${need} ${PM.regions?.[region] ?? region} badges before challenging the Elite Four.`);
  }

  let myTeam = await teamOf(player);
  const baseLevel = Math.min(100, Math.max(...myTeam.map((m) => m.level ?? 5)) + 5);
  const bouts = [...four.map((m, i) => ({ ...m, level: baseLevel + i })), ...(champ ? [{ name: champ, type: "Champion", team: four.flatMap((m) => m.team).slice(0, 6), level: baseLevel + 5 }] : [])];
  const log = [];
  for (const bout of bouts) {
    const foe = await leaderCombatants(bout.team, bout.level);
    const res = simulateBattle(myTeam, foe);
    log.push(`— vs ${bout.name} (${bout.type}): ${res.winner === "A" ? "won" : "LOST"}`);
    if (res.winner !== "A") {
      await ChatMessage.create({ speaker: { alias: "Pokémon League" }, content: `<div class="pm-battle-card"><h3>${player.name} fell to ${bout.name}.</h3><p>${log.join("<br>")}</p></div>` });
      return { won: false, fellTo: bout.name };
    }
    myTeam = res.A.map((m) => ({ ...m })); // carry surviving HP forward
  }
  const badges = [...(player.system.badges ?? [])];
  if (!badges.includes("Champion")) { badges.push("Champion"); await player.update({ "system.badges": badges }); }
  await ChatMessage.create({
    speaker: { alias: "Pokémon League" },
    content: `<div class="pm-encounter-card"><h3>🏆 ${player.name} is the ${PM.regions?.[region] ?? region} Champion!</h3><p>${log.join("<br>")}</p></div>`
  });
  return { won: true };
}

/** The Professor who hands out starters in a region. */
export function professorFor(region) {
  return PM.gymLeaders?.[region]?.professor ?? "the Professor";
}

/** List a region's gym leaders (for UI / dialogue). */
export function gymRoster(region) {
  return PM.gymLeaders?.[region]?.leaders ?? [];
}

export function registerLeagueApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    league: { gymChallenge, eliteFourChallenge, professorFor, gymRoster }
  });
}
