/**
 * Pokémon Masters — world hooks.
 *
 * Adds a "Pokémon Masters Region" dropdown to the Scene configuration so a GM
 * can tag each map with its region (Kanto, Alola, …). The tag is stored as
 * `scene.flags.pokemon-masters.region` and read by the Wild Tile behavior to
 * pick region-appropriate encounter tables (Alolan Geodude vs. Kanto Geodude).
 *
 * Foundry names an input `flags.<scope>.<key>` and the document sheet persists
 * it as a flag automatically on submit — so injection just needs the <select>.
 * Written defensively (jQuery *or* HTMLElement, wrapped in try/catch) so it can
 * never break the Scene config dialog across v13/v14.
 */

import { PM } from "./config.mjs";

function injectRegionSelect(app, html) {
  try {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    if (root.querySelector('[name="flags.pokemon-masters.region"]')) return; // already added

    const scene = app.document ?? app.object;
    const current = scene?.getFlag?.("pokemon-masters", "region") ?? "";

    const options = ['<option value="">— None —</option>']
      .concat(Object.entries(PM.regions).map(
        ([key, label]) => `<option value="${key}"${key === current ? " selected" : ""}>${label}</option>`
      )).join("");

    const group = document.createElement("div");
    group.className = "form-group";
    group.innerHTML = `
      <label>Pokémon Masters Region</label>
      <div class="form-fields">
        <select name="flags.pokemon-masters.region">${options}</select>
      </div>
      <p class="notes">Wild encounters on this map draw from this region's tables (regional variants included).</p>`;

    // Prefer a Basics/ambience area; otherwise fall back to the form itself.
    const anchor = root.querySelector('[name="environment.darknessLevel"]')?.closest(".form-group")
      ?? root.querySelector('[name="darkness"]')?.closest(".form-group")
      ?? root.querySelector('[name="navigation.name"]')?.closest(".form-group")
      ?? root.querySelector('[name="navName"]')?.closest(".form-group");
    if (anchor) anchor.after(group);
    else (root.querySelector("form") ?? root).prepend(group);
  } catch (err) {
    console.warn("Pokémon Masters | Could not inject Scene region selector", err);
  }
}

/**
 * Keep the Actors directory tidy: each Trainer gets their own folder with a
 * "Pokémon" sub-folder, and their Pokémon are filed into it. Runs on a single
 * client (the active GM) so folders aren't created in duplicate.
 */
async function organizeActor(actor, options, userId) {
  try {
    // Exactly one client organizes, so folders aren't duplicated. With a GM
    // online that's the GM; in GM-less play it's the user who created the actor
    // (so each player files their own trainer & catches).
    const gm = game.users?.activeGM;
    if (gm) { if (game.user !== gm) return; }
    else if (userId && game.user.id !== userId) return;
    if (!game.user.can("FOLDER_CREATE")) return;

    if (actor.type === "trainer") {
      // Give the trainer/NPC a token sprite by name (Nurse Joy, Bug Catcher…),
      // unless the GM already set a custom image.
      const isDefaultImg = !actor.img || actor.img === "icons/svg/mystery-man.svg";
      const update = {};
      if (isDefaultImg) {
        const sprite = PM.npcSpriteFor(actor.name);
        update.img = sprite;
        update["prototypeToken.texture.src"] = sprite;
        update["prototypeToken.actorLink"] = true;
      }
      if (!actor.folder) {
        const folder = await Folder.create({ name: actor.name, type: "Actor", color: "#e3350d" });
        const sub = await Folder.create({ name: "Pokémon", type: "Actor", color: "#3b6db3", folder: folder.id });
        update.folder = folder.id;
        update["flags.pokemon-masters.pokeFolder"] = sub.id;
      }
      if (Object.keys(update).length) await actor.update(update);
    } else if (actor.type === "pokemon" && actor.system.trainer) {
      const trainer = await fromUuid(actor.system.trainer);
      if (!trainer || trainer.getFlag?.("pokemon-masters", "isNpc")) return; // don't file wild/NPC mons
      let sub = trainer.getFlag?.("pokemon-masters", "pokeFolder");
      if (!sub || !game.folders?.get(sub)) {
        // The trainer isn't organized yet (e.g. created before this feature) —
        // build its folder + Pokémon sub-folder now so the catch has a home.
        const parentId = trainer.folder?.id ?? (await Folder.create({ name: trainer.name, type: "Actor", color: "#e3350d" })).id;
        const subFolder = await Folder.create({ name: "Pokémon", type: "Actor", color: "#3b6db3", folder: parentId });
        await trainer.update({ folder: parentId, "flags.pokemon-masters.pokeFolder": subFolder.id });
        sub = subFolder.id;
      }
      if (actor.folder?.id !== sub) await actor.update({ folder: sub });
    }
  } catch (err) {
    console.warn("Pokémon Masters | could not auto-organize actor folders", err);
  }
}

export function registerWorldHooks() {
  Hooks.on("renderSceneConfig", injectRegionSelect);
  Hooks.on("createActor", organizeActor);
  // A Pokémon caught/gifted later (its trainer set after creation) also gets
  // filed — pass the acting user so GM-less gating (creator-only) still works.
  Hooks.on("updateActor", (actor, changes, options, userId) => {
    if (actor.type === "pokemon" && changes.system?.trainer) organizeActor(actor, options, userId);
  });
}
