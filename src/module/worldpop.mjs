/**
 * Pokémon Masters — world population.
 *
 * Puts actual, visible NPC actors on the maps at their proper spots and makes
 * them interactive:
 *   - Nurse Joy stands at the Pokémon Center (double-click → heal / PC / chat)
 *   - Officer Jenny stands at the Police Station (double-click → report a crime)
 *   - a Mart Clerk stands at the Poké Mart (double-click → open the shop)
 *   - a handful of flavour townsfolk & route trainers wander each map so the
 *     world feels lived-in (double-click → a themed line)
 *
 * Runs on the one privileged client (active GM, or the acting owner in a GM-less
 * world). New scenes are populated as they're imported (createScene); already
 * imported scenes are populated once by a versioned migration on world load.
 * Idempotent — re-running never duplicates tokens.
 */

import { PM } from "./config.mjs";
import { placeToken, canPlace } from "./placement.mjs";

const FLAG = "pokemon-masters";
const POP_VERSION = 1;

const cache = new Map(); // actor name -> Actor

/** A short line each flavour NPC says when spoken to. */
const FLAVOR = {
  oldman: "Back in my day, we'd weaken a wild Pokémon first, then throw the ball. Patience catches them all!",
  youth: "I like shorts! They're comfy and easy to wear! …Wanna see my Pokémon sometime?",
  lass: "Hi! Are you filling out your Pokédex too? Good luck out there!",
  bug: "I caught this one in the tall grass. Bug Pokémon are underrated, you know!",
  beauty: "A great trainer always keeps their Pokémon healthy and happy.",
  gentleman: "A fine day for a stroll. Do mind the tall grass, young trainer.",
  fisher: "Shh… they're biting today. Grab a rod and try your luck by the water.",
  hiker: "I've hiked every route 'round here. Rock Pokémon love the mountains!",
};

/* -------------------------------------------- */
/*  NPC actors                                   */
/* -------------------------------------------- */

async function npcFolder() {
  let f = game.folders?.find((x) => x.type === "Actor" && x.name === "NPCs" && !x.folder);
  if (!f) f = await Folder.create({ name: "NPCs", type: "Actor", color: "#6a5acd" });
  return f;
}

/** Find-or-create a shared NPC actor by name (cached; one per world). */
async function ensureNpc(name, { role = null, flavor = null } = {}) {
  if (cache.has(name)) return cache.get(name);
  let actor = game.actors?.find((a) => a.type === "trainer" && a.name === name && a.getFlag(FLAG, "isNpc"));
  if (!actor) {
    const folder = await npcFolder();
    const img = PM.npcSpriteFor(name);
    actor = await Actor.create({
      name, type: "trainer", img, folder: folder.id,
      prototypeToken: {
        name, texture: { src: img }, actorLink: false,
        disposition: role ? 1 : 0, displayName: 20, width: 1, height: 1, lockRotation: true,
      },
      flags: { [FLAG]: { isNpc: true, npcRole: role ?? null, npcFlavor: flavor ?? null } },
    });
  }
  cache.set(name, actor);
  return actor;
}

/* -------------------------------------------- */
/*  Placement                                    */
/* -------------------------------------------- */

/** Grid-snapped top-left for a 1×1 token centred on (px,py). */
function snap(scene, px, py) {
  const gs = scene.grid?.size || 100;
  return { x: Math.round((px - gs / 2) / gs) * gs, y: Math.round((py - gs / 2) / gs) * gs };
}

async function placeNpc(scene, name, opts, px, py) {
  const actor = await ensureNpc(name, opts);
  const { x, y } = snap(scene, px, py);
  return placeToken(scene, actor, {
    x, y,
    overrides: { flags: { [FLAG]: { isNpc: true, npcRole: opts.role ?? null, npcFlavor: opts.flavor ?? null } } },
  });
}

/** Town flavour residents (varied gender), placed away from the buildings. */
const TOWNSFOLK = [["Old Man", "oldman"], ["Youngster", "youth"], ["Lass", "lass"], ["Beauty", "beauty"], ["Gentleman", "gentleman"]];
/** Route flavour trainers. */
const ROUTEFOLK = [["Bug Catcher", "bug"], ["Youngster", "youth"], ["Fisherman", "fisher"], ["Hiker", "hiker"]];

/**
 * Populate one scene with its NPCs. Detects a town (has a Poké Center region)
 * or a route (has a Wild Area region); indoor venues get none. No-op if already
 * populated or if this client may not place.
 */
export async function populateScene(scene) {
  if (!scene || !canPlace()) return;
  if (scene.getFlag(FLAG, "populated")) return;
  const w = scene.width, h = scene.height, cx = w / 2, cy = h / 2;
  const isTown = !!scene.regions?.find((r) => r.name === "Poké Center");
  const isRoute = !!scene.regions?.find((r) => r.name === "Wild Area");
  try {
    if (isTown) {
      // Service NPCs stand at the doors of their buildings (Center / Mart / Police).
      await placeNpc(scene, "Nurse Joy", { role: "nurse" }, cx - 400, cy + 120);
      await placeNpc(scene, "Mart Clerk", { role: "clerk" }, cx, cy + 120);
      await placeNpc(scene, "Officer Jenny", { role: "officer" }, cx + 320, cy + 120);
      // Flavour residents scattered around the town.
      const spots = [[w * 0.20, h * 0.28], [w * 0.80, h * 0.30], [w * 0.24, h * 0.74], [w * 0.76, h * 0.72], [w * 0.5, h * 0.82]];
      for (let i = 0; i < TOWNSFOLK.length; i++) {
        const [name, flavor] = TOWNSFOLK[i];
        await placeNpc(scene, name, { flavor }, spots[i][0], spots[i][1]);
      }
    } else if (isRoute) {
      const spots = [[w * 0.30, h * 0.45], [w * 0.62, h * 0.55], [w * 0.45, h * 0.68]];
      for (let i = 0; i < spots.length; i++) {
        const [name, flavor] = ROUTEFOLK[i % ROUTEFOLK.length];
        await placeNpc(scene, name, { flavor }, spots[i][0], spots[i][1]);
      }
    }
    await scene.setFlag(FLAG, "populated", true);
  } catch (err) {
    console.warn("Pokémon Masters | could not populate scene", scene?.name, err);
  }
}

/* -------------------------------------------- */
/*  Interaction (double-click an NPC)            */
/* -------------------------------------------- */

/** The clicking player's own (non-NPC) trainer, if any. */
function playerTrainer() {
  const c = game.user?.character;
  if (c?.type === "trainer" && !c.getFlag(FLAG, "isNpc")) return c;
  return game.actors?.find((a) => a.type === "trainer" && a.isOwner && !a.getFlag(FLAG, "isNpc")) ?? null;
}

/** Run an NPC token's interaction. */
export async function interactNpc(doc) {
  const pm = game.pokemonMasters ?? {};
  const role = doc?.getFlag?.(FLAG, "npcRole");
  if (role === "nurse") return pm.services?.nurseJoy?.();
  if (role === "officer") return pm.services?.officerJenny?.();
  if (role === "clerk") {
    const t = playerTrainer();
    return t ? pm.shop?.open?.(t) : ui.notifications?.warn("Assign your Trainer to shop here.");
  }
  const line = FLAVOR[doc?.getFlag?.(FLAG, "npcFlavor")] ?? "Hello there, trainer!";
  return ChatMessage.create({ speaker: { alias: doc?.name ?? "NPC" }, content: `<div class="pm-encounter-card"><p>${line}</p></div>` });
}

/** Make double-clicking an NPC token run its interaction instead of a sheet. */
function installNpcClick() {
  const cls = CONFIG.Token?.objectClass;
  if (!cls || cls.prototype.__pmNpcClick) return;
  const orig = cls.prototype._onClickLeft2;
  cls.prototype._onClickLeft2 = function (event) {
    try {
      const f = this.document?.flags?.[FLAG];
      if (f?.isNpc || f?.npcRole || f?.npcFlavor) { interactNpc(this.document); return; }
    } catch (err) { /* fall through to default */ }
    return orig?.call(this, event);
  };
  cls.prototype.__pmNpcClick = true;
}

/* -------------------------------------------- */
/*  Registration & migration                     */
/* -------------------------------------------- */

/** Re-populate every scene from scratch (a manual GM redo). */
export async function repopulateWorld() {
  if (!canPlace()) return ui.notifications?.warn("Only the GM can populate the world.");
  for (const scene of game.scenes ?? []) {
    await scene.unsetFlag(FLAG, "populated").catch(() => {});
    await populateScene(scene);
  }
  ui.notifications?.info("Pokémon Masters: world NPCs refreshed.");
}

export function registerWorldPop() {
  game.settings.register(FLAG, "worldPopVersion", { scope: "world", config: false, type: Number, default: 0 });
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    world: { populateScene, interactNpc, repopulate: repopulateWorld },
  });

  // Populate a scene the moment it's imported into the world.
  Hooks.on("createScene", (scene) => { if (canPlace()) populateScene(scene); });

  // One-time migration for already-imported scenes + install the click handler.
  Hooks.once("ready", async () => {
    installNpcClick();
    if (!canPlace()) return;
    try {
      if ((game.settings.get(FLAG, "worldPopVersion") ?? 0) >= POP_VERSION) return;
      for (const scene of game.scenes ?? []) await populateScene(scene);
      await game.settings.set(FLAG, "worldPopVersion", POP_VERSION);
    } catch (err) {
      console.warn("Pokémon Masters | world population migration failed", err);
    }
  });
}
