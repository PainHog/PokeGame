/**
 * Pokémon Masters — player-vs-player battle challenges + wagers.
 *
 * Two trainers can battle each other with no GM in the loop:
 *   1. One trainer challenges another (optionally staking money). A socket
 *      message asks the target's owner to accept.
 *   2. On accept, both sides escrow their stake and the fight begins. Each player
 *      picks moves from their Pokémon's sheet, targeting the opponent's active
 *      Pokémon — exactly like a wild battle, but neither side auto-retaliates.
 *   3. Because a player can't write the opponent's Pokémon, damage/status is
 *      relayed over the socket and applied by the Pokémon's OWNER (who then also
 *      detects a faint / team wipe authoritatively).
 *   4. When a trainer's whole team faints, the winner takes the pot.
 *
 * All state lives on a `pvp` flag on each trainer, so a reload mid-battle doesn't
 * strand anyone (the flag can be cleared from the sheet). Everything is peer to
 * peer over the "system.pokemon-masters" socket channel — no GM, no approval.
 */

import { ownerUserIdFor } from "./catch.mjs";

const FLAG = "pokemon-masters";
const CHANNEL = "system.pokemon-masters";

/* --------------------------------------------------------------- *
 *  Pure helpers (unit-testable)                                    *
 * --------------------------------------------------------------- */
/** How many of a party's Pokémon are still conscious. */
export function aliveCount(party) {
  return (party ?? []).filter((p) => (p?.system?.hp?.value ?? 0) > 0).length;
}
/** Winner's payout when both sides staked `wager`: they regain their own stake
 *  plus take the loser's — i.e. 2×wager credited back to the winner. */
export function winnerCredit(wager) { return Math.max(0, Math.round(wager)) * 2; }

/* --------------------------------------------------------------- *
 *  Lookup helpers                                                  *
 * --------------------------------------------------------------- */
const myTrainers = () => game.actors.filter((a) => a.type === "trainer" && a.isOwner);
const partyOf = async (trainer) => (typeof trainer.getParty === "function" ? await trainer.getParty() : []);
const say = (content) => ChatMessage.create({ speaker: { alias: "Battle" }, content: `<div class="pm-battle-card pm-pvp">${content}</div>` });

/* --------------------------------------------------------------- *
 *  Cross-owner apply: the target Pokémon's owner writes the change *
 * --------------------------------------------------------------- */
/** Apply `changes` to `targetActor`. If we own it, write directly; otherwise ask
 *  its owner (over the socket) to write it. Used by the battle engine so a move
 *  against another player's Pokémon actually lands. */
export async function relayApply(targetActor, changes) {
  if (!targetActor) return;
  if (targetActor.isOwner) return targetActor.update(changes);
  try { game.socket.emit(CHANNEL, { action: "pmApply", uuid: targetActor.uuid, changes }); } catch { /* no socket */ }
}

/* --------------------------------------------------------------- *
 *  Challenge flow                                                  *
 * --------------------------------------------------------------- */
/** Open the challenge dialog on `myTrainer`: pick an opponent + a wager. */
export async function challengeDialog(myTrainer) {
  const D = foundry.applications?.api?.DialogV2;
  if (!D) return ui.notifications?.warn("PvP needs the v13+ dialog.");
  if (!myTrainer?.isOwner) return ui.notifications?.warn("You can only battle from your own trainer.");
  if (aliveCount(await partyOf(myTrainer)) === 0) return ui.notifications?.warn("Your team has no Pokémon able to battle.");

  // Candidate opponents: other trainers with a player owner (not me).
  const opponents = game.actors.filter((a) => a.type === "trainer" && a.id !== myTrainer.id && a.hasPlayerOwner);
  if (!opponents.length) return ui.notifications?.warn("No other trainers to challenge.");

  const options = opponents.map((o) => `<option value="${o.id}">${o.name}</option>`).join("");
  const myMoney = myTrainer.system.money ?? 0;
  const content = `
    <div class="pm-pvp-form">
      <p>Challenge a trainer to a battle. Stake some of your ₽${myMoney} if you like — the winner takes the pot.</p>
      <p><label>Opponent <select name="opp">${options}</select></label></p>
      <p><label>Wager (₽) <input type="number" name="wager" value="0" min="0" max="${myMoney}" step="50"></label></p>
    </div>`;
  const data = await D.wait({
    window: { title: `${myTrainer.name} — Battle Challenge` },
    content,
    ok: { label: "Send Challenge", callback: (_e, button) => ({ opp: button.form.elements.opp.value, wager: Number(button.form.elements.wager.value) || 0 }) },
    rejectClose: false
  }).catch(() => null);
  if (!data) return;

  const opponent = game.actors.get(data.opp);
  if (!opponent) return;
  const wager = Math.max(0, Math.min(Math.round(data.wager), myMoney));
  const toUserId = ownerUserIdFor(opponent);
  if (!toUserId) return ui.notifications?.warn(`${opponent.name} has no active owner to accept.`);

  const challengeId = foundry.utils.randomID();
  await myTrainer.setFlag(FLAG, "pvpPending", { challengeId, opponentUuid: opponent.uuid, wager });
  game.socket.emit(CHANNEL, {
    action: "pmPvpChallenge", challengeId, wager,
    fromUuid: myTrainer.uuid, fromName: myTrainer.name, fromUserId: game.user.id,
    toUuid: opponent.uuid, toUserId
  });
  ui.notifications?.info(`Challenge sent to ${opponent.name}${wager ? ` (₽${wager} wager)` : ""}.`);
}

/** The target's client: prompt to accept, escrow the stake, arm the battle. */
async function onChallenge(msg) {
  const me = game.user.id;
  if (msg.toUserId && msg.toUserId !== me) return;                 // not addressed to me
  const myTrainer = await fromUuid(msg.toUuid).catch(() => null);
  if (!myTrainer?.isOwner) return;                                  // I don't own the target
  const D = foundry.applications?.api?.DialogV2; if (!D) return;

  const canAfford = (myTrainer.system.money ?? 0) >= msg.wager;
  const alive = aliveCount(await partyOf(myTrainer));
  const accept = alive > 0 && canAfford && await D.confirm({
    window: { title: "Battle Challenge!" },
    content: `<p><strong>${msg.fromName}</strong> challenges you to a battle${msg.wager ? ` with a <strong>₽${msg.wager}</strong> wager` : ""}!</p><p>Do you accept?</p>`,
    rejectClose: false
  }).catch(() => false);

  if (!accept) {
    game.socket.emit(CHANNEL, { action: "pmPvpResponse", accepted: false, challengeId: msg.challengeId, fromUuid: msg.fromUuid, fromUserId: msg.fromUserId, toName: myTrainer.name });
    if (alive > 0 && !canAfford) ui.notifications?.warn(`You can't cover the ₽${msg.wager} wager.`);
    return;
  }
  // Escrow my stake and record the active battle.
  if (msg.wager) await myTrainer.update({ "system.money": (myTrainer.system.money ?? 0) - msg.wager });
  await myTrainer.setFlag(FLAG, "pvp", { challengeId: msg.challengeId, opponentUuid: msg.fromUuid, opponentName: msg.fromName, wager: msg.wager });
  await myTrainer.unsetFlag(FLAG, "pvpPending").catch(() => {});
  game.socket.emit(CHANNEL, { action: "pmPvpResponse", accepted: true, challengeId: msg.challengeId, fromUuid: msg.fromUuid, fromUserId: msg.fromUserId, toUuid: msg.toUuid, toName: myTrainer.name, wager: msg.wager });
  ui.notifications?.info(`Battle on! Target ${msg.fromName}'s Pokémon and pick a move.`);
}

/** The challenger's client: finalise on the opponent's response. */
async function onResponse(msg) {
  if (msg.fromUserId && msg.fromUserId !== game.user.id) return;
  const myTrainer = await fromUuid(msg.fromUuid).catch(() => null);
  if (!myTrainer?.isOwner) return;
  const pending = myTrainer.getFlag(FLAG, "pvpPending");
  if (!pending || pending.challengeId !== msg.challengeId) return;
  await myTrainer.unsetFlag(FLAG, "pvpPending").catch(() => {});

  if (!msg.accepted) { ui.notifications?.info(`${msg.toName} declined your challenge.`); return; }
  if (msg.wager) await myTrainer.update({ "system.money": (myTrainer.system.money ?? 0) - msg.wager });
  await myTrainer.setFlag(FLAG, "pvp", { challengeId: msg.challengeId, opponentUuid: msg.toUuid, opponentName: msg.toName, wager: msg.wager });
  await say(`<h3>⚔️ ${myTrainer.name} vs ${msg.toName}!</h3><p>The battle begins${msg.wager ? ` — <strong>₽${msg.wager}</strong> on the line each</strong>` : ""}. Pick your moves!</p>`);
}

/* --------------------------------------------------------------- *
 *  Faint / win settlement                                          *
 * --------------------------------------------------------------- */
/** Called on the owner's client after their Pokémon takes (possibly relayed)
 *  damage. If that trainer is in a PvP and their whole team is down, they lose. */
async function checkWipe(pokemon) {
  if (!pokemon || pokemon.type !== "pokemon" || !pokemon.isOwner) return;
  if ((pokemon.system.hp?.value ?? 1) > 0) return;
  for (const trainer of myTrainers()) {
    const pvp = trainer.getFlag(FLAG, "pvp"); if (!pvp) continue;
    const party = await partyOf(trainer);
    if (!party.some((p) => p?.id === pokemon.id)) continue;         // not this trainer's Pokémon
    if (aliveCount(party) > 0) return;                              // still has fighters
    // This trainer is wiped → they lose. Settle locally, tell the winner.
    await trainer.unsetFlag(FLAG, "pvp").catch(() => {});
    await say(`<h3>${pvp.opponentName} defeated ${trainer.name}!</h3>${pvp.wager ? `<p>${pvp.opponentName} wins the ₽${pvp.wager} pot.</p>` : ""}`);
    game.socket.emit(CHANNEL, { action: "pmPvpResult", winnerUuid: pvp.opponentUuid, loserName: trainer.name, wager: pvp.wager, challengeId: pvp.challengeId });
    return;
  }
}

/** The winner's client: collect the pot. */
async function onResult(msg) {
  const winner = await fromUuid(msg.winnerUuid).catch(() => null);
  if (!winner?.isOwner) return;
  const pvp = winner.getFlag(FLAG, "pvp");
  if (!pvp || pvp.challengeId !== msg.challengeId) return;
  await winner.unsetFlag(FLAG, "pvp").catch(() => {});
  if (msg.wager) await winner.update({ "system.money": (winner.system.money ?? 0) + winnerCredit(msg.wager) });
  ui.notifications?.info(`You won the battle${msg.wager ? ` and ₽${msg.wager}!` : "!"}`);
}

/* --------------------------------------------------------------- */
export function registerPvpApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    pvp: { challengeDialog, relayApply, aliveCount, winnerCredit }
  });

  game.socket.on(CHANNEL, async (data) => {
    try {
      switch (data?.action) {
        case "pmApply": {
          const doc = await fromUuid(data.uuid).catch(() => null);
          if (doc?.isOwner) { await doc.update(data.changes); await checkWipe(doc); }
          break;
        }
        case "pmPvpChallenge": await onChallenge(data); break;
        case "pmPvpResponse": await onResponse(data); break;
        case "pmPvpResult": await onResult(data); break;
      }
    } catch (err) { console.warn("Pokémon Masters | PvP socket error", err); }
  });

  // A same-owner faint during PvP (e.g. recoil/status on your own Pokémon) settles too.
  Hooks.on("pmPokemonFainted", ({ target }) => { if (target?.isOwner) checkWipe(target); });
}
