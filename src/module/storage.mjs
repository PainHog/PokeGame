/**
 * Pokémon Masters — PC storage (boxes).
 *
 * A trainer's active party holds up to six Pokémon; everything else lives in PC
 * storage. Catches and starters that overflow the party route here automatically.
 * The party is an ordered list of Actor UUIDs — index 0 is the trainer's lead,
 * the Pokémon sent out first in a wild battle.
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

/** Resolve a trainer's party (Actor UUIDs) to live Actor documents (falsy dropped). */
export async function partyActors(trainer) {
  const mons = await Promise.all((trainer?.system?.party ?? []).map((u) => fromUuid(u)));
  return mons.filter(Boolean);
}

/** The trainer's lead: the first party member that still has HP (null value = full). */
export async function leadPokemon(trainer) {
  const party = await partyActors(trainer);
  return party.find((p) => (p.system?.hp?.value ?? p.system?.hp?.max ?? 1) > 0) ?? null;
}

/**
 * Back-compat sweep: split any pre-cap overflow party (more than PARTY_LIMIT
 * members) into PC storage, keeping the first six as the party. Runs for each
 * trainer THIS client owns — the GM owns all in a hosted world; each player owns
 * their own in GM-less play, so every trainer is fixed by a client that can write
 * it. Naturally one-time: the `party.length > PARTY_LIMIT` guard only holds until
 * fixed, so it does nothing on later loads (unlike a world-version flag, which one
 * client could mark done before another owner's overflow was ever touched).
 */
async function sweepPartyOverflow() {
  if (!game.actors) return;
  for (const trainer of game.actors) {
    try {
      if (trainer.type !== "trainer" || !trainer.isOwner) continue;
      const party = trainer.system.party ?? [];
      if (party.length <= PARTY_LIMIT) continue;
      const keep = party.slice(0, PARTY_LIMIT);
      const existing = trainer.system.storage ?? [];
      const overflow = party.slice(PARTY_LIMIT).filter((u) => !existing.includes(u));
      await trainer.update({ "system.party": keep, "system.storage": [...existing, ...overflow] });
    } catch (err) {
      console.warn("Pokémon Masters | party overflow sweep failed for", trainer?.name, err);
    }
  }
}

export function registerStorageApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    storage: { addToParty, deposit, withdraw, getStorage, partyActors, leadPokemon, PARTY_LIMIT }
  });
  // registerStorageApi() is already called on the "ready" hook, so run the
  // one-time overflow migration inline (a nested Hooks.once("ready") would miss
  // the in-flight snapshot), guarded so it only touches owned, over-cap parties.
  void sweepPartyOverflow();
}
