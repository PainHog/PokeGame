/**
 * Pokémon Masters — Sheets (ApplicationV2 + Handlebars).
 *
 * v13/v14 sheets extend the ApplicationV2 sheet classes and declare their
 * markup via static PARTS. Inputs named `system.<path>` are submitted
 * automatically thanks to `form.submitOnChange`.
 */

import { PM } from "./config.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2, ItemSheetV2 } = foundry.applications.sheets;

const SHEET_DEFAULTS = {
  classes: ["pokemon-masters", "sheet"],
  form: { submitOnChange: true, closeOnSubmit: false },
  window: { resizable: true }
};

/* -------------------------------------------- */
/*  Trainer sheet                                */
/* -------------------------------------------- */

export class TrainerSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    ...SHEET_DEFAULTS,
    classes: [...SHEET_DEFAULTS.classes, "trainer"],
    position: { width: 560, height: 620 },
    actions: {
      chooseStarter() { return game.pokemonMasters?.starters?.choose(this.actor); }
    }
  };

  static PARTS = {
    body: { template: "systems/pokemon-masters/templates/actor/trainer-sheet.hbs" }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.actor = this.actor;
    context.system = this.actor.system;
    context.vocations = PM.vocations;
    context.vocationBlurb = PM.vocationInfo?.[this.actor.system.vocation]?.blurb ?? "";
    context.editable = this.isEditable;
    context.party = await this.actor.getParty();
    return context;
  }
}

/* -------------------------------------------- */
/*  Pokémon sheet                                */
/* -------------------------------------------- */

export class PokemonSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    ...SHEET_DEFAULTS,
    classes: [...SHEET_DEFAULTS.classes, "pokemon"],
    position: { width: 540, height: 680 },
    actions: {
      useMove(event, target) { return this._useMove(target); }
    }
  };

  static PARTS = {
    body: { template: "systems/pokemon-masters/templates/actor/pokemon-sheet.hbs" }
  };

  /** Action: use one of this Pokémon's moves against the current target. */
  _useMove(target) {
    const move = this.actor.items.get(target?.dataset?.itemId);
    if (move && game.pokemonMasters?.battle) game.pokemonMasters.battle.useMove(this.actor, move);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const sys = this.actor.system;
    context.actor = this.actor;
    context.system = sys;
    context.editable = this.isEditable;
    context.rarities = PM.rarities;
    context.stats = sys.stats ?? {};
    context.knownMoves = this.actor.items.filter((i) => i.type === "move");
    context.hpPct = sys.hp?.max ? Math.round(((sys.hp.value ?? 0) / sys.hp.max) * 100) : 0;
    // Level-up moves available at or below this Pokémon's level.
    context.levelMoves = (sys.learnset ?? [])
      .filter((l) => l.level > 0 && l.level <= sys.level)
      .sort((a, b) => a.level - b.level);
    context.otherMoves = (sys.learnset ?? []).filter((l) => !l.level);
    return context;
  }
}

/* -------------------------------------------- */
/*  Item sheet (move / ability / gear)           */
/* -------------------------------------------- */

export class PMItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    ...SHEET_DEFAULTS,
    classes: [...SHEET_DEFAULTS.classes, "item"],
    position: { width: 480, height: 480 }
  };

  static PARTS = {
    body: { template: "systems/pokemon-masters/templates/item/item-sheet.hbs" }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.item = this.item;
    context.system = this.item.system;
    context.editable = this.isEditable;
    context.isMove = this.item.type === "move";
    context.isAbility = this.item.type === "ability";
    context.isGear = this.item.type === "gear";
    context.types = PM.types;
    context.moveCategories = { Physical: "Physical", Special: "Special", Status: "Status" };
    return context;
  }
}
