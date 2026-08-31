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

/** Token/actor flags for an NPC, from its placement options. */
function npcFlags(opts = {}) {
  return {
    isNpc: true,
    npcRole: opts.role ?? null,
    npcFlavor: opts.flavor ?? null,
    npcGymRegion: opts.gymRegion ?? null,
    npcGymIndex: opts.gymIndex ?? null,
  };
}

/** Find-or-create a shared NPC actor by name (cached; one per world). */
async function ensureNpc(name, opts = {}) {
  if (cache.has(name)) return cache.get(name);
  let actor = game.actors?.find((a) => a.type === "trainer" && a.name === name && a.getFlag(FLAG, "isNpc"));
  if (!actor) {
    const folder = await npcFolder();
    const img = PM.npcSpriteFor(name);
    actor = await Actor.create({
      name, type: "trainer", img, folder: folder.id,
      prototypeToken: {
        name, texture: { src: img }, actorLink: false,
        disposition: opts.role ? 1 : 0, displayName: 20, width: 1, height: 1, lockRotation: true,
      },
      flags: { [FLAG]: npcFlags(opts) },
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
  return placeToken(scene, actor, { x, y, overrides: { flags: { [FLAG]: npcFlags(opts) } } });
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
      // Gym cities: stand the leader at the gym door, clickable to battle.
      const gymRegion = scene.regions?.find((r) => r.name === "Gym");
      const gymBeh = gymRegion?.behaviors?.find((b) => b.type === "pokemon-masters.safeZone");
      const gsys = gymBeh?.system ?? {};
      if (gsys.leader) {
        await placeNpc(scene, gsys.leader, { role: "gym", gymRegion: gsys.gymRegion, gymIndex: gsys.gymIndex }, cx + 620, cy + 120);
      }
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
  if (role === "gym") {
    const t = playerTrainer();
    if (!t) return ui.notifications?.warn("Assign your Trainer to challenge the Gym.");
    const region = doc.getFlag(FLAG, "npcGymRegion") || undefined;
    const idx = doc.getFlag(FLAG, "npcGymIndex");
    return pm.league?.gymChallenge?.(t, region, idx ?? undefined);
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

/**
 * One-click world refresh for the GM after a system update. NON-destructive: it
 * refreshes each already-imported map from the compendium (lighting/vision,
 * background art) and adds any regions the new build introduced (Gym, Police),
 * then (re)places every world NPC. Existing tokens are kept.
 */
export async function rebuildWorld() {
  if (!canPlace()) return ui.notifications?.warn("Only the GM can rebuild the world.");
  const DialogV2 = foundry.applications?.api?.DialogV2;
  const pack = game.packs.get("pokemon-masters.scenes");
  if (!pack) return ui.notifications?.warn("Pokémon Masters scene compendium not found.");
  await pack.getIndex();
  const names = new Set(pack.index.map((e) => e.name));
  const worldScenes = (game.scenes ?? []).filter((s) => names.has(s.name));

  if (DialogV2) {
    const ok = await DialogV2.confirm({
      window: { title: "Rebuild Pokémon World" },
      content: `<p>Refresh <strong>${worldScenes.length}</strong> imported map(s) from the compendium — updated map art &amp; lighting, plus any new buildings (Gym, Police) &amp; regions — then (re)place all world NPCs.</p><p>Your existing tokens are kept. Continue?</p>`,
    }).catch(() => false);
    if (!ok) return;
  }

  let refreshed = 0, regionsAdded = 0;
  for (const s of worldScenes) {
    try {
      const entry = pack.index.find((e) => e.name === s.name);
      const o = (await pack.getDocument(entry._id)).toObject();
      await s.update({
        backgroundColor: o.backgroundColor, tokenVision: o.tokenVision, globalLight: o.globalLight,
        fog: o.fog, environment: o.environment, "background.src": o.background?.src,
      });
      const have = new Set(s.regions.map((r) => r.name));
      const toAdd = o.regions.filter((r) => !have.has(r.name)).map((r) => {
        const c = foundry.utils.deepClone(r); delete c._id; delete c._key;
        (c.behaviors ?? []).forEach((b) => { delete b._id; delete b._key; });
        return c;
      });
      if (toAdd.length) { await s.createEmbeddedDocuments("Region", toAdd); regionsAdded += toAdd.length; }
      refreshed++;
    } catch (err) {
      console.warn("Pokémon Masters | rebuild: could not refresh", s?.name, err);
    }
  }

  await game.settings.set(FLAG, "worldPopVersion", 0).catch(() => {});
  for (const scene of game.scenes ?? []) {
    await scene.unsetFlag(FLAG, "populated").catch(() => {});
    await populateScene(scene);
  }
  ui.notifications?.info(`Pokémon Masters: refreshed ${refreshed} map(s), added ${regionsAdded} new region(s), repopulated NPCs.`);
}

/** Ensure a clickable "Rebuild Pokémon World" macro exists for the GM. */
async function ensureRebuildMacro() {
  if (!game.user?.isGM) return;
  const name = "Rebuild Pokémon World";
  if (game.macros?.getName?.(name)) return;
  await Macro.create({
    name, type: "script", img: "icons/svg/regen.svg", scope: "global",
    command: "game.pokemonMasters?.world?.rebuild?.();",
  }).catch(() => {});
}

export function registerWorldPop() {
  game.settings.register(FLAG, "worldPopVersion", { scope: "world", config: false, type: Number, default: 0 });
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    world: { populateScene, interactNpc, repopulate: repopulateWorld, rebuild: rebuildWorld },
  });

  // Populate a scene the moment it's imported into the world.
  Hooks.on("createScene", (scene) => { if (canPlace()) populateScene(scene); });

  // One-time migration for already-imported scenes + install the click handler.
  Hooks.once("ready", async () => {
    installNpcClick();
    if (!canPlace()) return;
    await ensureRebuildMacro();
    try {
      if ((game.settings.get(FLAG, "worldPopVersion") ?? 0) >= POP_VERSION) return;
      for (const scene of game.scenes ?? []) await populateScene(scene);
      await game.settings.set(FLAG, "worldPopVersion", POP_VERSION);
    } catch (err) {
      console.warn("Pokémon Masters | world population migration failed", err);
    }
  });
}
