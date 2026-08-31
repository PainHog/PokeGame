/**
 * Pokémon Masters — Region (tile) behaviors.
 *
 * Foundry v12+ replaced ad-hoc "tile triggers" with first-class **Scene
 * Regions** that emit movement events (tokenEnter, tokenMoveIn, tokenMoveWithin,
 * …). A RegionBehaviorType is a data model that subscribes to those events —
 * the native, module-free way to make walking around the map *do* things.
 *
 * Behaviors shipped:
 *   • Wild Tile   — stepping on a non-safe tile has a chance to roll an outcome:
 *                   a wild Pokémon battle, a found item, an NPC trainer, or a
 *                   GM event. Encounter tables are chosen by the Scene's region
 *                   tag, so the same "cave" yields Geodude in Kanto and Alolan
 *                   Geodude in Alola. Rarity gating keeps rare Pokémon rare.
 *   • Safe Zone   — streets / towns / Centers / Marts. Never roll events; a
 *                   Center heals the party on entry.
 *   • Zone Transit— named-zone entry announcement + same-scene warp.
 *
 * Region events fire on every connected client, so all world mutations are gated
 * to a single responsible client (`isResponsible`: the active GM, or the
 * token's primary owner when no GM is online) to avoid duplicates.
 */

import { PM } from "./config.mjs";
import { catchButtonHtml } from "./catch.mjs";
import { eligibleSpecies, methodForCategory } from "./eligibility.mjs";
import { markSeen } from "./dex.mjs";
import { isResponsible } from "./permissions.mjs";
import { applyIndividuality } from "./individuality.mjs";

const fields = foundry.data.fields;

// String event keys (avoids depending on the CONST global at class-eval time).
const EVENTS = {
  TOKEN_ENTER: "tokenEnter",
  TOKEN_MOVE_IN: "tokenMoveIn",
  TOKEN_MOVE_WITHIN: "tokenMoveWithin"
};

// Tokens that just crossed scenes — suppress region behaviours re-firing on the
// arrival tile (v14 fires tokenMoveIn when a token is *placed* inside a region too,
// which would otherwise bounce the player straight back out).
const recentlyTeleported = new Set();
export function guardTeleport(actorId) { if (!actorId) return; recentlyTeleported.add(actorId); setTimeout(() => recentlyTeleported.delete(actorId), 1500); }
/** True while an actor's token has just been placed on a new scene (so region
 *  behaviours in other modules can skip the arrival tile too). */
export function justTeleported(actorId) { return !!actorId && recentlyTeleported.has(actorId); }

/** Resolve the moving/entering actor from a region event, if it's a Trainer. */
function trainerFromEvent(event) {
  const token = event?.data?.token;
  const actor = token?.actor ?? null;
  if (!actor || actor.type !== "trainer") return { token: null, actor: null };
  if (recentlyTeleported.has(actor.id)) return { token: null, actor: null };
  // Placed NPC actors (Nurse Joy, Officer Jenny, townsfolk…) are scenery — they
  // must never trigger venue greetings, healing or wild encounters themselves.
  if (actor.getFlag?.("pokemon-masters", "isNpc")) return { token: null, actor: null };
  return { token, actor };
}

/** The Pokémon Masters region tag of a scene (falls back to empty = generic). */
export function sceneRegion(scene) {
  return scene?.getFlag?.("pokemon-masters", "region") ?? "";
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Weighted pick from `[{weight, …}]`. Returns the chosen row. */
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

/** Look up a compendium document by name (case-insensitive). */
async function findInPack(packId, name) {
  const pack = game.packs.get(packId);
  if (!pack) return null;
  const key = String(name).toLowerCase();
  const entry = pack.index.find((e) => e.name.toLowerCase() === key);
  return entry ? pack.getDocument(entry._id) : null;
}

/* -------------------------------------------- */
/*  Wild Tile behavior                           */
/* -------------------------------------------- */

export class WildTileBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["PM.RegionBehavior.WildTile"];

  static defineSchema() {
    const weight = (initial) => new fields.NumberField({ required: true, min: 0, integer: true, initial });
    return {
      /** Region override; empty = use the Scene's region tag. */
      regionTag: new fields.StringField({
        required: false, blank: true, initial: "",
        choices: { "": "— Use scene region —", ...PM.regions }
      }),
      category: new fields.StringField({
        required: true, blank: false, initial: "grass", choices: PM.encounterCategories
      }),
      /** % chance that *any* event roll happens on a qualifying step. */
      chance: new fields.NumberField({ required: true, integer: true, min: 0, max: 100, initial: 25 }),
      onEveryStep: new fields.BooleanField({ initial: true }),
      /** Relative weights for what a triggered roll produces. */
      outcomes: new fields.SchemaField({
        wild: weight(50),
        item: weight(15),
        trainer: weight(5),
        event: weight(0),
        nothing: weight(30)
      }),
      minLevel: new fields.NumberField({ required: true, integer: true, min: 1, max: 100, initial: 2 }),
      maxLevel: new fields.NumberField({ required: true, integer: true, min: 1, max: 100, initial: 6 }),
      /** Where the candidate species come from. */
      poolSource: new fields.StringField({
        required: true, blank: false, initial: "requirements",
        choices: {
          requirements: "By requirements (auto)",
          regionTable: "Region habitat table",
          custom: "Custom table"
        }
      }),
      table: new fields.ArrayField(new fields.SchemaField({
        species: new fields.StringField({ required: true, blank: false }),
        weight: new fields.NumberField({ required: true, min: 0, initial: 10 }),
        min: new fields.NumberField({ required: false, nullable: true, integer: true, min: 1 }),
        max: new fields.NumberField({ required: false, nullable: true, integer: true, min: 1 })
      })),
      /** Announce in chat only, vs. also dropping a wild token onto the scene. */
      announceOnly: new fields.BooleanField({ initial: true }),
      /** Optional Macro UUID run on an `event` outcome. */
      eventMacro: new fields.DocumentUUIDField({ type: "Macro", required: false, nullable: true, initial: null })
    };
  }

  // Roll on the entry step (tokenMoveIn) and, when onEveryStep, each internal
  // step (tokenMoveWithin). Deliberately NOT tokenEnter — that also fires
  // alongside tokenMoveIn (double-roll) and when a token is merely placed inside.
  static events = {
    [EVENTS.TOKEN_MOVE_IN]: async function (event) {
      return this.constructor._roll.call(this, event);
    },
    [EVENTS.TOKEN_MOVE_WITHIN]: async function (event) {
      if (!this.onEveryStep) return;
      return this.constructor._roll.call(this, event);
    }
  };

  static async _roll(event) {
    const { token, actor } = trainerFromEvent(event);
    if (!actor) return;
    if (!isResponsible(token)) return;

    // Repel burns a step and suppresses wild Pokémon (items/trainers still occur).
    let repelActive = false;
    const repel = actor.getFlag("pokemon-masters", "repelSteps") ?? 0;
    if (repel > 0) {
      repelActive = true;
      await actor.setFlag("pokemon-masters", "repelSteps", repel - 1);
      if (repel - 1 <= 0) await ChatMessage.create({ speaker: { alias: actor.name }, content: "<p>The effect of the Repel wore off.</p>" });
    }

    // Gate: does anything happen on this step at all? Cruising on the Bicycle
    // covers ground fast, so wild encounters are noticeably rarer.
    let chance = this.chance;
    if (actor.getFlag("pokemon-masters", "onBike")) chance = Math.round(chance * 0.6);
    if (randInt(1, 100) > chance) return;

    // Choose an outcome kind by weight.
    const o = this.outcomes;
    const kind = weightedPick([
      { kind: "wild", weight: o.wild },
      { kind: "item", weight: o.item },
      { kind: "trainer", weight: o.trainer },
      { kind: "event", weight: o.event },
      { kind: "nothing", weight: o.nothing }
    ])?.kind;

    switch (kind) {
      case "wild": return WildTileBehaviorType.rollWild.call(this, token);
      case "item": return WildTileBehaviorType.rollItem.call(this, token);
      case "trainer": return WildTileBehaviorType.rollTrainer.call(this, token);
      case "event": return WildTileBehaviorType.rollEvent.call(this, token);
      default: return; // nothing
    }
  }

  /** Region used for table resolution: behavior override → scene tag → generic. */
  get effectiveRegion() {
    return this.regionTag || sceneRegion(this.behavior?.parent?.parent) || "";
  }

  static async rollWild(token) {
    const region = this.effectiveRegion;
    const method = methodForCategory(this.category);

    // Build the candidate pool. "requirements" computes eligible species whose
    // habitat/region/method requirements all match this tile — the core rule.
    let rows;
    if (this.poolSource === "custom") rows = this.toObject().table;
    else if (this.poolSource === "regionTable") rows = PM.resolveEncounterTable(region, this.category);
    else rows = await eligibleSpecies({ habitat: this.category, region, method });

    if (!rows?.length) return; // nothing meets the requirements here — no encounter

    const pick = weightedPick(rows);
    if (!pick) return;
    const speciesName = pick.species ?? pick.name;

    const speciesActor = await findInPack("pokemon-masters.species", speciesName);
    if (!speciesActor) {
      console.warn(`Pokémon Masters | Encounter species not found: ${speciesName}`);
      return;
    }
    await markSeen(token.actor, speciesActor.name);

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

    if (this.announceOnly) await WildTileBehaviorType.announceWild.call(this, token, speciesActor, level);
    else await WildTileBehaviorType.spawnWild.call(this, token, speciesActor, level);
  }

  static async announceWild(token, speciesActor, level) {
    const s = speciesActor.system;
    const types = (s.types ?? []).join(" / ");
    const rarityLabel = PM.rarities[s.rarity] ?? s.rarity;
    const regionLabel = PM.regions[this.effectiveRegion] ?? "the wild";
    await ChatMessage.create({
      speaker: { alias: "Wild Encounter" },
      content: `
        <div class="pm-encounter-card">
          <h3>A wild <strong>${speciesActor.name}</strong> appeared!</h3>
          <p><b>Level:</b> ${level} &nbsp; <b>Type:</b> ${types}</p>
          <p><b>Rarity:</b> ${rarityLabel} &nbsp; <b>Catch rate:</b> ${s.catchRate}</p>
          <p><em>${token.name} startled it in ${regionLabel} (${PM.encounterCategories[this.category] ?? "wild"}).</em></p>
          <p>${catchButtonHtml({ speciesUuid: speciesActor.uuid, level })}</p>
        </div>`
    });
  }

  static async spawnWild(token, speciesActor, level) {
    const scene = token.parent;
    if (!scene) return WildTileBehaviorType.announceWild.call(this, token, speciesActor, level);

    const source = speciesActor.toObject();
    delete source._id;
    source.folder = null;
    source.system.level = level;
    source.system.hp = { value: null, max: 0 };
    applyIndividuality(source.system);
    const created = await Actor.implementation.create(source);
    if (!created) return;

    const gs = scene.grid.size;
    const tokenDoc = await created.getTokenDocument();
    await scene.createEmbeddedDocuments("Token", [{
      ...tokenDoc.toObject(),
      x: token.x + gs,
      y: token.y,
      disposition: -1
    }]);
    await WildTileBehaviorType.announceWild.call(this, token, speciesActor, level);
  }

  static async rollItem(token) {
    const pick = weightedPick(PM.itemFindTable.map((r) => ({ ...r, weight: r.weight })));
    if (!pick) return;
    const gear = await findInPack("pokemon-masters.gear", pick.item);
    const img = gear?.img ?? "icons/svg/item-bag.svg";
    await ChatMessage.create({
      speaker: { alias: "Item Found" },
      content: `
        <div class="pm-encounter-card">
          <h3>${token.name} found an item!</h3>
          <p><img src="${img}" width="24" height="24" style="vertical-align:middle"> <strong>${pick.item}</strong></p>
        </div>`
    });
  }

  static async rollTrainer(token) {
    const trainer = token.actor;
    // A wandering Trainer challenges the player: resolve it as a real auto-battle.
    const CLASSES = ["Youngster", "Lass", "Bug Catcher", "Hiker", "Beauty", "Ace Trainer", "Picnicker", "Camper"];
    const who = CLASSES[Math.floor(Math.random() * CLASSES.length)];
    if (trainer?.type !== "trainer") {
      return ChatMessage.create({ speaker: { alias: "Trainer Battle" }, content: `<div class="pm-encounter-card"><h3>${who} wants to battle!</h3><p>No challenger is here to accept.</p></div>` });
    }
    const { simulateBattle, teamOf } = await import("./npc.mjs");
    const { generateFoeTeam } = await import("./events.mjs");
    const myTeam = await teamOf(trainer);
    if (!myTeam.length) {
      return ChatMessage.create({ speaker: { alias: who }, content: `<div class="pm-encounter-card"><h3>${who} wants to battle!</h3><p>${trainer.name} has no Pokémon to fight with.</p></div>` });
    }
    const level = Math.max(...myTeam.map((m) => m.level ?? 5));
    const foes = await generateFoeTeam(Math.min(3, myTeam.length), level);
    const { winner, log } = simulateBattle(myTeam.map((m) => ({ ...m, hp: { value: m.stats.hp, max: m.stats.hp } })), foes);
    const won = winner === "A";
    const prize = won ? level * 20 : 0;
    if (won) await trainer.update({ "system.money": (trainer.system.money ?? 0) + prize });
    await ChatMessage.create({
      speaker: { alias: `${who} battle` },
      content: `<div class="pm-encounter-card">
        <h3>${who} challenged ${trainer.name}!</h3>
        <p>${won ? `<span class="pm-caught">You won!</span> Prize money: ₽${prize}.` : `${trainer.name} was defeated — no prize this time.`}</p>
        <details><summary>Battle log</summary><ol class="pm-battle-log"><li>${log.slice(0, 24).join("</li><li>")}</li></ol></details>
      </div>`
    });
  }

  static async rollEvent(token) {
    if (this.eventMacro) {
      const macro = await fromUuid(this.eventMacro);
      if (macro?.execute) return macro.execute({ token, behavior: this.behavior });
    }
    await ChatMessage.create({
      speaker: { alias: "Event" },
      content: `<p><strong>${token.name}</strong> triggered a special event.</p>`
    });
  }
}

/* -------------------------------------------- */
/*  Safe Zone behavior                           */
/* -------------------------------------------- */

export class SafeZoneBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["PM.RegionBehavior.SafeZone"];

  static defineSchema() {
    return {
      kind: new fields.StringField({
        required: true, blank: false, initial: "town", choices: PM.safeZoneKinds
      }),
      healOnEnter: new fields.BooleanField({ initial: true }),
      announce: new fields.BooleanField({ initial: true }),
      // Gym metadata (kind === "gym"): which leader/region/order this gym is.
      leader: new fields.StringField({ required: false, blank: true, initial: "" }),
      gymRegion: new fields.StringField({ required: false, blank: true, initial: "" }),
      gymIndex: new fields.NumberField({ required: false, nullable: true, integer: true, min: 0, initial: null }),
      gymType: new fields.StringField({ required: false, blank: true, initial: "" }),
      badge: new fields.StringField({ required: false, blank: true, initial: "" })
    };
  }

  static events = {
    [EVENTS.TOKEN_MOVE_IN]: async function (event) {
      const { token, actor } = trainerFromEvent(event);
      if (!actor) return;
      if (!isResponsible(token)) return;

      // Visiting a town/Center/Mart registers this scene as a Fly destination.
      if (["town", "center", "mart", "police"].includes(this.kind) && token.parent?.name) {
        const pts = actor.system.flyPoints ?? [];
        if (!pts.includes(token.parent.name)) await actor.update({ "system.flyPoints": [...pts, token.parent.name] });
      }

      if (this.kind === "center") {
        if (this.healOnEnter) {
          const party = await actor.getParty();
          for (const mon of party) {
            await mon.update({ "system.hp.value": mon.system.hp.max, "system.status": "none" });
          }
        }
        if (this.announce) {
          // Nurse Joy greets you; the button opens a real click-through chat.
          await ChatMessage.create({
            speaker: { alias: "Nurse Joy" },
            content: `<div class="pm-encounter-card">
              <h3>💗 Welcome to the Pokémon Center!</h3>
              <p>${this.healOnEnter ? `We've restored <strong>${actor.name}</strong>'s Pokémon to full health! We hope to see you again!` : "Would you like to rest your Pokémon?"}</p>
              <button type="button" class="pm-nurse-btn">Talk to Nurse Joy</button>
            </div>`
          });
        }
        return;
      }

      if (this.kind === "police") {
        if (this.announce) {
          await ChatMessage.create({
            speaker: { alias: "Officer Jenny" },
            content: `<div class="pm-encounter-card">
              <h3>🚓 Welcome to the Police Station</h3>
              <p>If you've witnessed a crime — or had a Pokémon stolen — report it here. We reward good citizens for their civic duty.</p>
              <button type="button" class="pm-police-btn">Talk to Officer Jenny</button>
            </div>`
          });
        }
        return;
      }

      if (this.kind === "gym") {
        if (this.announce) {
          const leader = this.leader || "the Gym Leader";
          const typ = this.gymType ? ` <em>${this.gymType}-type</em>` : "";
          await ChatMessage.create({
            speaker: { alias: leader },
            content: `<div class="pm-encounter-card">
              <h3>★ ${leader}'s Gym</h3>
              <p>Welcome, challenger! Beat me and my${typ} team to earn the <strong>${this.badge || "Gym"} Badge</strong>.</p>
              <button type="button" class="pm-gym-btn" data-region="${this.gymRegion || ""}" data-index="${this.gymIndex ?? ""}">Challenge ${leader}</button>
            </div>`
          });
        }
        return;
      }

      if (this.announce) {
        const label = PM.safeZoneKinds[this.kind] ?? "a safe area";
        const msg = this.kind === "mart"
          ? `🛒 <strong>${actor.name}</strong> entered the Poké Mart. Open your sheet → 🛒 Shop to buy & sell.`
          : `<strong>${actor.name}</strong> entered ${label}.`;
        await ChatMessage.create({ speaker: { alias: "World" }, content: `<p>${msg}</p>` });
      }
    }
  };
}

/* -------------------------------------------- */
/*  Venue behavior (Safari, Game Corner, …)      */
/* -------------------------------------------- */

/**
 * Walking into a tagged building posts a themed arrival card with a single
 * "enter" button, so players opt into the activity instead of a dialog popping
 * on movement or another button cluttering their sheet. The button is wired by
 * `events.mjs`; the card is posted once, by the responsible client.
 */
export class VenueBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["PM.RegionBehavior.Venue"];

  static defineSchema() {
    return {
      venue: new fields.StringField({ required: true, blank: false, initial: "gamecorner", choices: PM.venueKinds }),
      target: new fields.StringField({ required: false, blank: true, initial: "" })
    };
  }

  static events = {
    [EVENTS.TOKEN_MOVE_IN]: async function (event) {
      const { token, actor } = trainerFromEvent(event);
      if (!actor || !isResponsible(token)) return;
      const meta = PM.venueInfo?.[this.venue] ?? { label: "a venue", icon: "🏛️", cta: "Enter" };
      await ChatMessage.create({
        speaker: { alias: meta.label },
        content: `<div class="pm-encounter-card pm-venue-card">
          <h3>${meta.icon} ${meta.label}</h3>
          <p><strong>${actor.name}</strong> arrived at ${meta.label}.</p>
          <button type="button" class="pm-venue-btn" data-venue="${this.venue}" data-target="${this.target ?? ""}">${meta.cta}</button>
        </div>`
      });
    }
  };
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
      /** Entry point on the destination (or same-scene warp target), in pixels. */
      destX: new fields.NumberField({ required: true, integer: true, initial: 0 }),
      destY: new fields.NumberField({ required: true, integer: true, initial: 0 }),
      /** Destination scene BY NAME — survives compendium import (unlike a UUID). */
      destinationSceneName: new fields.StringField({ required: false, blank: true, initial: "" }),
      destinationScene: new fields.DocumentUUIDField({ type: "Scene", required: false, nullable: true, initial: null }),
      /** Gear item the trainer must carry to pass (e.g. "S.S. Ticket" for a ship). */
      requiredItem: new fields.StringField({ required: false, blank: true, initial: "" }),
      /** Field move a party Pokémon must know to cross (e.g. "surf" to reach a sea
       *  route/lake — you can't walk onto open water without it). */
      requiredMove: new fields.StringField({ required: false, blank: true, initial: "" }),
      /** This door walks the player INTO a building interior — remember where they
       *  came from so the interior's exit can send them back. */
      enterInterior: new fields.BooleanField({ initial: false }),
      /** This door is a building interior's EXIT — return to the remembered scene. */
      returnDoor: new fields.BooleanField({ initial: false })
    };
  }

  static events = {
    [EVENTS.TOKEN_MOVE_IN]: async function (event) {
      const { token, actor } = trainerFromEvent(event);
      if (!actor) return;

      if (this.announce && this.zoneName && isResponsible(token)) {
        await ChatMessage.create({
          speaker: { alias: "World" },
          content: `<p><strong>${token.name}</strong> entered <strong>${this.zoneName}</strong>.</p>`
        });
      }
      if (!isResponsible(token)) return;

      // Interior exit: walk back out to the town you entered from.
      if (this.returnDoor) {
        const ret = actor.getFlag("pokemon-masters", "returnScene");
        const back = ret?.name ? game.scenes?.getName(ret.name) : null;
        if (back && back !== token.parent) await crossScene(token, actor, back, ret.x || 0, ret.y || 0);
        return;
      }

      // Resolve the destination scene (by name first, then UUID); import an
      // interior on demand if it isn't in the world yet.
      let destScene = this.destinationSceneName ? game.scenes?.getName(this.destinationSceneName) : null;
      if (!destScene && this.destinationScene) destScene = await fromUuid(this.destinationScene);
      if (!destScene && this.enterInterior && this.destinationSceneName) {
        destScene = await game.pokemonMasters?.placement?.ensureScene?.(this.destinationSceneName);
      }

      if (destScene && destScene !== token.parent) {
        if (this.requiredItem && !actor.items.some((i) => i.type === "gear" && i.name.toLowerCase() === this.requiredItem.toLowerCase())) {
          ui.notifications?.warn(`You need a ${this.requiredItem} to board.`);
          return;
        }
        // Open water: you can't step onto a sea route/lake without a party Pokémon
        // that knows the field move (Surf).
        if (this.requiredMove) {
          const moveName = CONFIG.PM?.fieldMoves?.[this.requiredMove] ?? this.requiredMove;
          const partyKnows = game.pokemonMasters?.tms?.partyKnows;
          if (partyKnows && !(await partyKnows(actor, moveName))) {
            if (isResponsible(token)) ui.notifications?.warn(`You need a Pokémon that knows ${moveName} to cross the water.`);
            return;
          }
        }
        // Remember the town + a spot just outside the door for the trip back.
        if (this.enterInterior) {
          await actor.setFlag("pokemon-masters", "returnScene", { name: token.parent?.name, x: token.x, y: token.y + 260 });
        }
        // An authentic interior declares its own entry mat; fall back to the
        // door's baked coords for the placeholder rooms.
        const entry = destScene.getFlag?.("pokemon-masters", "entry");
        await crossScene(token, actor, destScene, entry?.x ?? this.destX, entry?.y ?? this.destY);
      } else if (this.destX || this.destY) {
        await token.update({ x: this.destX, y: this.destY });
      }
    }
  };
}

/** Move a token to another Scene at (x, y) and bring its owner(s) along. */
export async function crossScene(token, actor, destScene, x, y) {
  const source = token.toObject();
  delete source._id;
  // Clamp the arrival point inside the destination scene (interiors are small).
  const gs = destScene.grid?.size ?? 100;
  source.x = Math.max(0, Math.min(x || 0, Math.max(0, (destScene.width ?? gs) - gs)));
  source.y = Math.max(0, Math.min(y || 0, Math.max(0, (destScene.height ?? gs) - gs)));
  await destScene.createEmbeddedDocuments("Token", [source]);
  guardTeleport(actor?.id);   // don't let the arrival tile bounce them straight back
  if (token.parent && token.id) await token.parent.deleteEmbeddedDocuments("Token", [token.id]);

  const ownerIds = (game.users?.contents ?? [])
    .filter((u) => !u.isGM && u.active && actor.testUserPermission(u, "OWNER"))
    .map((u) => u.id);
  if (game.user.isGM && ownerIds.length) {
    game.socket.emit("system.pokemon-masters", { action: "viewScene", sceneId: destScene.id, userIds: ownerIds });
  }
  if (ownerIds.includes(game.user.id) || game.user.isGM) destScene.view();
}

/** Socket: pull a player to a destination scene when the GM moved their token. */
export function registerTravelSocket() {
  game.socket.on("system.pokemon-masters", (data) => {
    if (data?.action === "viewScene" && data.userIds?.includes(game.user.id)) {
      game.scenes.get(data.sceneId)?.view();
    }
  });
}
