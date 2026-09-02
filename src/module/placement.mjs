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
import { nearestWalkable } from "./regions.mjs";

const FLAG = "pokemon-masters";

/** True on the one client that should perform world-mutating placement. */
export function canPlace() {
  const gm = game.users?.activeGM;
  if (gm) return game.user === gm;
  return game.user.isGM || game.user.can("TOKEN_CREATE");
}

/** Ask the privileged client (active GM) to perform a placement this client can't. */
function requestGmPlacement(payload) {
  try { game.socket.emit("system.pokemon-masters", { action: "pmPlace", ...payload }); } catch (err) { /* no socket */ }
}

/** Pull a trainer's active owner(s) to a scene (and the GM if they're playing it). */
function viewForOwners(trainer, scene) {
  const ownerIds = (game.users?.contents ?? [])
    .filter((u) => !u.isGM && u.active && trainer.testUserPermission(u, "OWNER"))
    .map((u) => u.id);
  if (ownerIds.length) game.socket.emit("system.pokemon-masters", { action: "viewScene", sceneId: scene.id, userIds: ownerIds });
  if (game.user.character?.id === trainer.id || (!ownerIds.length && game.user.isGM)) {
    try { scene.view(); } catch (err) { /* view is best-effort */ }
  }
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
export async function placeToken(scene, actor, { x = null, y = null, linked = false, overrides = {} } = {}) {
  if (!scene || !actor) return null;
  const existing = tokenOnScene(scene, actor);
  if (existing) return existing;
  const gs = scene.grid?.size || 100;
  const px = x ?? Math.round((scene.width / 2) / gs) * gs;
  const py = y ?? Math.round((scene.height / 2) / gs) * gs;
  try {
    const td = await actor.getTokenDocument({ x: px, y: py, actorLink: linked });
    const data = foundry.utils.mergeObject(td.toObject(), overrides, { inplace: false });
    const [created] = await scene.createEmbeddedDocuments("Token", [data]);
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
  if (!trainer) return;
  // A player who chose a starter can't create scenes/tokens — ask the GM to.
  if (!canPlace()) { requestGmPlacement({ kind: "spawn", uuid: trainer.uuid, region }); return; }
  const townName = PM.startTowns?.[region] ?? "Pallet Town";
  const scene = await ensureScene(townName);
  if (!scene) return;
  // Clear any existing token (e.g. left on the default start map) so relocating to
  // the chosen region doesn't leave a duplicate behind.
  for (const s of game.scenes ?? []) {
    if (s.id === scene.id) continue;
    const strays = s.tokens.filter((t) => t.actorId === trainer.id).map((t) => t.id);
    if (strays.length) await s.deleteEmbeddedDocuments("Token", strays).catch(() => {});
  }
  await placeToken(scene, trainer, { linked: true });
  await trainer.setFlag(FLAG, "spawned", true);
  // Pull the trainer's owner(s) to their new home town.
  viewForOwners(trainer, scene);
  await ChatMessage.create({
    speaker: { alias: "World" },
    content: `<div class="pm-encounter-card"><p>🧭 <strong>${trainer.name}</strong> arrived in ${townName}. Your adventure begins!</p></div>`
  });
}

/**
 * Send a Pokémon out onto the current scene (next to its trainer's token), or
 * recall it if it's already out. Returns "sent" | "recalled" | null.
 */
export async function sendOut(pokemon, { sceneId = null } = {}) {
  if (pokemon?.type !== "pokemon") return null;
  const scene = sceneId ? game.scenes?.get(sceneId) : canvas?.scene;
  if (!scene) return null;
  if (!canPlace()) {
    requestGmPlacement({ kind: "sendOut", uuid: pokemon.uuid, sceneId: scene.id });
    ui.notifications?.info(`Sending out ${pokemon.name}…`);
    return null;
  }
  if (tokenOnScene(scene, pokemon)) { await removeToken(scene, pokemon); return "recalled"; }
  const trainer = pokemon.system.trainer ? await fromUuid(pokemon.system.trainer) : null;
  const tt = trainer ? scene.tokens.find((t) => t.actorId === trainer.id) : null;
  const gs = scene.grid?.size || 100;
  const pos = tt ? { x: tt.x + gs, y: tt.y } : {};
  await placeToken(scene, pokemon, pos);
  return "sent";
}

/**
 * On world load, bring this client to the scene holding their own trainer's
 * token and pan to its exact position — so a player resumes right where they
 * left off instead of on the default scene. Fail-soft: a brand-new player with
 * no token yet (or a GM with no trainer) is simply left where they are.
 */
export async function pullToMyToken() {
  try {
    const isNpc = (a) => a.getFlag(FLAG, "isNpc");
    const actor = (game.user.character?.type === "trainer" && !isNpc(game.user.character))
      ? game.user.character
      : (game.actors ?? []).find((a) => a.type === "trainer" && a.isOwner && !isNpc(a));
    if (!actor) return;
    // Find the scene that currently holds this trainer's token (their last spot).
    let scene = null, tok = null;
    for (const s of game.scenes ?? []) {
      const t = s.tokens.find((td) => td.actorId === actor.id);
      if (t) { scene = s; tok = t; break; }
    }
    if (!scene || !tok) return;
    // If a re-synced map shrank and left this token outside the new bounds (or on a
    // wall), snap just this one token back onto a walkable tile — a single, guarded
    // write, so it can't spam the stale-id errors a bulk sweep produced.
    if (canPlace() && scene.tokens.get(tok.id)) {
      const spot = nearestWalkable(scene, tok.x, tok.y);
      if (spot.x !== tok.x || spot.y !== tok.y) {
        await tok.update({ x: spot.x, y: spot.y }, { pmSync: true, animate: false }).catch(() => {});
      }
    }
    if (canvas?.scene?.id !== scene.id) await scene.view();
    const gs = scene.grid?.size || 100;
    await canvas?.animatePan?.({ x: tok.x + gs / 2, y: tok.y + gs / 2, scale: canvas.stage?.scale?.x ?? 1, duration: 250 });
  } catch (err) { console.warn("Pokémon Masters | could not pull to last token", err); }
}

export function registerPlacementApi() {
  // Resume each client at their trainer's last position once the world is ready.
  Hooks.once("ready", () => { pullToMyToken(); });
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    placement: { ensureScene, placeToken, removeToken, spawnTrainerAt, sendOut, canPlace, pullToMyToken }
  });
  // The active GM performs placements requested by players (who can't create
  // scenes/tokens themselves). Every client hears the socket; only the GM acts.
  game.socket.on("system.pokemon-masters", async (data) => {
    if (data?.action !== "pmPlace" || !canPlace()) return;
    try {
      const doc = await fromUuid(data.uuid);
      if (!doc) return;
      if (data.kind === "spawn") await spawnTrainerAt(doc, data.region);
      else if (data.kind === "sendOut") await sendOut(doc, { sceneId: data.sceneId });
    } catch (err) { console.warn("Pokémon Masters | GM placement request failed", err); }
  });
  // Choosing a starter is a deliberate "begin your journey in <region>" — always
  // (re)home the trainer to that region's start town, even if they were already
  // placed on the default map, so a non-Kanto pick actually ports them there.
  Hooks.on("pmStarterChosen", ({ trainer, region }) => {
    if (trainer) spawnTrainerAt(trainer, region);
  });
  // A fainted Pokémon is recalled from the field automatically.
  Hooks.on("pmPokemonFainted", ({ target }) => {
    if (target?.type === "pokemon" && canPlace() && canvas?.scene) removeToken(canvas.scene, target);
  });
}
