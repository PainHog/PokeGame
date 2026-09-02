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
import { placeToken, canPlace, ensureScene } from "./placement.mjs";
import { nearestWalkable } from "./regions.mjs";

const FLAG = "pokemon-masters";
const POP_VERSION = 2;
// Bump to force every world scene to re-sync its geometry/regions/flags with the
// current compendium on next load (fixes worlds imported from an older pack).
const SCENE_SYNC_VERSION = 1;

const cache = new Map(); // actor name -> Actor

/**
 * What each flavour NPC can say when spoken to — several lines per persona (many
 * lifted straight from the games) so the world doesn't feel like it has one line.
 * A random line is chosen each time an NPC is spoken to.
 */
const FLAVOR = {
  oldman: [
    "Back in my day, we'd weaken a wild Pokémon first, then throw the ball. Patience catches them all!",
    "When I was young, I could walk for days without a single Pokémon fainting!",
    "Ho ho! Slow down, youngster. Even a Slowpoke gets there in the end.",
  ],
  youth: [
    "I like shorts! They're comfy and easy to wear!",
    "I've got a REALLY strong Pokémon. Wanna see it? …Maybe later.",
    "When I'm a big trainer, I'll have a Pokémon for every type!",
  ],
  lass: [
    "Hi! Are you filling out your Pokédex too? Good luck out there!",
    "I want a cute Pokémon. Do you think Clefairy would like me?",
    "Eeek! A wild Pokémon! …Oh. False alarm. Phew.",
  ],
  bug: [
    "I caught this one in the tall grass. Bug Pokémon are underrated, you know!",
    "A true Bug Catcher is never without a net!",
    "Weedle, Caterpie, Wurmple — I love them all!",
  ],
  beauty: [
    "A great trainer always keeps their Pokémon healthy and happy.",
    "Beauty and strength — my Pokémon have both.",
    "Do you like my Pokémon? I raised them with the greatest care.",
  ],
  gentleman: [
    "A fine day for a stroll. Do mind the tall grass, young trainer.",
    "Splendid weather for a Pokémon battle, wouldn't you say?",
    "In my day, we dressed properly to challenge a Gym!",
  ],
  fisher: [
    "Shh… they're biting today. Grab a rod and try your luck by the water.",
    "I've been fishing this spot for years. Magikarp, mostly. Ha!",
    "A patient angler always reels in a big one… eventually.",
  ],
  hiker: [
    "I've hiked every route 'round here. Rock Pokémon love the mountains!",
    "My legs are my strongest Pokémon! HA!",
    "Mind the ledges — you can hop down, but you can't climb back up.",
  ],
  resident: [
    "Welcome! Make yourself at home.",
    "There's no place like home… except maybe a Pokémon Center!",
    "You can heal your whole team for free at the Center. Wonderful, isn't it?",
    "My family's all out training. Off adventuring again, I see!",
  ],
  schoolkid: [
    "Type match-ups are everything! Water douses Fire, remember?",
    "I studied all night for the Trainer exam!",
    "A super-effective hit does double damage. Write that down!",
  ],
};
/** A random line from a persona (accepts an old single-string persona too). */
function pickLine(persona) {
  const v = FLAVOR[persona];
  if (Array.isArray(v)) return v[Math.floor(Math.random() * v.length)];
  return v ?? "Hello there, trainer! Off on an adventure?";
}
/** Signature lines for named Gym Leaders (from the games) — shown on challenge. */
const LEADER_QUOTES = {
  Brock: "I'm Brock! Pewter City's Gym Leader! My rock-hard willpower is evident even in my Pokémon.",
  Misty: "My policy is an all-out offensive with Water-type Pokémon! Come on!",
  "Lt. Surge": "Hey, kid! You won't last long in a real battle with me — I'm a lightning American!",
  Erika: "Hello… Lovely weather, isn't it? …Oh my! I dozed off. Very well, let us battle.",
  Koga: "Fwahaha! A mere child dares to challenge me? Feel the fear of poison!",
  Sabrina: "I had a vision of your arrival. I've had the power of prophecy since I was a child.",
  Blaine: "Hah! I'm Blaine! My Pokémon are red hot! If you can't take the heat, get out!",
  Giovanni: "I must say, I'm impressed you got here. But this is as far as you go.",
  Falkner: "I'm Falkner! I'll show you the real power of the magnificent bird Pokémon!",
  Bugsy: "I'm Bugsy! I never lose when it comes to bug Pokémon!",
  Whitney: "Hi! I'm Whitney! Everyone was into Pokémon, so I got into it too. Isn't it great?",
  Morty: "I'm the Gym Leader, Morty. I can see what others cannot… including your defeat.",
  Chuck: "WATAAH! I am Chuck, and I trained on this mountain! Prepare yourself!",
  Jasmine: "…Um… I'm Jasmine. Thank you for the Lighthouse. Now… let's battle.",
  Pryce: "I am Pryce, the winter trainer. There is much to learn from Ice-type Pokémon.",
  Clair: "I am Clair. The world's best dragon master! You dare challenge me?",
  Cynthia: "I'm Cynthia. My Pokémon and I share a bond nothing can break. Let's begin!",
  Steven: "I'm interested in rare stones… and in strong trainers. Show me your resolve.",
  Leon: "My time as Champion is going to continue for a long time! Let's have a battle to remember!",
  Nessa: "I'm the strongest there is with Water types. Sorry, but I won't be holding back!",
  Raihan: "I'm Raihan — the Dragon-type Leader, and the greatest Gym Leader in Galar!",
  Iono: "Heya, everyone! It's your favorite streamer, Iono! Are you my next challenger?",
  Larry: "…Name's Larry. Just an ordinary company man. My specialty? Normal types, naturally.",
};
const GENERIC_LEADER = "As a Gym Leader, I'll test your skill! Show me what you and your Pokémon can do!";

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
      // Observer (not Owner) so every player can see & double-click the NPC to
      // interact — but NPCs are never mistaken for a player's own trainer.
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
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
/** Service NPCs (Nurse Joy, clerk, Officer Jenny, gym leader) live INSIDE their
 *  buildings — never on the outdoor map. Remove any that leaked onto an overworld
 *  scene (e.g. from an older version that placed them at the door). */
async function stripOverworldServiceNpcs(scene) {
  const isInterior = !!scene.regions?.find((r) => r.name === "Counter");
  if (isInterior) return;
  const strays = (scene.tokens ?? []).filter((t) => {
    const role = t.getFlag?.(FLAG, "npcRole");
    return role && role !== "resident";        // nurse / clerk / officer / gym
  }).map((t) => t.id);
  if (strays.length) await scene.deleteEmbeddedDocuments("Token", strays).catch(() => {});
}

export async function populateScene(scene) {
  if (!scene || !canPlace()) return;
  await stripOverworldServiceNpcs(scene);      // clean strays even on already-populated scenes
  if (scene.getFlag(FLAG, "populated")) return;
  const w = scene.width, h = scene.height, cx = w / 2, cy = h / 2;
  const counter = scene.regions?.find((r) => r.name === "Counter"); // a building interior
  const isTown = !counter && !!scene.regions?.find((r) => r.name === "Poké Center");
  const isRoute = !!scene.regions?.find((r) => r.name === "Wild Area");
  try {
    if (counter) {
      // Building interior — the service NPC stands behind the counter.
      const sys = counter.behaviors?.find((b) => b.type === "safeZone")?.system ?? {};
      const nx = w / 2, ny = 175;
      if (sys.kind === "center") await placeNpc(scene, "Nurse Joy", { role: "nurse" }, nx, ny);
      else if (sys.kind === "mart") await placeNpc(scene, "Mart Clerk", { role: "clerk" }, nx, ny);
      else if (sys.kind === "police") await placeNpc(scene, "Officer Jenny", { role: "officer" }, nx, ny);
      else if (sys.kind === "gym" && sys.leader) await placeNpc(scene, sys.leader, { role: "gym", gymRegion: sys.gymRegion, gymIndex: sys.gymIndex }, nx, ny);
      else if (sys.kind === "house") await placeNpc(scene, "Resident", { flavor: "resident" }, nx, 420);
    } else if (isTown) {
      // The service NPCs & the gym leader now live INSIDE their buildings, so make
      // sure those interiors are imported (the door tiles warp the player in).
      await ensureScene("Pokémon Center"); await ensureScene("Poké Mart"); await ensureScene("Police Station");
      const gymDoor = scene.regions?.find((r) => r.name === "Gym");
      const gymDest = gymDoor?.behaviors?.find((b) => b.type === "zoneTransit")?.system?.destinationSceneName;
      if (gymDest) await ensureScene(gymDest);
      // Flavour residents stand on the open ground near the town entrance (the
      // bottom of the map), clear of the building rows so they never look like
      // they're standing inside a building.
      const spots = [[w * 0.5, h * 0.90], [w * 0.28, h * 0.88], [w * 0.72, h * 0.88], [w * 0.16, h * 0.94], [w * 0.84, h * 0.94]];
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
    // The Leader says their piece, then the challenge begins.
    const quote = LEADER_QUOTES[doc?.name] ?? GENERIC_LEADER;
    await ChatMessage.create({ speaker: { alias: doc?.name ?? "Gym Leader" }, content: `<div class="pm-encounter-card"><p><em>${quote}</em></p></div>` });
    return pm.league?.gymChallenge?.(t, region, idx ?? undefined);
  }
  const line = pickLine(doc?.getFlag?.(FLAG, "npcFlavor"));
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
  if (!canPlace()) return ui.notifications?.warn("Only the GM can build the world.");
  const DialogV2 = foundry.applications?.api?.DialogV2;
  const pack = game.packs.get("pokemon-masters.scenes");
  if (!pack) return ui.notifications?.warn("Pokémon Masters scene compendium not found.");
  await pack.getIndex();
  const present = new Set((game.scenes ?? []).map((s) => s.name));
  const toImport = pack.index.filter((e) => !present.has(e.name));

  if (DialogV2) {
    const ok = await DialogV2.confirm({
      window: { title: "Build Pokémon World" },
      content: `<p>This imports the whole world — <strong>${toImport.length}</strong> new map(s) (${present.size} already here) — refreshes existing map art, lighting &amp; buildings, places every NPC, and drops you on the starting town.</p><p>Your existing tokens are kept. It can take a minute the first time. Continue?</p>`,
    }).catch(() => false);
    if (!ok) return;
  }
  ui.notifications?.info(`Pokémon Masters: building the world (${toImport.length} maps to import)…`);

  // 1) Import every map that isn't in the world yet (createScene auto-populates).
  let imported = 0;
  for (const e of toImport) {
    try { await game.scenes.importFromCompendium(pack, e._id, {}, { keepId: false }); imported++; }
    catch (err) { console.warn("Pokémon Masters | could not import", e.name, err); }
  }

  // 2) Refresh already-present maps (art/lighting + any new regions).
  let refreshed = 0, regionsAdded = 0;
  for (const s of (game.scenes ?? []).filter((s) => pack.index.some((e) => e.name === s.name))) {
    try {
      const entry = pack.index.find((e) => e.name === s.name);
      const o = (await pack.getDocument(entry._id)).toObject();
      await healSceneBackground(s);   // map onto the v14 Ground level (via mapSrc flag)
      await s.update({ tokenVision: o.tokenVision, fog: o.fog, environment: o.environment });
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

  // 3) (Re)populate NPCs on every scene.
  await game.settings.set(FLAG, "worldPopVersion", 0).catch(() => {});
  for (const scene of game.scenes ?? []) {
    await scene.unsetFlag(FLAG, "populated").catch(() => {});
    await populateScene(scene);
  }
  await game.settings.set(FLAG, "worldPopVersion", POP_VERSION).catch(() => {});

  // 4) Drop the GM onto the starting town.
  await activateStartTown();
  ui.notifications?.info(`Pokémon Masters: world ready — imported ${imported}, refreshed ${refreshed} map(s).`);
}

/** Import (if needed), populate and activate the default starting town. */
async function activateStartTown() {
  try {
    if (game.scenes?.active) return;
    const start = await ensureScene(PM.startTowns?.kanto ?? "Pallet Town");
    if (start) { await populateScene(start); await start.activate(); }
  } catch (err) { console.warn("Pokémon Masters | could not activate start town", err); }
}

/** Ensure a clickable "Rebuild Pokémon World" macro exists on the GM's hotbar. */
async function ensureRebuildMacro() {
  if (!game.user?.isGM) return;
  const name = "Rebuild Pokémon World";
  let macro = game.macros?.getName?.(name);
  if (!macro) {
    macro = await Macro.create({
      name, type: "script", img: "icons/svg/regen.svg", scope: "global",
      command: "game.pokemonMasters?.world?.rebuild?.();",
    }).catch(() => null);
  }
  // Put it on the first free hotbar slot so it's an actual visible button.
  const hotbar = game.user.hotbar ?? {};
  if (macro && !Object.values(hotbar).includes(macro.id)) {
    let slot = 1; while (hotbar[slot] && slot < 50) slot++;
    try { await game.user.assignHotbarMacro(macro, slot); } catch (err) { /* hotbar full / optional */ }
  }
}

export function registerWorldPop() {
  game.settings.register(FLAG, "worldPopVersion", { scope: "world", config: false, type: Number, default: 0 });
  game.settings.register(FLAG, "sceneSyncVersion", { scope: "world", config: false, type: Number, default: 0 });
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    world: { populateScene, interactNpc, repopulate: repopulateWorld, rebuild: rebuildWorld },
  });

  // Populate a scene the moment it's imported into the world.
  Hooks.on("createScene", (scene) => { if (canPlace()) { healSceneBackground(scene); healScenePadding(scene); populateScene(scene); } });

  // registerWorldPop() is itself called during the "ready" hook, so a nested
  // Hooks.once("ready") would never fire (it's not in the running snapshot).
  // Run the click handler + one-time migration directly instead.
  installNpcClick();
  void initWorldPop();
}

/** Install the Rebuild macro + build/populate the world on load (GM only). */
/** The map image src a scene should have, read version-safely (v14 Scene Level
 *  first, then the legacy top-level field for v13). */
/** The map image src currently shown by a scene (v14 Ground level, else v13). */
function currentSceneSrc(s) {
  const lvl = s.levels?.contents?.[0] ?? s.levels?.[0];
  if (lvl) return lvl.background?.src ?? "";
  return s._source?.background?.src ?? "";
}

/**
 * Put a scene's map onto its background — version-proof. Foundry v14 moved the
 * map off Scene#background onto a Scene LEVEL and DROPS the top-level field on
 * import, so we can't read it back; instead every compendium scene carries a
 * `mapSrc` flag (flags always survive). This copies that flag onto the scene's
 * Ground level (v14) or the top-level background (v13), only when out of date.
 * Runtime-only — no `levels` are baked into the pack (that crashes v14 launch).
 */
/** A scene name → its map-file key. MUST match build-packs' slug() exactly. */
function mapKey(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
async function healSceneBackground(s) {
  // Only touch OUR scenes (they carry a pokemon-masters flag: region and/or
  // mapSrc) so a user's custom scene is never clobbered. New scenes have the
  // mapSrc flag; scenes imported from an older pack don't, so derive the map
  // path from the scene name (identical to how the WebP file is named).
  const flags = s.flags?.[FLAG] ?? {};
  if (!("mapSrc" in flags) && !("region" in flags)) return false;
  const want = flags.mapSrc || `systems/pokemon-masters/assets/maps/${mapKey(s.name)}.webp`;
  if (currentSceneSrc(s) === want) return false;
  try {
    const lvl = s.levels?.contents?.[0];
    if (lvl) await lvl.update({ "background.src": want, "background.color": "#000000" });
    else await s.update({ "background.src": want, backgroundColor: "#000000" });
    return true;
  } catch (err) { console.warn("Pokémon Masters | could not heal scene", s?.name, err); return false; }
}

/**
 * Snap a scene to zero padding. Older packs baked scenes with 0.25 padding, which
 * shifts the map INSIDE the token/region coordinate space (~5-6 tiles on a town) —
 * so exit regions, the collision grid and spawn points (all authored in map-origin
 * coordinates) land offset from where tokens actually walk. That is why the player
 * spawns "4 squares north" and every edge transition reads as "none". Our scenes
 * now ship padding 0; migrate any scene imported from an older pack to match.
 */
async function healScenePadding(s) {
  const flags = s.flags?.[FLAG] ?? {};
  if (!("mapSrc" in flags) && !("region" in flags)) return false;   // only our scenes
  if ((s.padding ?? 0) === 0) return false;
  try { await s.update({ padding: 0 }); return true; }
  catch (err) { console.warn("Pokémon Masters | could not fix scene padding", s?.name, err); return false; }
}

/** Heal every imported scene's map background + padding on load (responsible client only). */
async function healSceneBackgrounds() {
  if (!canPlace()) return 0;
  let fixed = 0, repadded = 0;
  for (const s of game.scenes ?? []) {
    if (await healSceneBackground(s)) fixed++;
    if (await healScenePadding(s)) repadded++;
  }
  if (fixed) ui.notifications?.info(`Pokémon Masters: refreshed ${fixed} map background(s).`);
  if (repadded) ui.notifications?.info(`Pokémon Masters: aligned ${repadded} map(s) so exits and spawns line up.`);
  if (fixed || repadded) { try { if (canvas?.ready) await canvas.draw(); } catch (err) { /* redraw is best-effort */ } }
  return fixed;
}

/**
 * Bring a world scene imported from an OLDER pack up to date with the current
 * compendium: its geometry (size/grid/padding), our positional flags (collision,
 * exits, entry), the whole region set (edge exits, doors, collision openings) and
 * the background. Older worlds have scenes whose size/regions predate later map
 * rebuilds, so the new art no longer fills the scene and the exit regions sit at
 * stale positions — you walk off the art into black with no exit. Flag-only
 * migrations can't fix that; this re-syncs the actual geometry in place, keeping
 * the scene id so placed tokens survive. Only touches OUR scenes.
 */
async function reconcileScene(s) {
  const flags = s.flags?.[FLAG] ?? {};
  if (!("mapSrc" in flags) && !("region" in flags)) return false;   // only our scenes
  const pack = game.packs.get("pokemon-masters.scenes");
  const entry = pack?.index?.find((e) => e.name === s.name);
  if (!entry) return false;
  let src;
  try { src = (await pack.getDocument(entry._id))?.toObject(); } catch (err) { return false; }
  if (!src) return false;

  const pf = src.flags?.[FLAG] ?? {};
  const sizeChanged = s.width !== src.width || s.height !== src.height
    || (s.grid?.size ?? 0) !== (src.grid?.size ?? 0) || (s.padding ?? 0) !== (src.padding ?? 0);
  const regionsDiffer = (s.regions?.size ?? s.regions?.length ?? 0) !== (src.regions?.length ?? 0);
  if (!sizeChanged && !regionsDiffer) return false;                 // already current

  // 1) Geometry + our positional flags (null clears a flag the new build dropped).
  await s.update({
    width: src.width, height: src.height,
    "grid.size": src.grid?.size ?? s.grid?.size ?? 32,
    padding: src.padding ?? 0,
    "flags.pokemon-masters.collision": pf.collision ?? null,
    "flags.pokemon-masters.exits": pf.exits ?? null,
    "flags.pokemon-masters.entry": pf.entry ?? null,
    "flags.pokemon-masters.region": pf.region ?? flags.region ?? null,
    "flags.pokemon-masters.mapSrc": pf.mapSrc ?? flags.mapSrc ?? null
  }).catch((err) => console.warn("Pokémon Masters | scene geometry update failed", s?.name, err));

  // 2) Replace the region set so exits/doors/openings match the new geometry.
  const oldIds = (s.regions ?? []).map((r) => r.id);
  if (oldIds.length) await s.deleteEmbeddedDocuments("Region", oldIds).catch(() => {});
  const regs = (src.regions ?? []).map((r) => { const o = foundry.utils.duplicate(r); delete o._id; return o; });
  if (regs.length) await s.createEmbeddedDocuments("Region", regs).catch(() => {});

  // 3) Refresh the background for the (possibly resized) art.
  await healSceneBackground(s);

  // 4) Snap any token now off the (possibly smaller) map back onto a walkable tile.
  const moves = [];
  for (const t of s.tokens) {
    const w = nearestWalkable(s, t.x, t.y);
    if (w.x !== t.x || w.y !== t.y) moves.push({ _id: t.id, x: w.x, y: w.y });
  }
  if (moves.length) await s.updateEmbeddedDocuments("Token", moves).catch(() => {});

  // 5) Re-place NPCs for the new layout — clear existing NPC tokens first so we
  //    don't duplicate, then let populateScene stand them at the new spots.
  const npcIds = s.tokens.filter((t) => t.actor?.getFlag(FLAG, "isNpc")).map((t) => t.id);
  if (npcIds.length) await s.deleteEmbeddedDocuments("Token", npcIds).catch(() => {});
  await s.unsetFlag(FLAG, "populated").catch(() => {});
  await populateScene(s);
  return true;
}

/** Re-sync every imported world scene with the compendium (responsible client). */
async function reconcileScenes() {
  if (!canPlace()) return 0;
  let n = 0;
  for (const s of game.scenes ?? []) {
    try { if (await reconcileScene(s)) n++; } catch (err) { console.warn("Pokémon Masters | reconcile failed", s?.name, err); }
  }
  if (n) {
    ui.notifications?.info(`Pokémon Masters: synced ${n} map(s) to the latest layout — exits should line up now.`);
    try { if (canvas?.ready) await canvas.draw(); } catch (err) { /* redraw best-effort */ }
  }
  return n;
}

async function initWorldPop() {
  if (!canPlace()) return;
  await ensureRebuildMacro();
  try {
    // Refresh any stale map backgrounds from the compendium (e.g. right after a
    // system update) so old scenes render instead of showing a blank white grid.
    await healSceneBackgrounds();
    // Re-sync scenes imported from an older pack (size/regions/exits/collision)
    // so map-layout fixes reach worlds already in play, before we populate them.
    if ((game.settings.get(FLAG, "sceneSyncVersion") ?? 0) < SCENE_SYNC_VERSION) {
      await reconcileScenes();
      await game.settings.set(FLAG, "sceneSyncVersion", SCENE_SYNC_VERSION);
    }
    // Populate any already-imported scenes once per version.
    if ((game.settings.get(FLAG, "worldPopVersion") ?? 0) < POP_VERSION) {
      for (const scene of game.scenes ?? []) await populateScene(scene);
      await game.settings.set(FLAG, "worldPopVersion", POP_VERSION);
    }
    // Fresh world with nothing active? Drop the GM onto a populated starting
    // town so the world is "already out" — no dragging maps from the compendium.
    // (The rest of the world imports as you travel, or all at once via Rebuild.)
    await activateStartTown();
  } catch (err) {
    console.warn("Pokémon Masters | world init failed", err);
  }
}
