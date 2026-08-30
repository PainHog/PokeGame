/**
 * Pokémon Masters — usable items.
 *
 * Lore-accurate effects for medicine and healing items: potions restore HP,
 * revives bring back a fainted Pokémon, status heals cure a condition, and a
 * Rare Candy grants a level. Effects are looked up by item name so they work
 * whether the item comes from the compendium or a trainer's bag.
 *
 * `applyHeal` is pure and unit tested.
 */

import { awardXp, xpToNext } from "./progression.mjs";

/** name (lower-case) → effect descriptor. */
export const ITEM_EFFECTS = {
  "potion": { heal: 20 },
  "super potion": { heal: 60 },
  "hyper potion": { heal: 120 },
  "max potion": { heal: "full" },
  "full restore": { heal: "full", cure: "all" },
  "fresh water": { heal: 30 },
  "soda pop": { heal: 50 },
  "lemonade": { heal: 70 },
  "moomoo milk": { heal: 100 },
  "berry juice": { heal: 20 },
  "oran berry": { heal: 10 },
  "sitrus berry": { healFrac: 0.25 },
  "revive": { revive: 0.5 },
  "max revive": { revive: 1 },
  "antidote": { cure: "poison" },
  "paralyze heal": { cure: "paralysis" },
  "parlyz heal": { cure: "paralysis" },
  "awakening": { cure: "sleep" },
  "burn heal": { cure: "burn" },
  "ice heal": { cure: "freeze" },
  "full heal": { cure: "all" },
  "lava cookie": { cure: "all" },
  "rare candy": { level: 1 }
};

/** Pure: new HP after healing `amount` ("full" or a number) onto value/max. */
export function applyHeal(value, max, amount) {
  if (amount === "full") return max;
  return Math.min(max, (value ?? 0) + amount);
}

/**
 * Use an item on a Pokémon. Returns a short outcome string, or null if the item
 * has no defined effect. Optionally consumes one from a `gearItem` (its quantity).
 */
export async function useItem(pokemon, itemName, { gearItem = null } = {}) {
  if (pokemon?.type !== "pokemon") return ui.notifications?.warn("Use items on a Pokémon.");
  const effect = ITEM_EFFECTS[String(itemName).toLowerCase()];
  if (!effect) return ui.notifications?.info(`${itemName} has no usable effect yet.`);

  const sys = pokemon.system;
  const max = sys.hp?.max ?? sys.stats?.hp ?? 1;
  const fainted = (sys.hp?.value ?? 0) <= 0;
  const update = {};
  const notes = [];

  if (effect.revive) {
    if (!fainted) { ui.notifications?.info(`${pokemon.name} isn't fainted.`); return null; }
    update["system.hp.value"] = Math.max(1, Math.round(max * effect.revive));
    update["system.status"] = "none";
    notes.push(`revived to ${update["system.hp.value"]}/${max} HP`);
  } else if (effect.heal || effect.healFrac) {
    if (fainted) { ui.notifications?.info(`${pokemon.name} has fainted — use a Revive first.`); return null; }
    const amount = effect.heal ?? Math.round(max * effect.healFrac);
    const newHp = applyHeal(sys.hp?.value, max, amount);
    update["system.hp.value"] = newHp;
    notes.push(amount === "full" ? "fully healed" : `+${newHp - (sys.hp?.value ?? 0)} HP`);
  }

  if (effect.cure) {
    const cured = effect.cure === "all" || sys.status === effect.cure;
    if (cured && sys.status !== "none") { update["system.status"] = "none"; notes.push("cured its condition"); }
  }

  if (Object.keys(update).length) await pokemon.update(update);

  if (effect.level) {
    const need = Math.max(1, xpToNext(sys.level) - (sys.xp ?? 0));
    await awardXp(pokemon, need); // grants exactly one level (+ moves/evolution)
    notes.push("grew a level");
  }

  if (gearItem && typeof gearItem.system?.quantity === "number") {
    const q = Math.max(0, gearItem.system.quantity - 1);
    if (q === 0) await gearItem.delete();
    else await gearItem.update({ "system.quantity": q });
  }

  if (!notes.length) { ui.notifications?.info(`${itemName} had no effect.`); return null; }
  await ChatMessage.create({
    speaker: { alias: pokemon.name },
    content: `<p>Used <strong>${itemName}</strong> on ${pokemon.name} — ${notes.join(", ")}.</p>`
  });
  return notes.join(", ");
}

/** Dialog: pick a healing item and use it on the Pokémon. */
export async function useItemDialog(pokemon) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  const names = Object.keys(ITEM_EFFECTS).map((n) => n.replace(/\b\w/g, (c) => c.toUpperCase()));
  let choice = "Potion";
  if (DialogV2) {
    const opts = names.map((n) => `<option value="${n}">${n}</option>`).join("");
    choice = await DialogV2.prompt({
      window: { title: `Use item on ${pokemon.name}` },
      content: `<select name="item" style="width:100%">${opts}</select>`,
      ok: { label: "Use", callback: (event, button) => button.form.elements.item.value }
    }).catch(() => null);
  }
  if (choice) return useItem(pokemon, choice);
}

export function registerItemsApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    items: { use: useItem, useDialog: useItemDialog, applyHeal }
  });
}
