/**
 * Pokémon Masters — breeding & daycare.
 *
 * Two compatible Pokémon left at the daycare can produce an Egg that hatches
 * into the base form of the mother's line. Compatibility follows the games:
 * shared egg group (or a Ditto partner), never the Undiscovered group, and
 * genderless species only breed with Ditto.
 *
 * `checkCompatibility` is pure (plain {eggGroups, eggSpecies, genderless, gender,
 * name} objects) and unit tested.
 */

import { addToParty } from "./storage.mjs";
import { markCaught } from "./dex.mjs";

const isDitto = (m) => (m.eggGroups ?? []).includes("Ditto");
const undiscovered = (m) => (m.eggGroups ?? []).includes("Undiscovered");
const shareGroup = (a, b) => (a.eggGroups ?? []).some((g) => g !== "Ditto" && (b.eggGroups ?? []).includes(g));

/**
 * Can these two breed, and what hatches?
 * @returns {{compatible:boolean, reason:string, offspring:string|null}}
 */
export function checkCompatibility(a, b) {
  if (!a || !b) return { compatible: false, reason: "Two Pokémon are required.", offspring: null };
  if (undiscovered(a) || undiscovered(b)) return { compatible: false, reason: "One of them can't breed (Undiscovered group).", offspring: null };

  const aDitto = isDitto(a);
  const bDitto = isDitto(b);
  if (aDitto && bDitto) return { compatible: false, reason: "Two Ditto can't breed.", offspring: null };

  // Ditto breeds with anything breedable; offspring is the non-Ditto's base form.
  if (aDitto) return { compatible: true, reason: "Ditto pairing.", offspring: b.eggSpecies || b.name };
  if (bDitto) return { compatible: true, reason: "Ditto pairing.", offspring: a.eggSpecies || a.name };

  if (a.genderless || b.genderless) return { compatible: false, reason: "Genderless Pokémon only breed with Ditto.", offspring: null };

  // Gender: if both known and the same, incompatible; unknown is permitted.
  if (a.gender && b.gender && a.gender === b.gender) {
    return { compatible: false, reason: "Both are the same gender.", offspring: null };
  }
  if (!shareGroup(a, b)) return { compatible: false, reason: "No shared egg group.", offspring: null };

  // Offspring is the mother's base form; without known genders, use the first parent.
  const mother = a.gender === "F" ? a : b.gender === "F" ? b : a;
  return { compatible: true, reason: "Shared egg group.", offspring: mother.eggSpecies || mother.name };
}

function facts(actor) {
  const s = actor.system;
  return {
    name: actor.name,
    eggGroups: s.eggGroups ?? [],
    eggSpecies: s.eggSpecies || s.species?.name || actor.name,
    genderless: !!s.genderless,
    gender: s.gender ?? ""
  };
}

async function findSpecies(name) {
  const pack = game.packs.get("pokemon-masters.species");
  if (!pack) return null;
  const key = String(name).toLowerCase();
  const entry = pack.index.find((e) => e.name.toLowerCase() === key);
  return entry ? pack.getDocument(entry._id) : null;
}

/** Try to breed two Pokémon; on success, hatch a level-1 baby for `trainer`. */
export async function breed(trainer, momActor, dadActor) {
  const result = checkCompatibility(facts(momActor), facts(dadActor));
  if (!result.compatible) {
    return ui.notifications?.info(`No Egg: ${result.reason}`);
  }
  const species = await findSpecies(result.offspring);
  if (!species) return ui.notifications?.warn(`Egg species not found: ${result.offspring}`);

  const source = species.toObject();
  delete source._id;
  source.folder = null;
  source.system.level = 1;
  source.system.hp = { value: null, max: 0 };
  if (trainer) source.system.trainer = trainer.uuid;
  const baby = await Actor.implementation.create(source);
  if (!baby) return;

  if (trainer) {
    await addToParty(trainer, baby);
    await markCaught(trainer, species.name);
  }
  await ChatMessage.create({
    speaker: { alias: "Daycare" },
    content: `<div class="pm-encounter-card"><h3>An Egg hatched into ${species.name}!</h3><p>${momActor.name} × ${dadActor.name}</p></div>`
  });
  return baby;
}

/** Leave a Pokémon at the daycare (max 2). */
export async function depositToDaycare(trainer, uuid) {
  const daycare = [...(trainer.system.daycare ?? [])];
  if (daycare.includes(uuid)) return;
  if (daycare.length >= 2) return ui.notifications?.warn("The daycare already holds two Pokémon.");
  daycare.push(uuid);
  const party = (trainer.system.party ?? []).filter((u) => u !== uuid);
  await trainer.update({ "system.daycare": daycare, "system.party": party });
}

/** Collect an egg if the two daycare Pokémon are compatible. */
export async function collectEgg(trainer) {
  const [aU, bU] = trainer.system.daycare ?? [];
  if (!aU || !bU) return ui.notifications?.info("The daycare needs two Pokémon.");
  const [a, b] = await Promise.all([fromUuid(aU), fromUuid(bU)]);
  if (!a || !b) return;
  return breed(trainer, a, b);
}

export function registerBreedingApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    breeding: { breed, checkCompatibility, deposit: depositToDaycare, collectEgg }
  });
}
