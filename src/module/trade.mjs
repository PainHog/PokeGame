/**
 * Pokémon Masters — trading.
 *
 * Three ways to trade so a player is never stuck:
 *  • swap        — a GM/console two-trainer trade (reassigns ownership, checks
 *                  trade evolutions on both).
 *  • npcTradeOffer — a scripted NPC wants one species and gives another; lets a
 *                    solo player trade (and trade-evolve the received Pokémon).
 *  • tradeService — a paid machine that trades a Pokémon "back and forth" so its
 *                   trade evolution triggers, for a fee — no partner required.
 */

import { resolveTrainer } from "./catch.mjs";
import { evolveByTrade } from "./progression.mjs";
import { addToParty } from "./storage.mjs";
import { markCaught } from "./dex.mjs";
import { applyIndividuality } from "./individuality.mjs";

const TRADE_FEE = 1000;

async function findSpecies(name) {
  const pack = game.packs.get("pokemon-masters.species");
  if (!pack) return null;
  const key = String(name).toLowerCase();
  const entry = pack.index.find((e) => e.name.toLowerCase() === key);
  return entry ? pack.getDocument(entry._id) : null;
}

async function removeFromTrainer(trainer, uuid) {
  await trainer.update({
    "system.party": (trainer.system.party ?? []).filter((u) => u !== uuid),
    "system.storage": (trainer.system.storage ?? []).filter((u) => u !== uuid)
  });
}

/** Does this Pokémon have a trade evolution available right now? */
async function hasTradeEvo(pokemon) {
  for (const name of pokemon.system.evolution?.into ?? []) {
    const sp = await findSpecies(name);
    if (sp && sp.system.evolution?.method === "trade") return true;
  }
  return false;
}

/** GM/console: swap two Pokémon between two trainers, checking trade evolutions. */
export async function swap(trainerA, uuidA, trainerB, uuidB) {
  const [monA, monB] = await Promise.all([fromUuid(uuidA), fromUuid(uuidB)]);
  if (monA?.type !== "pokemon" || monB?.type !== "pokemon") return ui.notifications?.warn("Both must be Pokémon.");
  await removeFromTrainer(trainerA, uuidA);
  await removeFromTrainer(trainerB, uuidB);
  await monA.update({ "system.trainer": trainerB.uuid });
  await monB.update({ "system.trainer": trainerA.uuid });
  await addToParty(trainerB, monA);
  await addToParty(trainerA, monB);
  await markCaught(trainerB, monA.system.species.name);
  await markCaught(trainerA, monB.system.species.name);
  await ChatMessage.create({
    speaker: { alias: "Trade" },
    content: `<div class="pm-encounter-card"><h3>Trade complete!</h3><p>${trainerA.name} sent ${monA.name}, received ${monB.name}.</p></div>`
  });
  await evolveByTrade(monA);
  await evolveByTrade(monB);
}

/** A scripted NPC trade: give the NPC a `want`, receive a fresh `give`. */
export async function npcTradeOffer(trainer, want, give) {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Select or assign your Trainer first.");
  const uuids = [...(trainer.system.party ?? []), ...(trainer.system.storage ?? [])];
  const owned = (await Promise.all(uuids.map((u) => fromUuid(u)))).filter(Boolean);
  const mon = owned.find((m) => (m.system.species?.name ?? m.name).toLowerCase() === String(want).toLowerCase());
  if (!mon) return ui.notifications?.warn(`The trainer wants a ${want}, but you don't have one.`);

  const DialogV2 = foundry.applications?.api?.DialogV2;
  let ok = true;
  try { if (DialogV2) ok = await DialogV2.confirm({ window: { title: "Trade offer" }, content: `<p>A trainer offers their <strong>${give}</strong> for your <strong>${mon.name}</strong>. Accept?</p>` }); }
  catch (err) { /* proceed */ }
  if (!ok) return;

  const level = mon.system.level;
  await removeFromTrainer(trainer, mon.uuid);
  await mon.delete();

  const sp = await findSpecies(give);
  if (!sp) return ui.notifications?.warn(`Species not found: ${give}`);
  const src = sp.toObject();
  delete src._id;
  src.folder = null;
  src.system.level = level;
  src.system.hp = { value: null, max: 0 };
  src.system.trainer = trainer.uuid;
  applyIndividuality(src.system);
  const created = await Actor.implementation.create(src);
  await addToParty(trainer, created);
  await markCaught(trainer, sp.name);
  await ChatMessage.create({ speaker: { alias: "Trade" }, content: `<div class="pm-encounter-card"><h3>${trainer.name} received ${sp.name}!</h3></div>` });
  await evolveByTrade(created);
}

/** Paid service: trade a Pokémon "back and forth" to trigger its trade evolution. */
export async function tradeService(trainer, pokemon, fee = TRADE_FEE) {
  trainer ??= resolveTrainer();
  if (pokemon?.type !== "pokemon") return ui.notifications?.warn("Pick a Pokémon.");
  if (!(await hasTradeEvo(pokemon))) return ui.notifications?.info(`${pokemon.name} has no trade evolution.`);
  const money = trainer?.system.money ?? 0;
  if (money < fee) return ui.notifications?.warn(`The trade machine costs ₽${fee}; you have ₽${money}.`);
  await trainer.update({ "system.money": money - fee });
  const evolved = await evolveByTrade(pokemon);
  if (evolved) {
    await ChatMessage.create({ speaker: { alias: "Trade Machine" }, content: `<p>For ₽${fee}, the machine traded ${pokemon.name} back and forth — it evolved into <strong>${evolved}</strong>!</p>` });
  } else {
    await trainer.update({ "system.money": money }); // cancelled → refund
  }
}

/** Trainer-sheet flow: pick a party Pokémon and pay to trade-evolve it. */
export async function tradeServiceDialog(trainer) {
  trainer ??= resolveTrainer();
  const party = await trainer.getParty();
  const eligible = [];
  for (const mon of party) if (await hasTradeEvo(mon)) eligible.push(mon);
  if (!eligible.length) return ui.notifications?.info("No party Pokémon can trade-evolve right now.");
  const DialogV2 = foundry.applications?.api?.DialogV2;
  let chosenUuid = eligible[0].uuid;
  if (DialogV2) {
    const opts = eligible.map((m) => `<option value="${m.uuid}">${m.name} (Lv ${m.system.level})</option>`).join("");
    chosenUuid = await DialogV2.prompt({
      window: { title: `Trade machine — ₽${TRADE_FEE}` },
      content: `<p>Trade-evolve which Pokémon?</p><select name="m" style="width:100%">${opts}</select>`,
      ok: { label: `Pay ₽${TRADE_FEE}`, callback: (event, button) => button.form.elements.m.value }
    }).catch(() => null);
  }
  if (!chosenUuid) return;
  const mon = await fromUuid(chosenUuid);
  if (mon) return tradeService(trainer, mon);
}

export function registerTradeApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    trade: { swap, npcOffer: npcTradeOffer, service: tradeService, serviceDialog: tradeServiceDialog }
  });
}
