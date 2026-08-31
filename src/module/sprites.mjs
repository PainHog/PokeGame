/**
 * Pokémon Masters — overworld token sprites (directional walking).
 *
 * Makes tokens look like walking characters instead of a static portrait: as a
 * token moves, its texture swaps to the sprite that faces the movement
 * direction (down/up/left/right). Point each direction at an animated file
 * (.webm/.gif) and Foundry plays the walk cycle natively.
 *
 * Sprites are stored on the actor as a flag:
 *   actor.flags["pokemon-masters"].sprites = { down, up, left, right }
 * (any subset; missing directions keep the current texture). Set them with
 * `game.pokemonMasters.sprites.set(actor, {down, up, left, right})`.
 *
 * The swap is injected into the *same* movement update (preUpdateToken), so
 * there's no extra database write and no animation flicker.
 */

const FLAG_SCOPE = "pokemon-masters";
const FLAG_KEY = "sprites";

/** Facing from a movement delta (favor the larger axis). */
export function facingFromDelta(dx, dy) {
  if (!dx && !dy) return null;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
}

/** Assign a directional sprite set to an actor (and face "down" while idle). */
export async function setOverworldSprites(actor, sprites = {}) {
  if (!actor) return;
  await actor.setFlag(FLAG_SCOPE, FLAG_KEY, sprites);
  const idle = sprites.down ?? sprites.up ?? sprites.left ?? sprites.right;
  if (idle) {
    await actor.update({ "prototypeToken.texture.src": idle });
    // Update any existing tokens of this actor on the current scene, too.
    for (const token of actor.getActiveTokens()) {
      await token.document.update({ "texture.src": idle });
    }
  }
  ui.notifications?.info(`${actor.name}: overworld sprites set.`);
}

// Facing to apply after a move completes, keyed by token id. We compute the
// direction in preUpdateToken (where the OLD position is still available) but
// apply the texture as a SEPARATE post-move update — v14's movement pipeline can
// drop a texture change bundled into the move operation itself.
const pendingFacing = new Map();

function onPreUpdateToken(tokenDoc, change) {
  try {
    if (!game.settings.get(FLAG_SCOPE, "overworldSprites")) return;
    if (change.x === undefined && change.y === undefined) return;
    const sprites = tokenDoc.actor?.getFlag(FLAG_SCOPE, FLAG_KEY);
    if (!sprites) return;
    const dx = (change.x ?? tokenDoc.x) - tokenDoc.x;
    const dy = (change.y ?? tokenDoc.y) - tokenDoc.y;
    const dir = facingFromDelta(dx, dy);
    if (dir && sprites[dir]) pendingFacing.set(tokenDoc.id, sprites[dir]);
  } catch (err) {
    console.warn("Pokémon Masters | overworld sprite facing failed", err);
  }
}

function onUpdateToken(tokenDoc, change, options, userId) {
  try {
    if (userId !== game.user.id) return;                 // only the mover applies it
    const src = pendingFacing.get(tokenDoc.id);
    if (src === undefined) return;
    pendingFacing.delete(tokenDoc.id);
    if (tokenDoc.texture?.src !== src && tokenDoc.isOwner) tokenDoc.update({ "texture.src": src }, { animate: false });
  } catch (err) {
    console.warn("Pokémon Masters | overworld sprite swap failed", err);
  }
}

export function registerSpriteSystem() {
  game.settings.register(FLAG_SCOPE, "overworldSprites", {
    name: "Directional overworld sprites",
    hint: "When a token moves, face its sprite in the direction of travel (needs per-actor directional sprites; animated .webm/.gif files loop automatically).",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  Hooks.on("preUpdateToken", onPreUpdateToken);
  Hooks.on("updateToken", onUpdateToken);

  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    sprites: { set: setOverworldSprites, facingFromDelta }
  });
}
