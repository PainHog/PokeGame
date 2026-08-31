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
    hint: "When no Gamemaster is connected, the acting player's client resolves encounters, catches, and heals. Players are auto-granted the Create-Actor/Token permissions they need, so the game is fully self-service.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
}

/**
 * Make the world self-service so NOTHING routine needs a Gamemaster: grant the
 * Player role the Foundry permissions the game relies on — creating their own
 * caught/starter Pokémon (ACTOR_CREATE) and placing their own tokens
 * (TOKEN_CREATE / TOKEN_CONFIGURE). Only a GM can write the core permission
 * config, so this applies once, automatically, on whichever GM client first
 * loads the world (its creator). After that every player plays with equal rules
 * and no per-action approval. Additive and idempotent — it never removes a grant
 * a world already has, and it preserves the default roles for each permission.
 */
export async function ensurePlayerAutonomy() {
  try {
    if (!game.user?.isGM) return;
    const ROLES = CONST.USER_ROLES;
    const PLAYER = ROLES.PLAYER;
    // NB: folder creation is NOT a Foundry permission — never add "FOLDER_CREATE"
    // here (an unknown key can make the whole core.permissions write invalid).
    const NEED = ["ACTOR_CREATE", "TOKEN_CREATE", "TOKEN_CONFIGURE"];
    const rolesAtLeast = (min) => [PLAYER, ROLES.TRUSTED, ROLES.ASSISTANT, ROLES.GAMEMASTER].filter((r) => r >= min);
    const stored = game.settings.get("core", "permissions") ?? {};
    const perms = foundry.utils.deepClone(stored);
    let changed = false;
    for (const key of NEED) {
      // Keep whatever the world already grants; if it's never been configured,
      // seed with this permission's default roles so higher roles aren't dropped.
      const def = CONST.USER_PERMISSIONS?.[key]?.defaultRole ?? ROLES.ASSISTANT;
      const current = Array.isArray(perms[key]) ? perms[key] : rolesAtLeast(def);
      if (!current.includes(PLAYER)) { perms[key] = [...new Set([...current, PLAYER])]; changed = true; }
      else perms[key] = current;
    }
    if (changed) {
      await game.settings.set("core", "permissions", perms);
      console.log("Pokémon Masters | Granted the Player role Create-Actor/Token permissions — the game is now fully GM-less.");
    }
  } catch (err) {
    console.warn("Pokémon Masters | could not auto-grant player permissions (enable Create New Actors/Tokens for the Player role under Configure Permissions):", err);
  }
}
