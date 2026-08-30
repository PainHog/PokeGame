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

export function registerWorldHooks() {
  Hooks.on("renderSceneConfig", injectRegionSelect);
}
