/**
 * Pokémon Masters — scripted legendary & roaming events.
 *
 * Two flavours of legendary encounter sit on top of the population-cap system
 * (a unique legendary stops appearing in the wild once one exists as an Actor):
 *
 *  · Static shrines — a tagged Region (Legendary behavior) guards a fixed
 *    legendary (Articuno in the Seafoam Islands, Mewtwo in Cerulean Cave, …).
 *    Walking in with the prerequisites met (badge count / key item) posts a
 *    one-time scripted encounter. It fires once per world.
 *
 *  · Roaming beasts — Raikou / Entei / Suicune wander between maps. Each new
 *    in-world day they relocate; a qualifying trainer who reaches a beast's
 *    current map has a chance to run into it (it's skittish and hard to catch).
 *
 * `roamerRelocate` is pure and RNG-injectable for testing.
 */

import { PM } from "./config.mjs";
import { isResponsible } from "./permissions.mjs";
import { justTeleported } from "./regions.mjs";
import { worldPopulation } from "./eligibility.mjs";
import { catchButtonHtml, resolveTrainer } from "./catch.mjs";

const fields = foundry.data.fields;
const FLAG = "pokemon-masters";

/* ============================================================= */
/*  Lore data                                                    */
/* ============================================================= */

/** Kanto static legendaries: species → where it waits and what it demands. */
export const LEGENDARY_STATIC = {
  Articuno: { site: "Seafoam Islands", badges: 0 },
  Zapdos: { site: "Power Plant", badges: 0 },
  Moltres: { site: "Mt. Ember", badges: 0 },
  Mewtwo: { site: "Cerulean Cave", badges: 8 },
  Mew: { site: "Faraway Island", badges: 8, item: "Old Sea Map" }
};

/** Beasts that roam the connected Kanto/Johto world (HGSS-style). */
export const ROAMERS = ["Raikou", "Entei", "Suicune"];

/* ============================================================= */
/*  Pure core                                                    */
/* ============================================================= */

/**
 * Relocate each roamer to a random scene from the pool (avoiding its current
 * spot when possible). Returns a fresh {name: sceneName} map.
 */
export function roamerRelocate(names, scenePool, current = {}, rng = Math.random) {
  const out = {};
  if (!scenePool.length) return out;
  for (const name of names) {
    let pick = scenePool[Math.floor(rng() * scenePool.length)];
    if (scenePool.length > 1 && pick === current[name]) {
      pick = scenePool[(scenePool.indexOf(pick) + 1) % scenePool.length];
    }
    out[name] = pick;
  }
  return out;
}

/* ============================================================= */
/*  Live helpers (Foundry only)                                  */
/* ============================================================= */

async function findSpecies(name) {
  const pack = game.packs.get("pokemon-masters.species");
  if (!pack) return null;
  const key = String(name).toLowerCase();
  const entry = pack.index.find((e) => e.name.toLowerCase() === key);
  return entry ? pack.getDocument(entry._id) : null;
}

/** Has the trainer met a static legendary's prerequisites? */
function meetsPrereq(trainer, req = {}) {
  if ((req.badges ?? 0) > (trainer.system.badges ?? []).length) return false;
  if (req.item) {
    const has = trainer.items.some((i) => i.type === "gear" && i.name.toLowerCase() === req.item.toLowerCase());
    if (!has) return false;
  }
  return true;
}

/** World-scoped record of which one-off shrines have already fired. */
function legendaryState() {
  return foundry.utils.deepClone(game.settings.get(FLAG, "legendaryState") ?? { spawned: {}, roamers: {} });
}
async function saveLegendaryState(state) {
  if (game.user.isGM) await game.settings.set(FLAG, "legendaryState", state);
}

/**
 * Post a scripted legendary encounter (uses the normal throw→catch flow, so the
 * species' true — brutal — catch rate applies). Roaming ones note the flee risk.
 */
export async function startLegendaryEncounter(trainer, speciesName, { level = 50, roaming = false } = {}) {
  trainer ??= resolveTrainer();
  const species = await findSpecies(speciesName);
  if (!species) return ui.notifications?.warn(`Unknown legendary: ${speciesName}`);
  const cap = species.system.populationCap ?? 1;
  if (cap > 0 && worldPopulation(species.name) >= cap) {
    return ui.notifications?.info(`${species.name} has already been claimed in this world.`);
  }
  const types = (species.system.types ?? []).join(" / ");
  await ChatMessage.create({
    speaker: { alias: roaming ? "A roaming cry…" : "Legendary Encounter" },
    content: `
      <div class="pm-encounter-card pm-legendary-card">
        <h3>✨ ${roaming ? "The roaming" : "The legendary"} <strong>${species.name}</strong> appeared!</h3>
        <p><b>Level:</b> ${level} &nbsp; <b>Type:</b> ${types} &nbsp; <b>Catch rate:</b> ${species.system.catchRate}</p>
        <p><em>${roaming ? "It's poised to flee — one chance before it bolts!" : "This is a once-in-a-lifetime encounter. Weaken it, then throw."}</em></p>
        <p>${catchButtonHtml({ speciesUuid: species.uuid, level })}</p>
      </div>`
  });
  return species.name;
}

/* ---- Static shrine region behavior ------------------------- */

/** String event keys (avoid the CONST global at class-eval time). Use tokenMoveIn
 *  like the other region behaviours — tokenEnter no longer fires reliably in v14
 *  and also fires on arrival/scene-load, which would spawn the legendary at the
 *  wrong time. */
const TOKEN_MOVE_IN = "tokenMoveIn";
function trainerFromEvent(event) {
  const token = event?.data?.token;
  const actor = token?.actor ?? null;
  if (!actor || actor.type !== "trainer") return { token: null, actor: null };
  if (justTeleported(actor.id)) return { token: null, actor: null };          // not on the arrival tile
  if (actor.getFlag?.("pokemon-masters", "isNpc")) return { token: null, actor: null };
  return { token, actor };
}

export class LegendaryBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["PM.RegionBehavior.Legendary"];

  static defineSchema() {
    return {
      species: new fields.StringField({ required: true, blank: false, initial: "Mewtwo" }),
      level: new fields.NumberField({ required: true, integer: true, min: 1, max: 100, initial: 50 }),
      requireBadges: new fields.NumberField({ required: true, integer: true, min: 0, max: 8, initial: 0 }),
      requireItem: new fields.StringField({ required: false, blank: true, initial: "" }),
      once: new fields.BooleanField({ initial: true })
    };
  }

  static events = {
    [TOKEN_MOVE_IN]: async function (event) {
      const { token, actor } = trainerFromEvent(event);
      if (!actor || !isResponsible(token)) return;
      const name = this.species;
      // Prereqs first (silent if unmet — the shrine simply stays dormant).
      if (!meetsPrereq(actor, { badges: this.requireBadges, item: this.requireItem })) {
        return ChatMessage.create({
          speaker: { alias: "Legendary Shrine" },
          content: `<div class="pm-encounter-card"><p>An overwhelming presence rests here, but it does not stir. ${this.requireBadges ? `(${this.requireBadges} badges required${this.requireItem ? `, plus the ${this.requireItem}` : ""}.)` : this.requireItem ? `(The ${this.requireItem} is needed.)` : ""}</p></div>`
        });
      }
      const state = legendaryState();
      if (this.once && state.spawned?.[name]) return; // already triggered this world
      const species = await findSpecies(name);
      const cap = species?.system?.populationCap ?? 1;
      if (cap > 0 && worldPopulation(name) >= cap) return; // already caught
      state.spawned = { ...(state.spawned ?? {}), [name]: true };
      await saveLegendaryState(state);
      await startLegendaryEncounter(actor, name, { level: this.level });
    }
  };
}

/* ---- Roaming beasts ---------------------------------------- */

/** Scene names a roamer may hide in: any Region-tagged map that isn't a town. */
function roamerScenePool() {
  return (game.scenes ?? [])
    .filter((s) => s.getFlag?.(FLAG, "region"))
    .map((s) => s.name)
    .filter(Boolean);
}

/** Move every roaming beast to a new map (GM only) and drop a distant-cry hint. */
export async function relocateRoamers() {
  if (!game.user.isGM) return;
  const pool = roamerScenePool();
  if (!pool.length) return;
  const state = legendaryState();
  const next = roamerRelocate(ROAMERS.filter((n) => worldPopulation(n) < 1), pool, state.roamers ?? {});
  state.roamers = next;
  await saveLegendaryState(state);
  await ChatMessage.create({
    speaker: { alias: "The Wilds" },
    content: `<div class="pm-encounter-card"><p>🌩️ Distant cries echo across the region. The roaming legends have moved on…</p></div>`
  });
}

/**
 * When a player reaches a scene, see whether a roamer is lurking there and, if
 * so, roll a chance to trigger the fleeting encounter. Runs on the player's own
 * client (canvasReady), deduped per scene per day.
 */
async function checkRoamerOnScene(scene) {
  const trainer = game.user.character?.type === "trainer" ? game.user.character : null;
  if (!trainer || !scene?.name) return;
  const state = legendaryState();
  const here = Object.entries(state.roamers ?? {}).find(([, s]) => s === scene.name);
  if (!here) return;
  const [name] = here;
  if (worldPopulation(name) >= 1) return; // already caught
  const day = Math.floor((game.time?.worldTime ?? Date.now() / 1000) / 86400);
  const seenKey = `${name}:${scene.name}:${day}`;
  const seen = game.user.getFlag(FLAG, "roamerSeen");
  if (seen === seenKey) return; // one shot per beast per map per day
  await game.user.setFlag(FLAG, "roamerSeen", seenKey);
  if (Math.random() < 0.35) await startLegendaryEncounter(trainer, name, { level: 40, roaming: true });
}

/* ============================================================= */

export function registerLegendaryApi() {
  game.settings.register(FLAG, "legendaryState", {
    scope: "world", config: false, type: Object, default: { spawned: {}, roamers: {} }
  });

  // New in-world day → beasts roam (GM drives it once).
  Hooks.on("updateWorldTime", (worldTime, delta) => {
    if (!game.user.isGM || !delta) return;
    const prevDay = Math.floor((worldTime - delta) / 86400);
    const nowDay = Math.floor(worldTime / 86400);
    if (nowDay !== prevDay) relocateRoamers();
  });

  // Reaching a map may put a player face-to-face with a roamer.
  Hooks.on("canvasReady", (canvas) => { try { checkRoamerOnScene(canvas?.scene); } catch (err) { /* ignore */ } });

  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    legendaries: { startLegendaryEncounter, relocateRoamers, roamerRelocate, LEGENDARY_STATIC, ROAMERS }
  });
}
