/**
 * Pokémon Masters — starter selection.
 *
 * The Professor's table: a new trainer picks a region, then one of its three
 * starters, which is granted at level 5 and added to their party.
 */

import { PM } from "./config.mjs";
import { resolveTrainer, ownedByTrainer } from "./catch.mjs";
import { addToParty } from "./storage.mjs";
import { markCaught } from "./dex.mjs";
import { applyIndividuality } from "./individuality.mjs";

async function findSpecies(name) {
  const pack = game.packs.get("pokemon-masters.species");
  if (!pack) return null;
  const key = String(name).toLowerCase();
  const entry = pack.index.find((e) => e.name.toLowerCase() === key);
  return entry ? pack.getDocument(entry._id) : null;
}

/** A gear item's source object (from the compendium) with a set quantity. */
async function gearItem(name, quantity) {
  const pack = game.packs.get("pokemon-masters.gear");
  const entry = pack?.index.find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (!entry) return null;
  const src = (await pack.getDocument(entry._id)).toObject();
  delete src._id;
  src.system = { ...(src.system ?? {}), quantity };
  return src;
}

/** Every new trainer's starting bag — Poké Balls & a few Potions, once. */
async function giveStartingKit(trainer) {
  if (!trainer || trainer.getFlag("pokemon-masters", "starterKit")) return;
  const KIT = [["Poké Ball", 10], ["Great Ball", 5], ["Potion", 5], ["Antidote", 2]];
  const items = [];
  for (const [name, qty] of KIT) { const it = await gearItem(name, qty); if (it) items.push(it); }
  try {
    if (items.length) await trainer.createEmbeddedDocuments("Item", items);
    await trainer.setFlag("pokemon-masters", "starterKit", true);
  } catch (err) { console.warn("Pokémon Masters | could not grant starting kit", err); }
}

/** Import a starter at level 5 and add it to the trainer's party. */
export async function grantStarter(trainer, speciesName) {
  const species = await findSpecies(speciesName);
  if (!species) return ui.notifications?.warn(`Starter not found: ${speciesName}`);

  const source = species.toObject();
  delete source._id;
  source.folder = null;
  source.system.level = 5;
  source.system.hp = { value: null, max: 0 };
  source.system.trainer = trainer.uuid;
  source.ownership = ownedByTrainer(trainer);   // the player owns their first partner
  applyIndividuality(source.system);

  let created;
  try {
    created = await Actor.implementation.create(source);
  } catch (err) {
    return ui.notifications?.warn(`Could not create ${species.name}. Enable "Create New Actors" for the Player role once (Configure Permissions).`);
  }
  if (!created) return;
  await addToParty(trainer, created);
  await markCaught(trainer, species.name);
  await giveStartingKit(trainer);   // hand out the starting Poké Balls

  const professor = PM.gymLeaders?.[species.system.nativeRegion]?.professor ?? "The Professor";
  await ChatMessage.create({
    speaker: { alias: professor },
    content: `<div class="pm-encounter-card"><h3>${trainer.name} chose ${species.name}!</h3><p>"${species.name} is a fine choice — take good care of it." Their journey begins.</p></div>`
  });
  // Auto-spawn the trainer on their home town (handled by the GM client).
  Hooks.callAll("pmStarterChosen", { trainer, region: species.system.nativeRegion });
  return created;
}

/** Run the two-step starter picker for a trainer. */
export async function chooseStarter(trainer) {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Select or assign your Trainer first.");
  if ((trainer.system.party ?? []).length) {
    const proceed = await confirmDialog("Already has Pokémon", `${trainer.name} already has a party. Grant another starter anyway?`);
    if (!proceed) return;
  }

  // First, let the player choose their trainer look & gender (once), like the
  // start of a mainline game — before the professor hands out the first partner.
  await game.pokemonMasters?.appearance?.offerOnce?.(trainer);

  const DialogV2 = foundry.applications?.api?.DialogV2;
  let region = "kanto";
  if (DialogV2) {
    const opts = Object.keys(PM.starterSets)
      .map((r) => `<option value="${r}">${PM.regions[r] ?? r}</option>`).join("");
    region = await DialogV2.prompt({
      window: { title: "Choose your home region" },
      content: `<p>Where does your journey begin?</p><select name="region" style="width:100%">${opts}</select>`,
      ok: { label: "Next", callback: (event, button) => button.form.elements.region.value }
    }) ?? "kanto";
  }

  const trio = PM.starterSets[region] ?? PM.starterSets.kanto;
  let choice = trio[0];
  if (DialogV2) {
    choice = await DialogV2.wait({
      window: { title: `Professor's table — ${PM.regions[region] ?? region}` },
      content: `<p>Choose your first partner:</p>`,
      buttons: trio.map((name) => ({ action: name, label: name, callback: () => name })),
      rejectClose: false
    });
  }
  if (!choice) return;
  return grantStarter(trainer, choice);
}

async function confirmDialog(title, content) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  try {
    if (DialogV2) return await DialogV2.confirm({ window: { title }, content: `<p>${content}</p>` });
  } catch (err) { /* fall through */ }
  return true;
}

export function registerStarterApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    starters: { choose: chooseStarter, grant: grantStarter }
  });
}
