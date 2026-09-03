/**
 * Pokémon Masters — quests offered through NPC dialogue.
 *
 * NPCs (a Quest Board, or any dialogue that calls `offerQuest`) hand out small
 * objectives — catch some Pokémon, win some battles, complete the Pokédex a
 * little further — tracked on the trainer's quest log and rewarded on
 * completion. Progress is driven by the same hooks the rest of the world fires
 * (a caught Pokémon, a fainted foe), so a quest advances as you simply play.
 */

import { resolveTrainer } from "./catch.mjs";

const FLAG = "pokemon-masters";

/** Quest templates. `metric` matches the counters advanced by the hooks below. */
export const QUEST_TEMPLATES = [
  { id: "catch3", title: "Budding Collector", metric: "catch", goal: 3, reward: { money: 800 }, text: "Catch 3 wild Pokémon." },
  { id: "catch5", title: "Field Researcher", metric: "catch", goal: 5, reward: { money: 1500, item: "Ultra Ball" }, text: "Catch 5 wild Pokémon for the Professor." },
  { id: "win3", title: "Up-and-Comer", metric: "win", goal: 3, reward: { money: 1000 }, text: "Win 3 battles." },
  { id: "win5", title: "Local Hotshot", metric: "win", goal: 5, reward: { money: 2000, item: "Rare Candy" }, text: "Win 5 battles to prove your skill." },
  { id: "seen10", title: "Dex Starter", metric: "seen", goal: 10, reward: { money: 1200 }, text: "See 10 different species." }
];

const templateById = (id) => QUEST_TEMPLATES.find((q) => q.id === id);

/** The trainer's active quests: [{ id, progress, base }]. */
function activeQuests(trainer) {
  return foundry.utils.deepClone(trainer.getFlag(FLAG, "quests") ?? []);
}

/** Offer a quest via dialogue (or directly accept one when no dialog is up). */
export async function offerQuest(trainer, questId = null) {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Assign your Trainer first.");
  const active = activeQuests(trainer);
  const available = QUEST_TEMPLATES.filter((q) => !active.some((a) => a.id === q.id));
  if (!available.length) return ChatMessage.create({ speaker: { alias: "Quest Board" }, content: "<div class=\"pm-encounter-card\"><p>No new jobs on the board right now — finish the ones you've taken!</p></div>" });

  const quest = questId ? templateById(questId) : available[Math.floor(Math.random() * available.length)];
  if (!quest) return;
  const D = foundry.applications?.api?.DialogV2;
  let accept = true;
  if (D) {
    accept = await D.confirm({
      window: { title: "Quest Board" },
      content: `<p><strong>${quest.title}</strong></p><p>${quest.text}</p><p><small>Reward: ₽${quest.reward.money ?? 0}${quest.reward.item ? ` + ${quest.reward.item}` : ""}</small></p><p>Take this job?</p>`
    }).catch(() => false);
  }
  if (!accept) return;
  await trainer.setFlag(FLAG, "quests", [...active, { id: quest.id, progress: baseline(trainer, quest) }]);
  await ChatMessage.create({ speaker: { alias: "Quest Board" }, content: `<div class="pm-encounter-card"><h3>📋 Quest accepted: ${quest.title}</h3><p>${quest.text}</p></div>` });
}

/** Snapshot the counter a quest measures against, so only new progress counts. */
function baseline(trainer, quest) {
  if (quest.metric === "seen") return (trainer.system.pokedex?.seen?.length ?? 0);
  return 0; // catch/win counters accrue from zero per quest
}

/** Current value of a quest's metric for the trainer. */
function metricValue(trainer, quest, counters) {
  if (quest.metric === "seen") return (trainer.system.pokedex?.seen?.length ?? 0);
  return counters[quest.metric] ?? 0;
}

/** Advance a metric counter and check every active quest for completion. */
async function advance(trainer, metric) {
  if (trainer?.type !== "trainer" || !trainer.isOwner) return;
  const counters = { ...(trainer.getFlag(FLAG, "questCounters") ?? {}) };
  counters[metric] = (counters[metric] ?? 0) + 1;
  await trainer.setFlag(FLAG, "questCounters", counters);
  await checkQuests(trainer, counters);
}

/** Complete any active quest whose goal is met; pay out and remove it. */
async function checkQuests(trainer, counters = null) {
  counters ??= trainer.getFlag(FLAG, "questCounters") ?? {};
  const active = activeQuests(trainer);
  const remaining = [];
  for (const a of active) {
    const quest = templateById(a.id);
    if (!quest) continue;
    const done = (metricValue(trainer, quest, counters) - (a.progress ?? 0)) >= quest.goal;
    if (!done) { remaining.push(a); continue; }
    // Reward.
    if (quest.reward.money) await trainer.update({ "system.money": (trainer.system.money ?? 0) + quest.reward.money });
    if (quest.reward.item) await giveQuestItem(trainer, quest.reward.item);
    await ChatMessage.create({ speaker: { alias: "Quest Complete!" }, content: `<div class="pm-encounter-card"><h3>✅ ${quest.title} complete!</h3><p>Reward: ₽${quest.reward.money ?? 0}${quest.reward.item ? ` + ${quest.reward.item}` : ""}.</p></div>` });
  }
  if (remaining.length !== active.length) await trainer.setFlag(FLAG, "quests", remaining);
}

async function giveQuestItem(trainer, name, qty = 1) {
  const existing = trainer.items.find((i) => i.type === "gear" && i.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.update({ "system.quantity": (existing.system.quantity ?? 1) + qty });
  const pack = game.packs.get("pokemon-masters.gear");
  const entry = pack?.index.find((e) => e.name.toLowerCase() === name.toLowerCase());
  const doc = entry ? await pack.getDocument(entry._id) : null;
  const data = doc ? doc.toObject() : { name, type: "gear", system: { category: "item", quantity: qty, price: 0 } };
  delete data._id; data.system.quantity = qty;
  return trainer.createEmbeddedDocuments("Item", [data]);
}

/** Open the Quest Board (offer a job). */
export function questBoard(trainer) {
  return offerQuest(trainer);
}

/** A readable list of the trainer's active quests (for UI / chat). */
export function questLog(trainer) {
  trainer ??= resolveTrainer();
  const counters = trainer?.getFlag(FLAG, "questCounters") ?? {};
  return activeQuests(trainer ?? {}).map((a) => {
    const q = templateById(a.id);
    if (!q) return null;
    const have = Math.max(0, metricValue(trainer, q, counters) - (a.progress ?? 0));
    return { title: q.title, text: q.text, have: Math.min(have, q.goal), goal: q.goal };
  }).filter(Boolean);
}

export function registerQuestApi() {
  // A caught Pokémon advances "catch"; the caught species is also newly seen.
  Hooks.on("pmPokemonCaught", ({ trainer }) => { if (trainer) advance(trainer, "catch"); });
  // A defeated foe advances "win" for the victor's trainer.
  Hooks.on("pmPokemonFainted", async ({ attacker }) => {
    if (attacker?.type !== "pokemon") return;
    const owner = attacker.system?.trainer ? await fromUuid(attacker.system.trainer) : null;
    if (owner?.type === "trainer" && owner.isOwner) advance(owner, "win");
  });
  // Seeing new species can complete "seen" quests without a counter bump.
  Hooks.on("pmDexUpdated", ({ trainer }) => { if (trainer?.isOwner) checkQuests(trainer); });

  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    quests: { offer: offerQuest, board: questBoard, log: questLog, templates: QUEST_TEMPLATES }
  });
}
