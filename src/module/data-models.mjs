/**
 * Pokémon Masters — system data models (schemas).
 *
 * These define the shape of `actor.system` / `item.system` for every subtype
 * declared in `system.json > documentTypes`. Foundry v13+ builds and validates
 * documents from these instead of the legacy `template.json`.
 */

import { PM } from "./config.mjs";

const fields = foundry.data.fields;

/** A {value, max} resource pair helper. */
function resource(initial = 10) {
  return new fields.SchemaField({
    value: new fields.NumberField({ required: true, integer: true, min: 0, initial, nullable: true }),
    max: new fields.NumberField({ required: true, integer: true, min: 0, initial })
  });
}

/** The six base stats, each a non-negative integer. */
function statBlock(initial = 1) {
  const stat = () => new fields.NumberField({ required: true, integer: true, min: 0, initial });
  return new fields.SchemaField({
    hp: stat(), atk: stat(), def: stat(), spa: stat(), spd: stat(), spe: stat()
  });
}

/* -------------------------------------------- */
/*  Actor: Trainer                              */
/* -------------------------------------------- */

export class TrainerData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      vocation: new fields.StringField({
        required: true, blank: false, initial: "trainer", choices: PM.vocations
      }),
      level: new fields.NumberField({ required: true, integer: true, min: 1, initial: 1 }),
      money: new fields.NumberField({ required: true, integer: true, min: 0, initial: 3000 }),
      badges: new fields.ArrayField(new fields.StringField({ blank: false })),
      hometown: new fields.StringField({ required: false, blank: true }),
      biography: new fields.HTMLField({ required: false, blank: true }),
      /** Owned Pokémon, referenced by Actor UUID (the party). */
      party: new fields.ArrayField(new fields.DocumentUUIDField({ type: "Actor" }))
    };
  }
}

/* -------------------------------------------- */
/*  Actor: Pokémon                              */
/* -------------------------------------------- */

export class PokemonData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      species: new fields.SchemaField({
        name: new fields.StringField({ required: true, blank: true, initial: "" }),
        num: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 })
      }),
      types: new fields.ArrayField(new fields.StringField({ blank: false })),
      level: new fields.NumberField({ required: true, integer: true, min: 1, max: 100, initial: 5 }),
      nature: new fields.StringField({ required: true, blank: true, initial: "serious" }),
      gender: new fields.StringField({ required: false, blank: true, initial: "" }),
      shiny: new fields.BooleanField({ initial: false }),
      rarity: new fields.StringField({ required: true, blank: false, initial: "common", choices: PM.rarities }),
      catchRate: new fields.NumberField({ required: true, integer: true, min: 1, max: 255, initial: 45 }),
      ability: new fields.StringField({ required: false, blank: true, initial: "" }),
      abilities: new fields.ArrayField(new fields.StringField({ blank: false })),
      baseStats: statBlock(1),
      /** Current HP. `max` is derived from base stats + level in prepareDerivedData. */
      hp: new fields.SchemaField({
        value: new fields.NumberField({ required: true, integer: true, min: 0, initial: null, nullable: true }),
        max: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 })
      }),
      /** Currently-known moves (slug/name references into the moves compendium). */
      moves: new fields.ArrayField(new fields.StringField({ blank: false })),
      /** Everything this species can learn, with the level it becomes available. */
      learnset: new fields.ArrayField(new fields.SchemaField({
        move: new fields.StringField({ required: true, blank: false }),
        level: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 })
      })),
      evolution: new fields.SchemaField({
        from: new fields.StringField({ required: false, blank: true }),
        into: new fields.ArrayField(new fields.StringField({ blank: false })),
        method: new fields.StringField({ required: false, blank: true }),
        level: new fields.NumberField({ required: false, nullable: true, integer: true, min: 0 }),
        item: new fields.StringField({ required: false, blank: true }),
        condition: new fields.StringField({ required: false, blank: true })
      }),
      /** The trainer who owns this Pokémon, if any. */
      trainer: new fields.DocumentUUIDField({ type: "Actor", required: false, nullable: true, initial: null }),
      notes: new fields.HTMLField({ required: false, blank: true })
    };
  }

  /** Derive fighting stats from base stats and level (simplified Gen-style curve). */
  prepareDerivedData() {
    const lvl = this.level ?? 1;
    const b = this.baseStats;
    const stat = (base) => Math.floor((2 * base * lvl) / 100) + 5;
    const hpStat = (base) => Math.floor((2 * base * lvl) / 100) + lvl + 10;
    this.stats = {
      hp: hpStat(b.hp),
      atk: stat(b.atk),
      def: stat(b.def),
      spa: stat(b.spa),
      spd: stat(b.spd),
      spe: stat(b.spe)
    };
    this.bst = b.hp + b.atk + b.def + b.spa + b.spd + b.spe;
    // Keep the HP resource sensible without clobbering a set (e.g. damaged) value.
    this.hp.max = this.stats.hp;
    if (this.hp.value === null) this.hp.value = this.hp.max;
    else this.hp.value = Math.min(this.hp.value, this.hp.max);
  }
}

/* -------------------------------------------- */
/*  Item: Move                                  */
/* -------------------------------------------- */

export class MoveData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      // `type` is reserved on Documents, so the elemental type is `moveType`.
      moveType: new fields.StringField({ required: true, blank: false, initial: "Normal" }),
      category: new fields.StringField({
        required: true, blank: false, initial: "Physical",
        choices: { Physical: "Physical", Special: "Special", Status: "Status" }
      }),
      power: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      accuracy: new fields.NumberField({ required: true, integer: true, min: 0, max: 100, initial: 100 }),
      alwaysHits: new fields.BooleanField({ initial: false }),
      pp: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      priority: new fields.NumberField({ required: true, integer: true, initial: 0 }),
      target: new fields.StringField({ required: false, blank: true, initial: "normal" }),
      description: new fields.HTMLField({ required: false, blank: true })
    };
  }
}

/* -------------------------------------------- */
/*  Item: Ability                               */
/* -------------------------------------------- */

export class AbilityData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      isNonstandard: new fields.BooleanField({ initial: false }),
      description: new fields.HTMLField({ required: false, blank: true })
    };
  }
}

/* -------------------------------------------- */
/*  Item: Gear (items & Poké Balls)             */
/* -------------------------------------------- */

export class GearData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      category: new fields.StringField({
        required: true, blank: false, initial: "item",
        choices: { item: "Item", ball: "Poké Ball", medicine: "Medicine", berry: "Berry", tm: "TM/HM", key: "Key Item" }
      }),
      price: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      quantity: new fields.NumberField({ required: true, integer: true, min: 0, initial: 1 }),
      /** Catch multiplier for Poké Balls (1× default). */
      catchModifier: new fields.NumberField({ required: true, min: 0, initial: 1 }),
      description: new fields.HTMLField({ required: false, blank: true })
    };
  }
}
