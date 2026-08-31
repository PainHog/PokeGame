/**
 * Pokémon Masters — Poké Mart shop.
 *
 * Buy items (money out, gear into the trainer's bag) and sell them back at half
 * price. Prices come from each gear item's `system.price` (set at build time),
 * so there is one source of truth. Opened from the trainer sheet "🛒 Shop"
 * button (use it while standing in a Mart).
 */

import { resolveTrainer } from "./catch.mjs";

/** The standard Mart stock. Names are resolved against the gear compendium. */
const DEFAULT_STOCK = [
  "Poké Ball", "Great Ball", "Ultra Ball", "Potion", "Super Potion", "Hyper Potion",
  "Revive", "Antidote", "Paralyze Heal", "Awakening", "Burn Heal", "Ice Heal", "Full Heal",
  "Escape Rope", "Repel", "Super Repel"
];

async function gearDoc(name) {
  const pack = game.packs.get("pokemon-masters.gear");
  if (!pack) return null;
  const key = String(name).toLowerCase();
  const entry = pack.index.find((e) => e.name.toLowerCase() === key);
  return entry ? pack.getDocument(entry._id) : null;
}

/** Add `qty` of a named item to the trainer's bag (stacking). */
async function giveItem(trainer, name, qty) {
  const existing = trainer.items.find((i) => i.type === "gear" && i.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.update({ "system.quantity": (existing.system.quantity ?? 0) + qty });
  const doc = await gearDoc(name);
  if (!doc) return ui.notifications?.warn(`Item not found: ${name}`);
  const obj = doc.toObject();
  delete obj._id;
  obj.system.quantity = qty;
  return trainer.createEmbeddedDocuments("Item", [obj]);
}

/** Open the Mart. Loops until the player leaves. */
export async function openShop(trainer, stock = DEFAULT_STOCK) {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Select or assign your Trainer first.");
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2) return ui.notifications?.warn("Shop needs the v13+ dialog.");

  // Resolve stock to buyable {name, price}.
  const buyable = [];
  for (const name of stock) {
    const doc = await gearDoc(name);
    if (doc && (doc.system.price ?? 0) > 0) buyable.push({ name: doc.name, price: doc.system.price });
  }
  const money = trainer.system.money ?? 0;
  const sellable = trainer.items.filter((i) => i.type === "gear" && i.system.category !== "key" && (i.system.price ?? 0) > 0);

  const buyOpts = buyable.map((b) => `<option value="${b.name}">${b.name} — ₽${b.price}</option>`).join("");
  const sellOpts = sellable.map((i) => `<option value="${i.id}">${i.name} ×${i.system.quantity} — sell ₽${Math.floor(i.system.price / 2)}</option>`).join("");
  const content = `
    <p><strong>Money:</strong> ₽${money}</p>
    <div class="pm-row"><label style="flex:2">Buy <select name="buy">${buyOpts}</select></label>
      <label style="flex:1">Qty <input type="number" name="qty" value="1" min="1" max="99"></label></div>
    <div class="pm-row"><label style="flex:1">Sell <select name="sell"><option value="">—</option>${sellOpts}</select></label></div>`;

  const res = await DialogV2.wait({
    window: { title: "Poké Mart" },
    content,
    buttons: [
      { action: "buy", label: "Buy", callback: (e, b) => ({ act: "buy", item: b.form.elements.buy.value, qty: Math.max(1, Number(b.form.elements.qty.value) || 1) }) },
      { action: "sell", label: "Sell", callback: (e, b) => ({ act: "sell", id: b.form.elements.sell.value }) },
      { action: "leave", label: "Leave", callback: () => null }
    ],
    rejectClose: false
  }).catch(() => null);
  if (!res) return;

  if (res.act === "buy" && res.item) {
    const price = buyable.find((b) => b.name === res.item)?.price ?? 0;
    const cost = price * res.qty;
    if (cost > (trainer.system.money ?? 0)) ui.notifications?.warn(`Not enough money (need ₽${cost}).`);
    else {
      await trainer.update({ "system.money": (trainer.system.money ?? 0) - cost });
      await giveItem(trainer, res.item, res.qty);
      await ChatMessage.create({ speaker: { alias: "Poké Mart" }, content: `<p>${trainer.name} bought ${res.qty}× ${res.item} for ₽${cost}.</p>` });
    }
  } else if (res.act === "sell" && res.id) {
    const item = trainer.items.get(res.id);
    if (item) {
      const credit = Math.floor((item.system.price ?? 0) / 2) * (item.system.quantity ?? 1);
      await trainer.update({ "system.money": (trainer.system.money ?? 0) + credit });
      await item.delete();
      await ChatMessage.create({ speaker: { alias: "Poké Mart" }, content: `<p>${trainer.name} sold ${item.name} for ₽${credit}.</p>` });
    }
  }
  return openShop(trainer, stock); // keep shopping
}

export function registerShopApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, { shop: { open: openShop } });
}
