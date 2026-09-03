/**
 * Pokémon Masters — fast travel (Fly) and ships.
 *
 * Fly: a trainer whose party knows Fly can warp to any town they've visited
 * (tracked as `flyPoints` when they enter a town/Center/Mart). Ships are ordinary
 * Zone Transit exits with a `requiredItem` (an S.S. Ticket) and a far-away
 * destination scene — handled in regions.mjs — so continent- and island-hopping
 * are just wired scenes.
 */

import { resolveTrainer } from "./catch.mjs";
import { partyKnows } from "./tms.mjs";
import { crossScene } from "./regions.mjs";

/** Open the Fly menu and travel to a visited town (requires a Fly user in the party). */
export async function fly(trainer) {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Select or assign your Trainer first.");
  if (!(await partyKnows(trainer, "Fly"))) return ui.notifications?.warn("No Pokémon in your party knows Fly.");

  const points = trainer.system.flyPoints ?? [];
  if (!points.length) return ui.notifications?.info("You haven't visited any towns to Fly to yet.");

  const token = trainer.getActiveTokens?.()[0]?.document ?? null;
  if (!token) return ui.notifications?.warn("Place your trainer token on a scene first.");

  const DialogV2 = foundry.applications?.api?.DialogV2;
  let dest = points[0];
  if (DialogV2) {
    const opts = points.map((p) => `<option value="${p}">${p}</option>`).join("");
    dest = await DialogV2.prompt({
      window: { title: "Fly to which town?" },
      content: `<select name="d" style="width:100%">${opts}</select>`,
      ok: { label: "Fly", callback: (event, button) => button.form.elements.d.value }
    }).catch(() => null);
  }
  if (!dest) return;

  const scene = game.scenes?.getName(dest);
  if (!scene) return ui.notifications?.warn(`Town not found: ${dest}`);
  await crossScene(token, trainer, scene, (scene.width ?? 2400) / 2, (scene.height ?? 1600) / 2);
  await ChatMessage.create({ speaker: { alias: trainer.name }, content: `<p>🕊️ <strong>${trainer.name}</strong> flew to <strong>${dest}</strong>.</p>` });
}

export function registerTravelApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, { travel: { fly } });
}
