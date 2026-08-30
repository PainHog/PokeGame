/**
 * Pokémon Masters — Region (tile) behaviors.
 *
 * Foundry v12+ replaced ad-hoc "tile triggers" with first-class **Scene
 * Regions** that emit events (tokenEnter, tokenMoveIn, tokenMoveWithin, …).
 * A RegionBehaviorType is a data model that subscribes to those events. This is
 * the native, module-free way to make walking around the map *do* things.
 *
 * We ship two behaviors:
 *   • Encounter    — walking a Trainer through the region can trigger a wild
 *                    Pokémon, drawn from a category table (grass/water/cave/…)
 *                    with rarity gating so rare Pokémon are genuinely hard to find.
 *   • Zone Transit — entering the region announces a named zone and/or warps the
 *                    token to a destination (an automatic "walk to the next zone").
 *
 * Region events fire on every connected client, so all world mutations (creating
 * chat messages, moving tokens) are gated to the single active GM to avoid dupes.
 */

import { PM } from "./config.mjs";

const fields = foundry.data.fields;

// String event keys (avoids depending on the CONST global at class-eval time).
const EVENTS = {
  TOKEN_ENTER: "tokenEnter",
  TOKEN_MOVE_IN: "tokenMoveIn",
  TOKEN_MOVE_WITHIN: "tokenMoveWithin"
};

/** True only on the one client that should perform world writes. */
function isDriver() {
  return game.users.activeGM?.isSelf ?? false;
}

/** Resolve the moving/entering actor from a region event, if it's a Trainer. */
function trainerFromEvent(event) {
  const token = event?.data?.token;
  const actor = token?.actor ?? null;
  if (!actor || actor.type !== "trainer") return { token: null, actor: null };
  return { token, actor };
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Weighted pick from `[{species, weight, …}]`. Returns the chosen row. */
function weightedPick(rows) {
  const total = rows.reduce((sum, r) => sum + (r.weight || 0), 0);
  if (total <= 0) return null;
  let roll = Math.random() * total;
  for (const row of rows) {
    roll -= row.weight || 0;
    if (roll < 0) return row;
  }
  return rows[rows.length - 1];
}

/* -------------------------------------------- */
/*  Encounter behavior                           */
/* -------------------------------------------- */

export class EncounterBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["PM.RegionBehavior.Encounter"];

  static defineSchema() {
    return {
      category: new fields.StringField({
        required: true, blank: false, initial: "grass", choices: PM.encounterCategories
      }),
      /** % chance to trigger an encounter each qualifying step. */
      chance: new fields.NumberField({ required: true, integer: true, min: 0, max: 100, initial: 20 }),
      minLevel: new fields.NumberField({ required: true, integer: true, min: 1, max: 100, initial: 2 }),
      maxLevel: new fields.NumberField({ required: true, integer: true, min: 1, max: 100, initial: 6 }),
      /** Fire on every step inside the region, or only when first entering it. */
      onEveryStep: new fields.BooleanField({ initial: true }),
      /** Use the category's default table, or the custom table below. */
      useDefaultTable: new fields.BooleanField({ initial: true }),
      table: new fields.ArrayField(new fields.SchemaField({
        species: new fields.StringField({ required: true, blank: false }),
        weight: new fields.NumberField({ required: true, min: 0, initial: 10 }),
        min: new fields.NumberField({ required: false, nullable: true, integer: true, min: 1 }),
        max: new fields.NumberField({ required: false, nullable: true, integer: true, min: 1 })
      })),
      /** Announce in chat only, vs. also dropping a wild token onto the scene. */
      announceOnly: new fields.BooleanField({ initial: true })
    };
  }

  static events = {
    [EVENTS.TOKEN_ENTER]: async function (event) {
      if (this.onEveryStep) return; // entry handled by move events when stepping
      return this.constructor._tryEncounter.call(this, event);
    },
    [EVENTS.TOKEN_MOVE_IN]: async function (event) {
      return this.constructor._tryEncounter.call(this, event);
    },
    [EVENTS.TOKEN_MOVE_WITHIN]: async function (event) {
      if (!this.onEveryStep) return;
      return this.constructor._tryEncounter.call(this, event);
    }
  };

  static async _tryEncounter(event) {
    if (!isDriver()) return;
    const { token, actor } = trainerFromEvent(event);
    if (!actor) return;

    // Base per-step chance.
    if (randInt(1, 100) > this.chance) return;

    const rows = this.useDefaultTable ? (PM.defaultEncounterTables[this.category] ?? []) : this.toObject().table;
    if (!rows.length) return;
    const pick = weightedPick(rows);
    if (!pick) return;

    // Resolve the species from the Pokédex compendium.
    const speciesActor = await EncounterBehaviorType.findSpecies(pick.species);
    if (!speciesActor) {
      console.warn(`Pokémon Masters | Encounter species not found in Pokédex: ${pick.species}`);
      return;
    }

    // Rarity gate — rare things win the weighted roll but still slip away.
    const rarity = speciesActor.system.rarity ?? "common";
    const gate = PM.rarityEncounterChance[rarity] ?? 1;
    if (Math.random() > gate) {
      await ChatMessage.create({
        speaker: { alias: "Wild Area" },
        content: `<p><em>${token.name} senses something rare nearby… but it slips away.</em></p>`,
        whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id)
      });
      return;
    }

    const min = pick.min ?? this.minLevel;
    const max = Math.max(min, pick.max ?? this.maxLevel);
    const level = randInt(min, max);

    if (this.announceOnly) {
      await EncounterBehaviorType.announce(token, speciesActor, level);
    } else {
      await EncounterBehaviorType.spawn(token, speciesActor, level);
    }
  }

  /** Look up a species Actor by name in the compiled Pokédex pack. */
  static async findSpecies(name) {
    const pack = game.packs.get("pokemon-masters.species");
    if (!pack) return null;
    const key = String(name).toLowerCase();
    const entry = pack.index.find((e) => e.name.toLowerCase() === key);
    return entry ? pack.getDocument(entry._id) : null;
  }

  /** Post a wild-encounter chat card. */
  static async announce(token, speciesActor, level) {
    const s = speciesActor.system;
    const types = (s.types ?? []).join(" / ");
    const rarityLabel = PM.rarities[s.rarity] ?? s.rarity;
    await ChatMessage.create({
      speaker: { alias: "Wild Encounter" },
      content: `
        <div class="pm-encounter-card">
          <h3>A wild <strong>${speciesActor.name}</strong> appeared!</h3>
          <p><b>Level:</b> ${level} &nbsp; <b>Type:</b> ${types}</p>
          <p><b>Rarity:</b> ${rarityLabel} &nbsp; <b>Catch rate:</b> ${s.catchRate}</p>
          <p><em>${token.name} startled it out of the ${PM.encounterCategories[this?.category] ?? "wild"}.</em></p>
        </div>`
    });
  }

  /** Import the species, set its level, and drop a wild token beside the trainer. */
  static async spawn(token, speciesActor, level) {
    const scene = token.parent;
    if (!scene) return this.announce(token, speciesActor, level);

    const source = speciesActor.toObject();
    delete source._id;
    source.folder = null;
    source.system.level = level;
    source.system.hp = { value: null, max: 0 };
    const created = await Actor.implementation.create(source);
    if (!created) return;

    const gs = scene.grid.size;
    await scene.createEmbeddedDocuments("Token", [{
      ...(await created.getTokenDocument()).toObject(),
      x: token.x + gs,
      y: token.y,
      disposition: -1
    }]);
    await EncounterBehaviorType.announce.call(this, token, speciesActor, level);
  }
}

/* -------------------------------------------- */
/*  Zone-transit behavior                        */
/* -------------------------------------------- */

export class ZoneTransitBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["PM.RegionBehavior.ZoneTransit"];

  static defineSchema() {
    return {
      zoneName: new fields.StringField({ required: false, blank: true, initial: "" }),
      announce: new fields.BooleanField({ initial: true }),
      /** Same-scene warp target, in pixels. Leave both 0 to disable. */
      destX: new fields.NumberField({ required: true, integer: true, initial: 0 }),
      destY: new fields.NumberField({ required: true, integer: true, initial: 0 }),
      /** Optional Scene UUID to view when entering (GM side; player pull is future work). */
      destinationScene: new fields.DocumentUUIDField({ type: "Scene", required: false, nullable: true, initial: null })
    };
  }

  static events = {
    [EVENTS.TOKEN_ENTER]: async function (event) {
      const { token, actor } = trainerFromEvent(event);
      if (!actor) return;

      if (this.announce && this.zoneName && isDriver()) {
        await ChatMessage.create({
          speaker: { alias: "World" },
          content: `<p><strong>${token.name}</strong> entered <strong>${this.zoneName}</strong>.</p>`
        });
      }

      if (!isDriver()) return;

      if (this.destX || this.destY) {
        await token.update({ x: this.destX, y: this.destY });
      } else if (this.destinationScene) {
        const scene = await fromUuid(this.destinationScene);
        scene?.view?.();
      }
    }
  };
}
