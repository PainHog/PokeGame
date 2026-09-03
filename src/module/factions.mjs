/**
 * Pokémon Masters — faction encounters: Rocket raids, street & stadium battles.
 *
 * Ties the organization system to the tile layer. A **Faction Ambush** region
 * behavior can trigger a battle against an NPC of a faction (Team Rocket, a
 * wandering trainer) when a player steps on it — but not if the player belongs
 * to that faction. Stadiums run tournament brackets with healing between rounds.
 *
 * Battles resolve through the rule-based engine (npc.mjs), so ambushes and
 * tournaments can play out unattended.
 */

import { PM } from "./config.mjs";
import { autoBattle } from "./npc.mjs";
import { addReputation } from "./organizations.mjs";
import { isResponsible } from "./permissions.mjs";
import { addToParty } from "./storage.mjs";

const fields = foundry.data.fields;
const EVENTS = { TOKEN_ENTER: "tokenEnter", TOKEN_MOVE_IN: "tokenMoveIn", TOKEN_MOVE_WITHIN: "tokenMoveWithin" };

function trainerFromEvent(event) {
  const token = event?.data?.token;
  const actor = token?.actor ?? null;
  return actor?.type === "trainer" ? { token, actor } : { token: null, actor: null };
}

/** Draw a random NPC trainer: an explicit one, else a random pick from a folder. */
async function pickOpponent(behavior) {
  if (behavior.npcUuid) {
    const npc = await fromUuid(behavior.npcUuid);
    if (npc?.type === "trainer") return npc;
  }
  if (behavior.folder) {
    const folder = game.folders?.find((f) => f.type === "Actor" && f.name === behavior.folder);
    const pool = (folder?.contents ?? []).filter((a) => a.type === "trainer");
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
  }
  return null;
}

/** Villains (Team Rocket & co.) make off with one of your Pokémon on a loss. */
async function villainSteal(player, faction, thiefName) {
  const party = await player.getParty();
  if (party.length <= 1) return; // never leave a trainer with no Pokémon
  const victim = party[party.length - 1];
  await victim.setFlag("pokemon-masters", "stolenBy", faction);
  const newParty = (player.system.party ?? []).filter((u) => u !== victim.uuid);
  await player.update({ "system.party": newParty });
  const team = PM.organizations[faction]?.label ?? thiefName;
  await ChatMessage.create({
    speaker: { alias: "⚠ Theft!" },
    content: `<div class="pm-encounter-card"><h3>😈 ${team} stole your ${victim.name}!</h3><p>Defeat them in a rematch to get it back.</p></div>`
  });
}

/** Recover any Pokémon this faction stole from you (on a win against them). */
async function recoverStolen(player, faction) {
  const stolen = (game.actors ?? []).filter((a) => a.type === "pokemon"
    && a.system?.trainer === player.uuid && a.getFlag("pokemon-masters", "stolenBy") === faction);
  for (const mon of stolen) {
    await mon.unsetFlag("pokemon-masters", "stolenBy");
    // Route through addToParty so a full party sends the recovered Pokémon to the
    // PC instead of dropping it (respecting the six-member cap).
    const held = [...(player.system.party ?? []), ...(player.system.storage ?? [])];
    if (!held.includes(mon.uuid)) await addToParty(player, mon);
    await ChatMessage.create({ speaker: { alias: "Recovered!" }, content: `<div class="pm-encounter-card"><p>💪 You got your <strong>${mon.name}</strong> back!</p></div>` });
  }
}

/** Award/deduct money and reputation after an ambush. */
async function settleAmbush(player, opponent, faction, won, moneyReward) {
  const money = player.system.money ?? 0;
  if (won) {
    await player.update({ "system.money": money + moneyReward });
    // Beating a villain faction earns League standing, if enrolled.
    if (PM.organizations[faction]?.align === "villain"
        && (player.system.affiliations ?? []).some((a) => a.org === "league")) {
      await addReputation(player, "league", 40);
    }
    await ChatMessage.create({ speaker: { alias: "Battle" }, content: `<p>${player.name} won and earned ₽${moneyReward}!</p>` });
    if (PM.organizations[faction]?.align === "villain") await recoverStolen(player, faction);
  } else {
    const lost = Math.floor(money / 2);
    await player.update({ "system.money": money - lost });
    await ChatMessage.create({ speaker: { alias: "Battle" }, content: `<p>${player.name} lost to ${opponent.name} and dropped ₽${lost}.</p>` });
    // Villains don't just take your money — they may steal a Pokémon.
    if (PM.organizations[faction]?.align === "villain" && Math.random() < 0.3) {
      await villainSteal(player, faction, opponent.name);
    }
  }
}

/* -------------------------------------------- */
/*  Faction Ambush region behavior               */
/* -------------------------------------------- */

export class AmbushBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["PM.RegionBehavior.Ambush"];

  static defineSchema() {
    return {
      faction: new fields.StringField({
        required: true, blank: false, initial: "rocket",
        choices: { ...Object.fromEntries(Object.entries(PM.organizations).map(([k, v]) => [k, v.label])), trainers: "Wandering Trainers" }
      }),
      chance: new fields.NumberField({ required: true, integer: true, min: 0, max: 100, initial: 15 }),
      onEveryStep: new fields.BooleanField({ initial: false }),
      npcUuid: new fields.DocumentUUIDField({ type: "Actor", required: false, nullable: true, initial: null }),
      folder: new fields.StringField({ required: false, blank: true, initial: "" }),
      mode: new fields.StringField({ required: true, blank: false, initial: "auto", choices: { auto: "Auto-resolve", prompt: "Announce only" } }),
      moneyReward: new fields.NumberField({ required: true, integer: true, min: 0, initial: 300 })
    };
  }

  // tokenMoveIn = entry step; tokenMoveWithin (gated) = internal steps. Not
  // tokenEnter — it double-fires with tokenMoveIn on entry.
  static events = {
    [EVENTS.TOKEN_MOVE_IN]: async function (event) { return AmbushBehaviorType.run.call(this, event); },
    [EVENTS.TOKEN_MOVE_WITHIN]: async function (event) { if (this.onEveryStep) return AmbushBehaviorType.run.call(this, event); }
  };

  static async run(event) {
    const { token, actor } = trainerFromEvent(event);
    if (!actor) return;
    if (!isResponsible(token)) return;
    if (Math.floor(Math.random() * 100) >= this.chance) return;

    // Allies aren't ambushed by their own faction.
    if ((actor.system.affiliations ?? []).some((a) => a.org === this.faction)) return;

    const opponent = await pickOpponent(this);
    const label = PM.organizations[this.faction]?.label ?? "A wandering trainer";

    if (!opponent) {
      await ChatMessage.create({ speaker: { alias: label }, content: `<div class="pm-battle-card"><p><strong>${label}</strong> blocks ${actor.name}'s path! (Set an NPC or folder on this ambush to auto-resolve.)</p></div>` });
      return;
    }

    await ChatMessage.create({ speaker: { alias: label }, content: `<div class="pm-battle-card"><h3>${opponent.name} (${label}) ambushes ${actor.name}!</h3></div>` });
    if (this.mode !== "auto") return;

    const winner = await autoBattle(actor, opponent);
    await settleAmbush(actor, opponent, this.faction, winner === "A", this.moneyReward);
  }
}

/* -------------------------------------------- */
/*  Stadium tournaments & street battles         */
/* -------------------------------------------- */

/** A stadium bracket: sequential matches with healing between rounds. */
export async function stadiumTournament(player, opponents = [], { prize = 1000 } = {}) {
  if (player?.type !== "trainer" || !opponents.length) return ui.notifications?.warn("Provide the player and opponents.");
  for (let i = 0; i < opponents.length; i++) {
    const opp = opponents[i];
    const winner = await autoBattle(player, opp); // teamOf rebuilds full HP → healed between rounds
    if (winner !== "A") {
      await ChatMessage.create({ speaker: { alias: "Stadium" }, content: `<p>${player.name} is knocked out of the tournament by ${opp.name}.</p>` });
      return false;
    }
  }
  await player.update({ "system.money": (player.system.money ?? 0) + prize });
  await ChatMessage.create({ speaker: { alias: "Stadium" }, content: `<div class="pm-encounter-card"><h3>🏟️ ${player.name} won the tournament!</h3><p>Prize: ₽${prize}</p></div>` });
  return true;
}

/** A one-off street battle vs a wandering trainer. */
export async function streetBattle(player, opponent) {
  if (player?.type !== "trainer" || opponent?.type !== "trainer") return ui.notifications?.warn("Two Trainers required.");
  const winner = await autoBattle(player, opponent);
  await settleAmbush(player, opponent, "trainers", winner === "A", 150);
  return winner === "A";
}

export function registerFactionApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    factions: { stadium: stadiumTournament, street: streetBattle }
  });
}
