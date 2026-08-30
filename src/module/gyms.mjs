/**
 * Pokémon Masters — gyms, badges & the League challenge.
 *
 * A gym leader is an NPC trainer with a team. Beating them earns a badge and
 * (if the player is in the League) reputation. The Elite Four + Champion is a
 * gauntlet: sequential battles with HP carried over — no healing between — that
 * ends in the Champion title.
 *
 * Battles resolve through the same rule-based engine NPCs use (npc.mjs), so a
 * gym or the whole League can play out unattended.
 */

import { PM } from "./config.mjs";
import { autoBattle, simulateBattle, teamOf } from "./npc.mjs";
import { addReputation } from "./organizations.mjs";
import { rankTitle } from "./organizations.mjs";

/** Soft level cap from badges earned (obedience-style). */
export function levelCap(trainer) {
  const badges = trainer?.system?.badges?.length ?? 0;
  return PM.levelCapBase + badges * PM.levelCapPerBadge;
}

/** Challenge a gym leader. On a win, award the badge (+ League reputation). */
export async function gymBattle(playerTrainer, gymLeader, { badge } = {}) {
  if (playerTrainer?.type !== "trainer" || gymLeader?.type !== "trainer") {
    return ui.notifications?.warn("Both sides must be Trainers.");
  }
  const winner = await autoBattle(playerTrainer, gymLeader);
  const badgeName = badge ?? `${gymLeader.name} Badge`;

  if (winner !== "A") {
    await ChatMessage.create({
      speaker: { alias: "Gym" },
      content: `<div class="pm-battle-card"><p>${playerTrainer.name} was defeated by <strong>${gymLeader.name}</strong>. Train up and try again!</p></div>`
    });
    return false;
  }

  const badges = [...(playerTrainer.system.badges ?? [])];
  if (!badges.includes(badgeName)) {
    badges.push(badgeName);
    await playerTrainer.update({ "system.badges": badges });
  }
  if ((playerTrainer.system.affiliations ?? []).some((a) => a.org === "league")) {
    await addReputation(playerTrainer, "league", 100);
  }
  await ChatMessage.create({
    speaker: { alias: "Gym" },
    content: `<div class="pm-encounter-card"><h3>${playerTrainer.name} earned the ${badgeName}!</h3><p>Level cap is now ${levelCap(playerTrainer)}.</p></div>`
  });
  return true;
}

/**
 * Run the League gauntlet: an ordered list of NPC trainers (the Elite Four,
 * then the Champion last). The player's team HP carries across fights with no
 * healing. Winning all crowns them Champion.
 */
export async function leagueChallenge(playerTrainer, gauntlet = []) {
  if (playerTrainer?.type !== "trainer" || !gauntlet.length) {
    return ui.notifications?.warn("Provide the player and the Elite Four/Champion trainers.");
  }
  let team = await teamOf(playerTrainer);
  if (!team.length) return ui.notifications?.warn(`${playerTrainer.name} has no Pokémon.`);

  for (let i = 0; i < gauntlet.length; i++) {
    const opponent = gauntlet[i];
    const isChampion = i === gauntlet.length - 1;
    const oppTeam = await teamOf(opponent);
    const res = simulateBattle(team, oppTeam);

    await ChatMessage.create({
      speaker: { alias: isChampion ? "Champion" : "Elite Four" },
      content: `
        <div class="pm-battle-card">
          <h3>${playerTrainer.name} vs ${opponent.name}${isChampion ? " (Champion)" : ""}</h3>
          <p><strong>${res.winner === "A" ? playerTrainer.name + " wins!" : opponent.name + " wins."}</strong> <small>(${res.turns} turns)</small></p>
        </div>`
    });

    if (res.winner !== "A") {
      await ChatMessage.create({
        speaker: { alias: "League" },
        content: `<p>${playerTrainer.name}'s challenge ends at <strong>${opponent.name}</strong>. Heal up and return!</p>`
      });
      return false;
    }
    team = res.A; // survivors carry their remaining HP into the next fight — no heals
  }

  // Champion!
  const badges = [...(playerTrainer.system.badges ?? [])];
  if (!badges.includes("Champion")) badges.push("Champion");
  await playerTrainer.update({ "system.badges": badges });
  if ((playerTrainer.system.affiliations ?? []).some((a) => a.org === "league")) {
    await addReputation(playerTrainer, "league", 600); // vault to the top of the ladder
  }
  await ChatMessage.create({
    speaker: { alias: "League" },
    content: `<div class="pm-encounter-card"><h3>🏆 ${playerTrainer.name} is the new Champion!</h3><p>${rankTitle("league", 5)} of the Pokémon League.</p></div>`
  });
  return true;
}

export function registerGymApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    gym: { battle: gymBattle, league: leagueChallenge, levelCap }
  });
}
