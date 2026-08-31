/**
 * Pokémon Masters — overworld services & field utilities.
 *
 * The everyday NPCs and gadgets a trainer relies on between battles:
 *   · Move Tutor    — teaches a special move outside the normal learnset.
 *   · Move Reminder — relearns any move from a Pokémon's learnset.
 *   · Move Deleter  — forgets a move (including HM moves).
 *   · Name Rater    — nicknames a Pokémon.
 *   · Fishing rods  — Old / Good / Super rods roll a water encounter.
 *   · Repels        — suppress wild encounters for a number of steps.
 *   · Bicycle       — toggle faster travel.
 *   · Ride Pokémon  — Tauros / Lapras / Charizard field rides.
 *
 * These are thin, player-facing wrappers around existing systems (the catch
 * flow, the eligibility tables, the TM plumbing), so they add flavour without
 * new crowded UI — they're reached from NPC dialogue or a Poké Mart counter.
 */

import { PM } from "./config.mjs";
import { resolveTrainer, catchButtonHtml } from "./catch.mjs";
import { eligibleSpecies } from "./eligibility.mjs";
import { teachMove, teachMoveDialog } from "./tms.mjs";

const DialogV2 = () => foundry.applications?.api?.DialogV2;

async function findSpecies(name) {
  const pack = game.packs.get("pokemon-masters.species");
  if (!pack) return null;
  const key = String(name).toLowerCase();
  const entry = pack.index.find((e) => e.name.toLowerCase() === key);
  return entry ? pack.getDocument(entry._id) : null;
}

/** Special moves a Move Tutor can grant regardless of a Pokémon's learnset. */
export const TUTOR_MOVES = [
  "Body Slam", "Double-Edge", "Mega Kick", "Mega Punch", "Rock Slide", "Substitute",
  "Fire Punch", "Ice Punch", "Thunder Punch", "Seed Bomb", "Dragon Pulse", "Zen Headbutt",
  "Iron Head", "Superpower", "Outrage", "Draco Meteor", "Trick", "Fury Cutter"
];

/** The first Pokémon in a party (services act on the party lead by default). */
async function partyLead(trainer) {
  const party = (await trainer.getParty?.()) ?? [];
  return party[0] ?? null;
}

/* ---- Move services ----------------------------------------- */

/** Move Tutor: teach a special tutor move (forced past the learnset check). */
export async function moveTutor(pokemon) {
  if (pokemon?.type !== "pokemon") return ui.notifications?.warn("Select a Pokémon first.");
  const D = DialogV2();
  const known = new Set(pokemon.items.filter((i) => i.type === "move").map((m) => m.name.toLowerCase()));
  const choices = TUTOR_MOVES.filter((m) => !known.has(m.toLowerCase()));
  if (!choices.length) return ui.notifications?.info(`${pokemon.name} already knows every tutor move on offer.`);
  if (!D) return teachMove(pokemon, choices[0], { force: true });
  const opts = choices.map((m) => `<option value="${m}">${m}</option>`).join("");
  const move = await D.prompt({
    window: { title: `Move Tutor — ${pokemon.name}` },
    content: `<p>The tutor can teach a special move:</p><select name="m" style="width:100%">${opts}</select>`,
    ok: { label: "Teach", callback: (e, b) => b.form.elements.m.value }
  }).catch(() => null);
  if (move) return teachMove(pokemon, move, { force: true });
}

/** Move Reminder: relearn any move already in the learnset. */
export function moveReminder(pokemon) {
  if (pokemon?.type !== "pokemon") return ui.notifications?.warn("Select a Pokémon first.");
  return teachMoveDialog(pokemon);
}

/** Move Deleter: forget one of a Pokémon's known moves (HMs included). */
export async function moveDeleter(pokemon) {
  if (pokemon?.type !== "pokemon") return ui.notifications?.warn("Select a Pokémon first.");
  const moves = pokemon.items.filter((i) => i.type === "move");
  if (!moves.length) return ui.notifications?.info(`${pokemon.name} knows no moves to delete.`);
  const D = DialogV2();
  let id = moves[0].id;
  if (D) {
    const opts = moves.map((m) => `<option value="${m.id}">${m.name}</option>`).join("");
    id = await D.prompt({
      window: { title: `Move Deleter — ${pokemon.name}` },
      content: `<p>Which move should ${pokemon.name} forget?</p><select name="m" style="width:100%">${opts}</select>`,
      ok: { label: "Forget", callback: (e, b) => b.form.elements.m.value }
    }).catch(() => null);
  }
  if (!id) return;
  const move = pokemon.items.get(id);
  await pokemon.deleteEmbeddedDocuments("Item", [id]);
  await ChatMessage.create({ speaker: { alias: pokemon.name }, content: `<p>${pokemon.name} forgot <strong>${move?.name ?? "a move"}</strong>.</p>` });
}

/** Name Rater: give a Pokémon a nickname. */
export async function nameRater(pokemon) {
  if (pokemon?.type !== "pokemon") return ui.notifications?.warn("Select a Pokémon first.");
  const D = DialogV2();
  if (!D) return;
  const name = await D.prompt({
    window: { title: "Name Rater" },
    content: `<p>What nickname suits this ${pokemon.system.species?.name ?? pokemon.name}?</p><input type="text" name="n" value="${pokemon.name}" style="width:100%">`,
    ok: { label: "Rename", callback: (e, b) => b.form.elements.n.value.trim() }
  }).catch(() => null);
  if (name) { await pokemon.update({ name }); await ChatMessage.create({ speaker: { alias: "Name Rater" }, content: `<p>A fine name! It shall be known as <strong>${name}</strong>.</p>` }); }
}

/* ---- Fishing ----------------------------------------------- */

/** Rod tiers: level band + the rarities they can hook. */
const RODS = {
  "Old Rod": { min: 5, max: 15, rarities: ["common"] },
  "Good Rod": { min: 10, max: 25, rarities: ["common", "uncommon"] },
  "Super Rod": { min: 15, max: 40, rarities: ["common", "uncommon", "rare", "veryrare"] }
};

/** Cast a rod at the water you're standing by: rolls a fishing encounter. */
export async function fish(trainer, rod = "Old Rod") {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Assign your Trainer first.");
  const tier = RODS[rod] ?? RODS["Old Rod"];
  const scene = canvas?.scene ?? game.scenes?.active;
  const region = scene?.getFlag?.("pokemon-masters", "region") ?? "";
  let rows = await eligibleSpecies({ habitat: "water", region, method: "fishing" });
  rows = rows.filter((r) => tier.rarities.includes(r.rarity));
  if (!rows.length) {
    return ChatMessage.create({ speaker: { alias: trainer.name }, content: `<div class="pm-encounter-card"><p>🎣 ${trainer.name} cast the ${rod}… not even a nibble.</p></div>` });
  }
  const total = rows.reduce((s, r) => s + r.weight, 0);
  let roll = Math.random() * total; let pick = rows[0];
  for (const r of rows) { roll -= r.weight; if (roll < 0) { pick = r; break; } }
  const species = await findSpecies(pick.name);
  const level = tier.min + Math.floor(Math.random() * (tier.max - tier.min + 1));
  await ChatMessage.create({
    speaker: { alias: trainer.name },
    content: `
      <div class="pm-encounter-card">
        <h3>🎣 A wild <strong>${species.name}</strong> took the bait! (Lv ${level})</h3>
        <p><small>Hooked with the ${rod}${region ? ` in ${PM.regions[region] ?? region}` : ""}.</small></p>
        <p>${catchButtonHtml({ speciesUuid: species.uuid, level })}</p>
      </div>`
  });
  return species.name;
}

/* ---- Repels, bike, rides ----------------------------------- */

const REPEL_STEPS = { "Repel": 100, "Super Repel": 200, "Max Repel": 250 };

/** Use a Repel: suppress wild encounters for a number of steps. */
export async function useRepel(trainer, kind = "Repel") {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Assign your Trainer first.");
  const item = trainer.items.find((i) => i.type === "gear" && i.name.toLowerCase() === kind.toLowerCase());
  if (!item) return ui.notifications?.warn(`You have no ${kind}.`);
  const steps = REPEL_STEPS[kind] ?? 100;
  if ((item.system.quantity ?? 1) > 1) await item.update({ "system.quantity": item.system.quantity - 1 });
  else await item.delete();
  await trainer.setFlag("pokemon-masters", "repelSteps", steps);
  await ChatMessage.create({ speaker: { alias: trainer.name }, content: `<div class="pm-encounter-card"><p>${trainer.name} used a ${kind}. Wild Pokémon will keep away for ${steps} steps.</p></div>` });
}

/** Toggle the Bicycle for faster overland travel. */
export async function toggleBike(trainer) {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Assign your Trainer first.");
  const has = trainer.items.some((i) => i.type === "gear" && ["bicycle", "bike voucher"].includes(i.name.toLowerCase()));
  if (!has) return ui.notifications?.warn("You don't have a Bicycle.");
  const on = !(trainer.getFlag("pokemon-masters", "onBike") ?? false);
  await trainer.setFlag("pokemon-masters", "onBike", on);
  await ChatMessage.create({ speaker: { alias: trainer.name }, content: `<div class="pm-encounter-card"><p>🚲 ${trainer.name} ${on ? "hopped on the Bicycle — zoom!" : "got off the Bicycle."}</p></div>` });
}

/** Field ride: Tauros (charge), Lapras (surf), or Charizard (fly). */
export async function ridePokemon(trainer, kind = "tauros") {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Assign your Trainer first.");
  if (kind === "charizard") return game.pokemonMasters?.travel?.fly?.(trainer);
  const blurb = {
    tauros: "🐂 You mount Tauros and charge across the land!",
    lapras: "🌊 You climb onto Lapras and glide over the water.",
    mudsdale: "🐴 Mudsdale carries you steadily over rough ground."
  }[kind] ?? "You call on a ride Pokémon.";
  await ChatMessage.create({ speaker: { alias: trainer.name }, content: `<div class="pm-encounter-card"><p>${blurb}</p></div>` });
}

/* ============================================================= */

export function registerServicesApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    services: {
      moveTutor, moveReminder, moveDeleter, nameRater,
      fish, useRepel, toggleBike, ridePokemon, partyLead
    }
  });
}
