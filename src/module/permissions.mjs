/**
 * Pokémon Masters — responsible-client resolution (persistent world).
 *
 * World mutations from Region events (encounters, heals, spawns) must run on
 * exactly one client to avoid duplicates. Normally that's the active GM. But for
 * a world that keeps running when the GM is offline, this falls back to the
 * triggering token's *primary owner* (the lowest-id active owner, so exactly one
 * client acts) when no GM is connected and GM-less play is enabled.
 *
 * Note: creating Actors/Tokens still requires the Foundry permission for that —
 * enable "Create New Actors" / "Create New Tokens" for the Player role under
 * Game Settings → Configure Permissions for full GM-less play. A truly always-on
 * world can instead keep a dedicated GM account logged in (a "GM bot").
 */

export function anyGmOnline() {
  return !!game.users?.activeGM;
}

/** Among a document's active OWNERs, is this client the lowest-id one? */
function primaryOwnerIsSelf(doc) {
  const owners = (game.users?.contents ?? [])
    .filter((u) => u.active && doc?.testUserPermission?.(u, "OWNER"))
    .sort((a, b) => a.id.localeCompare(b.id));
  return owners[0]?.isSelf ?? false;
}

/**
 * Should THIS client perform the world-write for an event on `token`?
 *  - The active GM always does.
 *  - Otherwise, only if no GM is online, GM-less play is on, and this client is
 *    the token's primary owner.
 */
export function isResponsible(token = null) {
  if (game.users?.activeGM?.isSelf) return true;
  if (anyGmOnline()) return false;
  if (!game.settings.get("pokemon-masters", "gmlessPlay")) return false;
  const actor = token?.actor;
  if (!actor) return game.user?.isGM ?? false;
  return primaryOwnerIsSelf(actor);
}

export function registerSystemSettings() {
  game.settings.register("pokemon-masters", "gmlessPlay", {
    name: "Play without a GM online",
    hint: "When no Gamemaster is connected, the acting player's client resolves encounters, catches, and heals. For full offline play, also enable 'Create New Actors' and 'Create New Tokens' for the Player role under Configure Permissions.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
}
