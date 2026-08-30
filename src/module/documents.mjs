/**
 * Pokémon Masters — Document subclasses.
 *
 * Thin extensions of the core Actor/Item classes that hold system-specific
 * convenience logic. Most data preparation lives on the DataModels; these expose
 * a few helpers used by sheets and the encounter flow.
 */

export class PokemonMastersActor extends Actor {
  /** Resolve a Trainer's party (array of Actor UUIDs) to live Actor documents. */
  async getParty() {
    if (this.type !== "trainer") return [];
    const members = await Promise.all((this.system.party ?? []).map((uuid) => fromUuid(uuid)));
    return members.filter(Boolean);
  }

  /** Is this Pokémon fainted? */
  get isFainted() {
    return this.type === "pokemon" && (this.system.hp?.value ?? 1) <= 0;
  }

  /** Ensure a freshly-created Pokémon starts at full HP. */
  async _preCreate(data, options, user) {
    const allowed = await super._preCreate(data, options, user);
    if (allowed === false) return false;
    if (this.type === "pokemon" && (data.system?.hp?.value === undefined || data.system?.hp?.value === null)) {
      // hp.max is derived; let prepareDerivedData top it off from null on first prep.
      this.updateSource({ "system.hp.value": null });
    }
  }
}

export class PokemonMastersItem extends Item {
  /** Convenience: elemental type for moves (stored as `moveType`). */
  get elementType() {
    return this.type === "move" ? this.system.moveType : null;
  }
}
