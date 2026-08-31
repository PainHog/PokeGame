/**
 * Pokémon Masters — token placement on scenes.
 *
 * Shared plumbing for putting Actors onto maps as Tokens: auto-spawning a new
 * trainer on their home town, standing a Pokémon on the battle field, and
 * showing day-care Pokémon in their pen. Scene creation and token creation are
 * privileged, so these run on the active GM's client (or, in a GM-less world,
 * the acting owner) and fail soft otherwise.
 */

import { PM } from "./config.mjs";

const FLAG = "pokemon-masters";

/** True on the one client that should perform world-mutating placement. */
export function canPlace() {
  const gm = game.users?.activeGM;
  if (gm) return game.user === gm;
  return game.user.isGM || game.user.can("TOKEN_CREATE");
}

/** Find a world Scene by name, importing it from the compendium if needed. */
export async function ensureScene(name) {
  let scene = game.scenes?.getName(name);
  if (scene) return scene;
  const pack = game.packs.get("pokemon-masters.scenes");
  const entry = pack?.index?.find((e) => e.name === name);
  if (!entry) return null;
  try {
    return await game.scenes.importFromCompendium(pack, entry._id, {}, { keepId: false });
  } catch (err) {
    console.warn("Pokémon Masters | could not import scene", name, err);
    return null;
  }
}

/** Does this actor already have a token on the scene? */
export function tokenOnScene(scene, actor) {
  return scene?.tokens?.find((t) => t.actorId === actor.id) ?? null;
}

/**
 * Place an Actor's token on a scene at (x,y) in pixels (defaults to centre).
 * No-op if a token for the actor is already there. Returns the TokenDocument.
 */
export async function placeToken(scene, actor, { x = null, y = null, linked = false } = {}) {
  if (!scene || !actor) return null;
  const existing = tokenOnScene(scene, actor);
  if (existing) return existing;
  const gs = scene.grid?.size || 100;
  const px = x ?? Math.round((scene.width / 2) / gs) * gs;
  const py = y ?? Math.round((scene.height / 2) / gs) * gs;
  try {
    const td = await actor.getTokenDocument({ x: px, y: py, actorLink: linked });
    const [created] = await scene.createEmbeddedDocuments("Token", [td.toObject()]);
    return created;
  } catch (err) {
    console.warn("Pokémon Masters | could not place token for", actor.name, err);
    return null;
  }
}

/** Remove all of an actor's tokens from a scene. */
export async function removeToken(scene, actor) {
  if (!scene || !actor) return;
  const ids = scene.tokens.filter((t) => t.actorId === actor.id).map((t) => t.id);
  if (ids.length) await scene.deleteEmbeddedDocuments("Token", ids).catch(() => {});
}

/**
 * Spawn a trainer on their region's starting town: import the scene, drop the
 * trainer's (linked) token there, and pull them to it. Runs only on the client
 * allowed to place; a player choosing a starter has the GM client do it.
 */
export async function spawnTrainerAt(trainer, region) {
  if (!trainer || !canPlace()) return;
  const townName = PM.startTowns?.[region] ?? "Pallet Town";
  const scene = await ensureScene(townName);
  if (!scene) return;
  await placeToken(scene, trainer, { linked: true });
  await trainer.setFlag(FLAG, "spawned", true);
  // Show the scene to whoever is at the keyboard.
  try { scene.view(); } catch (err) { /* view is best-effort */ }
  await ChatMessage.create({
    speaker: { alias: "World" },
    content: `<div class="pm-encounter-card"><p>🧭 <strong>${trainer.name}</strong> arrived in ${townName}. Your adventure begins!</p></div>`
  });
}

export function registerPlacementApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    placement: { ensureScene, placeToken, removeToken, spawnTrainerAt, canPlace }
  });
  // When a trainer receives their starter, the GM client spawns them on the map.
  Hooks.on("pmStarterChosen", ({ trainer, region }) => {
    if (trainer && !trainer.getFlag(FLAG, "spawned")) spawnTrainerAt(trainer, region);
  });
}
