/**
 * Pokémon Masters — Sheets (ApplicationV2 + Handlebars).
 *
 * v13/v14 sheets extend the ApplicationV2 sheet classes and declare their
 * markup via static PARTS. Inputs named `system.<path>` are submitted
 * automatically thanks to `form.submitOnChange`.
 */

import { PM } from "./config.mjs";
import { rankTitle, nextRankThreshold } from "./organizations.mjs";
import { getStorage } from "./storage.mjs";
import { dexProgress } from "./dex.mjs";
import { levelCap } from "./gyms.mjs";

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
    position: { width: 560, height: 680 },
    actions: {
      chooseStarter() { return game.pokemonMasters?.starters?.choose(this.actor); },
      joinOrg() { return game.pokemonMasters?.orgs?.joinDialog(this.actor); },
      leaveOrg(event, target) { return game.pokemonMasters?.orgs?.leave(this.actor, target.dataset.org); },
      withdraw(event, target) { return game.pokemonMasters?.storage?.withdraw(this.actor, target.dataset.uuid); },
      deposit(event, target) { return game.pokemonMasters?.storage?.deposit(this.actor, target.dataset.uuid); },
      collectEgg() { return game.pokemonMasters?.breeding?.collectEgg(this.actor); },
      fly() { return game.pokemonMasters?.travel?.fly(this.actor); },
      tradeService() { return game.pokemonMasters?.trade?.serviceDialog(this.actor); },
      shop() { return game.pokemonMasters?.shop?.open(this.actor); },
      pokedex() { return game.pokemonMasters?.pokedex?.open(this.actor); }
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
    context.storage = await getStorage(this.actor);
    context.dex = dexProgress(this.actor);
    context.levelCap = levelCap(this.actor);
    context.daycare = (await Promise.all((this.actor.system.daycare ?? []).map((u) => fromUuid(u)))).filter(Boolean);
    context.affiliations = (this.actor.system.affiliations ?? []).map((a) => {
      const org = PM.organizations[a.org];
      const isMax = a.rank >= (org?.ranks.length ?? 1) - 1;
      const need = nextRankThreshold(a.rank);
      return {
        org: a.org,
        label: org?.label ?? a.org,
        align: org?.align ?? "neutral",
        title: rankTitle(a.org, a.rank),
        reputation: a.reputation,
        need,
        isMax,
        pct: isMax ? 100 : Math.min(100, Math.round((a.reputation / need) * 100))
      };
    });
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
      useMove(event, target) { return this._useMove(target); },
      useItem() { return game.pokemonMasters?.items?.useDialog(this.actor); },
      teachMove() { return game.pokemonMasters?.tms?.teachDialog(this.actor); },
      gimmick() { return this._gimmickMenu(); }
    }
  };

  static PARTS = {
    body: { template: "systems/pokemon-masters/templates/actor/pokemon-sheet.hbs" }
  };

  /** Action: use one of this Pokémon's moves against the current target. */
  _useMove(target) {
    const move = this.actor.items.get(target?.dataset?.itemId);
    if (move && game.pokemonMasters?.battle) game.pokemonMasters.battle.useMove(this.actor, move, null, { autoRetaliate: true });
  }

  /** A single, tidy picker for whatever battle gimmick this Pokémon can use. */
  async _gimmickMenu() {
    const battle = game.pokemonMasters?.battle;
    if (!battle) return;
    const active = this.actor.getFlag("pokemon-masters", "gimmick");
    if (active?.form) return battle.revertGimmick(this.actor);
    const D = foundry.applications?.api?.DialogV2;
    const s = this.actor.system;
    const held = (s.heldItem ?? "").toLowerCase();
    const avail = [];
    if ((s.megaData ?? []).some((m) => (m.item ?? "").toLowerCase() === held)) avail.push({ action: "mega", label: "✨ Mega Evolve" });
    if (held === "tera orb") avail.push({ action: "tera", label: "💎 Terastallize" });
    if (held === "z-crystal") avail.push({ action: "z", label: "⚡ Z-Power" });
    avail.push({ action: "dynamax", label: "🔴 Dynamax" });
    if (!D) return battle.activateGimmick(this.actor, avail[0].action);
    const kind = await D.wait({
      window: { title: "Battle Gimmick" },
      content: `<p style="margin:.2rem 0">Unleash a battle gimmick for <strong>${this.actor.name}</strong>?</p>`,
      buttons: [...avail, { action: "cancel", label: "Cancel" }]
    }).catch(() => "cancel");
    if (kind && kind !== "cancel") return battle.activateGimmick(this.actor, kind);
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
    context.statuses = PM.statuses;
    context.natures = Object.fromEntries(Object.keys(PM.natures).map((n) => [n, n.charAt(0).toUpperCase() + n.slice(1)]));
    context.hpPct = sys.hp?.max ? Math.round(((sys.hp.value ?? 0) / sys.hp.max) * 100) : 0;
    // A single compact gimmick chip: its state is all the sheet needs to show.
    context.gimmick = { active: this.actor.getFlag("pokemon-masters", "gimmick")?.form ?? "" };
    // Level-up moves available at or below this Pokémon's level.
    context.levelMoves = (sys.learnset ?? [])
      .filter((l) => l.level > 0 && l.level <= sys.level)
      .sort((a, b) => a.level - b.level);
    context.otherMoves = (sys.learnset ?? []).filter((l) => !l.level);

    // Resolve each evolution target's OWN requirement (it lives on the target
    // species, not on this one) so the sheet shows the correct rule.
    context.evolutions = [];
    const pack = game.packs.get("pokemon-masters.species");
    for (const name of (sys.evolution?.into ?? [])) {
      const entry = pack?.index?.find((e) => e.name.toLowerCase() === name.toLowerCase());
      const tgt = entry ? await pack.getDocument(entry._id) : null;
      const e = tgt?.system?.evolution ?? {};
      const parts = [];
      if (e.method === "useItem" && e.item) parts.push(`using ${e.item}`);
      else if (e.method === "trade") parts.push("by trade");
      else if (e.method === "levelFriendship") parts.push("with high friendship");
      else if (e.level) parts.push(`at Lv ${e.level}`);
      if (e.condition) parts.push(`(${e.condition})`);
      context.evolutions.push({ name, requirement: parts.join(" ") || "—" });
    }
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
