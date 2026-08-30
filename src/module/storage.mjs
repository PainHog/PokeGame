/**
 * Pokémon Masters — PC storage (boxes).
 *
 * A trainer's active party holds up to six Pokémon; everything else lives in PC
 * storage. Catches and starters that overflow the party route here automatically.
 */

export const PARTY_LIMIT = 6;

/** Add a Pokémon to the party if there's room, else to PC storage. Returns the destination. */
export async function addToParty(trainer, actor) {
  const party = [...(trainer.system.party ?? [])];
  if (party.length < PARTY_LIMIT) {
    party.push(actor.uuid);
    await trainer.update({ "system.party": party });
    return "party";
  }
  const storage = [...(trainer.system.storage ?? []), actor.uuid];
  await trainer.update({ "system.storage": storage });
  return "storage";
}

/** Move a Pokémon from the party into PC storage. */
export async function deposit(trainer, uuid) {
  const party = (trainer.system.party ?? []).filter((u) => u !== uuid);
  const storage = [...(trainer.system.storage ?? [])];
  if (!storage.includes(uuid)) storage.push(uuid);
  await trainer.update({ "system.party": party, "system.storage": storage });
}

/** Withdraw a Pokémon from PC storage into the party (if there is room). */
export async function withdraw(trainer, uuid) {
  const party = [...(trainer.system.party ?? [])];
  if (party.length >= PARTY_LIMIT) return ui.notifications?.warn("Party is full (6). Deposit one first.");
  const storage = (trainer.system.storage ?? []).filter((u) => u !== uuid);
  if (!party.includes(uuid)) party.push(uuid);
  await trainer.update({ "system.party": party, "system.storage": storage });
}

/** Resolve stored Pokémon UUIDs to live Actors. */
export async function getStorage(trainer) {
  const mons = await Promise.all((trainer.system.storage ?? []).map((u) => fromUuid(u)));
  return mons.filter(Boolean);
}

export function registerStorageApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    storage: { addToParty, deposit, withdraw, getStorage, PARTY_LIMIT }
  });
}
