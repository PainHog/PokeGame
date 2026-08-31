/**
 * Pokémon Masters — TMs, move tutors, and HM field moves.
 *
 * Teaching: a Pokémon can learn any move in its stored learnset (which already
 * includes its TM/tutor/egg moves). `teachMove` validates against that learnset,
 * caps known moves at four (with a replace prompt), and adds the move as an Item.
 *
 * Field moves (HMs): a **Field Move Gate** region behavior blocks a tile unless
 * a party Pokémon knows the required move (Surf, Cut, Strength…), bouncing the
 * token back to where it came from.
 */

import { PM } from "./config.mjs";
import { isResponsible } from "./permissions.mjs";

const fields = foundry.data.fields;
const EVENTS = { TOKEN_ENTER: "tokenEnter", TOKEN_MOVE_IN: "tokenMoveIn" };

async function findMove(name) {
  const pack = game.packs.get("pokemon-masters.moves");
  if (!pack) return null;
  const key = String(name).toLowerCase();
  const entry = pack.index.find((e) => e.name.toLowerCase() === key);
  return entry ? pack.getDocument(entry._id) : null;
}

/** Can this Pokémon learn the move (is it in its learnset)? */
export function canLearn(pokemon, moveName) {
  const key = String(moveName).toLowerCase();
  return (pokemon.system.learnset ?? []).some((l) => l.move.toLowerCase() === key);
}

/** Does the Pokémon already know the move (owns it as an Item)? */
export function knows(pokemon, moveName) {
  const key = String(moveName).toLowerCase();
  return pokemon.items.some((i) => i.type === "move" && i.name.toLowerCase() === key);
}

/**
 * Teach a move to a Pokémon (TM/tutor/HM). Validates the learnset and enforces
 * the four-move limit, prompting which move to forget when full.
 */
export async function teachMove(pokemon, moveName, { replaceId = null, force = false } = {}) {
  if (pokemon?.type !== "pokemon") return;
  // Move Tutors teach moves outside the normal learnset, so they pass force.
  if (!force && !canLearn(pokemon, moveName)) return ui.notifications?.warn(`${pokemon.name} can't learn ${moveName}.`);
  if (knows(pokemon, moveName)) return ui.notifications?.info(`${pokemon.name} already knows ${moveName}.`);

  const moveDoc = await findMove(moveName);
  if (!moveDoc) return ui.notifications?.warn(`Move not found: ${moveName}`);

  const knownMoves = pokemon.items.filter((i) => i.type === "move");
  if (knownMoves.length >= 4) {
    let forgetId = replaceId;
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!forgetId && DialogV2) {
      const opts = knownMoves.map((m) => `<option value="${m.id}">${m.name}</option>`).join("");
      forgetId = await DialogV2.prompt({
        window: { title: `${pokemon.name} learns ${moveName}` },
        content: `<p>${pokemon.name} already knows four moves. Forget which one?</p><select name="f" style="width:100%">${opts}</select>`,
        ok: { label: "Forget & Learn", callback: (event, button) => button.form.elements.f.value }
      }).catch(() => null);
    }
    if (!forgetId) return;
    await pokemon.deleteEmbeddedDocuments("Item", [forgetId]);
  }

  await pokemon.createEmbeddedDocuments("Item", [moveDoc.toObject()]);
  await ChatMessage.create({ speaker: { alias: pokemon.name }, content: `<p>${pokemon.name} learned <strong>${moveName}</strong>!</p>` });
}

/** Dialog: pick a learnable move (not yet known) and teach it. */
export async function teachMoveDialog(pokemon) {
  const learnable = (pokemon.system.learnset ?? [])
    .map((l) => l.move)
    .filter((m, i, arr) => arr.indexOf(m) === i && !knows(pokemon, m))
    .sort();
  if (!learnable.length) return ui.notifications?.info(`${pokemon.name} has no new moves to learn.`);
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2) return teachMove(pokemon, learnable[0]);
  const opts = learnable.map((m) => `<option value="${m}">${m}</option>`).join("");
  const move = await DialogV2.prompt({
    window: { title: `Teach a move to ${pokemon.name}` },
    content: `<select name="m" style="width:100%">${opts}</select>`,
    ok: { label: "Teach", callback: (event, button) => button.form.elements.m.value }
  }).catch(() => null);
  if (move) return teachMove(pokemon, move);
}

/** Does any Pokémon in the trainer's party know the given move? */
export async function partyKnows(trainer, moveName) {
  const party = trainer.type === "trainer" ? await trainer.getParty() : [trainer];
  return party.some((p) => p?.type === "pokemon" && knows(p, moveName));
}

/* -------------------------------------------- */
/*  Field Move Gate region behavior              */
/* -------------------------------------------- */

export class FieldMoveGateBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["PM.RegionBehavior.FieldGate"];

  static defineSchema() {
    return {
      move: new fields.StringField({ required: true, blank: false, initial: "surf", choices: PM.fieldMoves }),
      announce: new fields.BooleanField({ initial: true })
    };
  }

  // Only tokenMoveIn — tokenEnter would double-fire (and trigger on placement).
  static events = {
    [EVENTS.TOKEN_MOVE_IN]: async function (event) { return FieldMoveGateBehaviorType.gate.call(this, event); }
  };

  static async gate(event) {
    const token = event?.data?.token;
    const actor = token?.actor;
    if (actor?.type !== "trainer") return;
    const moveName = PM.fieldMoves[this.move] ?? this.move;

    if (await partyKnows(actor, moveName)) {
      if (this.announce && isResponsible(token)) {
        await ChatMessage.create({ speaker: { alias: "Field" }, content: `<p>${actor.name} used <strong>${moveName}</strong> to pass.</p>` });
      }
      return;
    }

    if (!isResponsible(token)) return;
    // Bounce the token back to where it came from — a real gate. (Event shape
    // differs across v12/v13; try the known locations for the origin waypoint.)
    const origin = event.data?.origin ?? event.data?.movement?.origin;
    if (origin && Number.isFinite(origin.x)) {
      await token.update({ x: origin.x, y: origin.y, elevation: origin.elevation ?? token.elevation });
    }
    ui.notifications?.warn(`You need ${moveName} to pass here.`);
  }
}

export function registerTmApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    tms: { teach: teachMove, teachDialog: teachMoveDialog, canLearn, knows, partyKnows }
  });
}
