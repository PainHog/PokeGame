/**
 * Pokémon Masters — WASD keyboard movement.
 *
 * Foundry natively binds the arrow keys to token movement, but WASD is left
 * unbound. This registers WASD (and, by extension, complements the arrow keys)
 * so a player can walk their trainer's token one grid cell at a time.
 *
 * Keybindings MUST be registered during Foundry's `init` hook — that is the only
 * point at which `game.keybindings.register` is valid — so `registerControls()`
 * is called from the system's init hook (see `pokemon-masters.mjs`).
 */

/**
 * Step the player's token one grid cell in direction (dx, dy).
 *
 * If nothing is currently controlled, this auto-selects the current user's owned
 * trainer token on the active scene. Every controlled token the user owns is
 * moved. Returns true when at least one token moved (so the keybinding consumes
 * the key press), false otherwise (so the press falls through to other handlers).
 *
 * Wrapped so it never throws out of the keybinding handler.
 */
async function stepTokens(dx, dy) {
  try {
    if (!canvas?.ready) return false;

    let tokens = canvas.tokens?.controlled ?? [];
    if (!tokens.length) {
      // Nothing selected — grab this user's owned trainer token on this scene.
      const owned = (canvas.tokens?.placeables ?? []).filter(
        (t) => t.actor?.isOwner && t.actor?.type === "trainer"
      );
      const target = owned[0];
      if (!target) return false;
      target.control({ releaseOthers: true });
      tokens = [target];
    }

    const size = canvas.grid?.size ?? 0;
    if (!size) return false;

    let moved = false;
    for (const t of tokens) {
      if (!t.document?.isOwner) continue;
      await t.document.update({
        x: t.document.x + dx * size,
        y: t.document.y + dy * size
      });
      moved = true;
    }
    return moved;
  } catch (err) {
    console.warn("Pokémon Masters | WASD movement failed:", err);
    return false;
  }
}

/**
 * Register the four movement keybindings (KeyW/KeyS/KeyA/KeyD). Each repeats
 * while held and steps the player's token one grid cell. Call from the `init`
 * hook only.
 */
export function registerControls() {
  const dirs = [
    { id: "moveUp", key: "KeyW", label: "Up", dx: 0, dy: -1 },
    { id: "moveDown", key: "KeyS", label: "Down", dx: 0, dy: 1 },
    { id: "moveLeft", key: "KeyA", label: "Left", dx: -1, dy: 0 },
    { id: "moveRight", key: "KeyD", label: "Right", dx: 1, dy: 0 }
  ];

  for (const { id, key, label, dx, dy } of dirs) {
    game.keybindings.register("pokemon-masters", id, {
      name: `Move ${label}`,
      hint: `Walk your trainer's token one grid cell ${label.toLowerCase()}.`,
      editable: [{ key }],
      repeat: true,
      onDown: () => stepTokens(dx, dy)
    });
  }
}
