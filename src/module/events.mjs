/**
 * Pokémon Masters — special events & venues.
 *
 * The set-pieces that make the world feel alive beyond wild grass and gyms:
 * the Safari Zone, the Bug-Catching Contest, the Game Corner, the Battle Tower,
 * Max Raid dens, fossil revival, the daily lottery, and berry farming.
 *
 * The scoring/odds cores (`safariThrow`, `scoreBugCatch`, `spinSlots`,
 * `matchLottery`, `berryStage`) are pure and RNG-injectable so they can be unit
 * tested outside Foundry. The wrappers below touch game state and only run live.
 */

import { PM } from "./config.mjs";
import { resolveTrainer } from "./catch.mjs";
import { addToParty } from "./storage.mjs";
import { markCaught } from "./dex.mjs";
import { applyIndividuality } from "./individuality.mjs";
import { simulateBattle, teamOf, combatantFromActor } from "./npc.mjs";

/* ============================================================= */
/*  Pure cores (testable)                                        */
/* ============================================================= */

/**
 * Safari Zone throw resolution. In the Safari Zone you can't weaken a Pokémon —
 * you sway the odds with Bait (harder to catch, less likely to flee) or a Rock
 * (easier to catch, more likely to flee). Catch/flee are single rolls.
 * @returns {{caught:boolean, fled:boolean, catchChance:number, fleeChance:number}}
 */
export function safariThrow({ catchRate = 30, angry = 0, eating = 0, rng = Math.random }) {
  // A rock raises catch rate but makes the mon "angry" (flees more); bait lowers
  // catch rate but keeps it "eating" (flees less).
  const effCatch = Math.max(1, Math.min(255, catchRate * (1 + 0.5 * angry) * (eating ? 0.5 : 1)));
  const catchChance = Math.min(1, effCatch / 255);
  const caught = rng() < catchChance;
  const baseFlee = 0.1 + 0.1 * angry - 0.05 * eating;
  const fleeChance = Math.max(0, Math.min(0.9, baseFlee));
  const fled = !caught && rng() < fleeChance;
  return { caught, fled, catchChance, fleeChance };
}

/** Bug-Catching Contest score: rarity weight × a level factor, best catch counts. */
export function scoreBugCatch(catches = []) {
  const RARITY_WEIGHT = { common: 40, uncommon: 70, rare: 110, veryrare: 160, legendary: 250 };
  let best = 0;
  for (const c of catches) {
    const w = RARITY_WEIGHT[c.rarity] ?? 40;
    const score = Math.round(w + (c.level ?? 1) * 2);
    if (score > best) best = score;
  }
  return best;
}

/**
 * Game Corner slot spin. Three reels; matching symbols pay out in coins.
 * @returns {{reels:string[], payout:number, label:string}}
 */
export function spinSlots(rng = Math.random) {
  const REELS = ["7", "7", "Bar", "Cherry", "Cherry", "Cherry", "Replay", "Pikachu"];
  const reels = [0, 1, 2].map(() => REELS[Math.floor(rng() * REELS.length)]);
  const [a, b, c] = reels;
  let payout = 0; let label = "No match";
  if (a === "7" && b === "7" && c === "7") { payout = 300; label = "777 JACKPOT!"; }
  else if (a === "Bar" && b === "Bar" && c === "Bar") { payout = 100; label = "BAR BAR BAR"; }
  else if (a === "Pikachu" && b === "Pikachu" && c === "Pikachu") { payout = 80; label = "Pika Pika Pi!"; }
  else if (a === "Replay" && b === "Replay" && c === "Replay") { payout = 15; label = "Replay"; }
  else if (a === "Cherry" && b === "Cherry" && c === "Cherry") { payout = 20; label = "Cherries"; }
  else if (a === "Cherry" && b === "Cherry") { payout = 8; label = "Two cherries"; }
  else if (a === "Cherry") { payout = 2; label = "One cherry"; }
  return { reels, payout, label };
}

/**
 * Loto-ID draw: compare the ticket to each Pokémon's dex/ID number from the
 * least-significant digit up; the longest run of matching trailing digits wins.
 * @returns {{matched:number, ticket:string}}
 */
export function matchLottery(ticket, ids = []) {
  const t = String(ticket).padStart(5, "0");
  let matched = 0;
  for (const id of ids) {
    const s = String(id).padStart(5, "0");
    let run = 0;
    for (let i = 0; i < 5; i++) { if (t[4 - i] === s[4 - i]) run++; else break; }
    if (run > matched) matched = run;
  }
  return { matched, ticket: t };
}

/** Berry growth stage 0–4 (planted→sprout→taller→flowering→berries) by elapsed time. */
export function berryStage(plantedAt, now, growthSeconds = 86400) {
  const elapsed = Math.max(0, now - plantedAt);
  return Math.min(4, Math.floor((elapsed / growthSeconds) * 4));
}

/** Canon stat curve at a level (IV 31, EV 0, neutral nature) for generated foes. */
export function statsAtLevel(base, level) {
  const point = (b) => Math.floor(((2 * b + 31) * level) / 100);
  return {
    hp: point(base.hp) + level + 10,
    atk: point(base.atk) + 5, def: point(base.def) + 5,
    spa: point(base.spa) + 5, spd: point(base.spd) + 5, spe: point(base.spe) + 5
  };
}

/* ============================================================= */
/*  Lore data tables                                             */
/* ============================================================= */

/** Fossil item → the Pokémon it revives into. */
export const FOSSILS = {
  "helix fossil": "Omanyte", "dome fossil": "Kabuto", "old amber": "Aerodactyl",
  "root fossil": "Lileep", "claw fossil": "Anorith", "skull fossil": "Cranidos",
  "armor fossil": "Shieldon", "cover fossil": "Tirtouga", "plume fossil": "Archen",
  "jaw fossil": "Tyrunt", "sail fossil": "Amaura"
};

/** Kanto Safari Zone (Fuchsia) resident species. */
export const SAFARI_KANTO = [
  "Nidoran-F", "Nidoran-M", "Nidorina", "Nidorino", "Rhyhorn", "Venonat", "Exeggcute",
  "Doduo", "Paras", "Paras", "Chansey", "Scyther", "Pinsir", "Tauros", "Kangaskhan", "Tangela", "Dratini"
];

/** Bug-Catching Contest catch pool. */
export const BUG_CONTEST_POOL = ["Caterpie", "Weedle", "Metapod", "Kakuna", "Butterfree", "Beedrill", "Venonat", "Pinsir", "Scyther", "Paras"];

/** Game Corner coin prizes: coins → an item or a Pokémon. */
export const GAME_CORNER_PRIZES = [
  { cost: 1000, kind: "item", name: "TM13 Ice Beam" },
  { cost: 2100, kind: "item", name: "TM24 Thunderbolt" },
  { cost: 4000, kind: "item", name: "TM25 Thunder" },
  { cost: 180, kind: "pokemon", name: "Abra", level: 9 },
  { cost: 500, kind: "pokemon", name: "Vulpix", level: 12 },
  { cost: 2680, kind: "pokemon", name: "Dratini", level: 18 },
  { cost: 5460, kind: "pokemon", name: "Scyther", level: 25 },
  { cost: 6500, kind: "pokemon", name: "Porygon", level: 26 }
];

/** Loto-ID prize tiers by number of trailing digits matched. */
export const LOTTERY_PRIZES = [
  null, { name: "Potion", note: "1 digit" }, { name: "Ultra Ball", note: "2 digits" },
  { name: "PP Up", note: "3 digits" }, { name: "Rare Candy", note: "4 digits" },
  { name: "Master Ball", note: "5 digits — jackpot!" }
];

/** Max Raid den bosses (species that headline dens; Dynamaxed & strong). */
export const RAID_BOSSES = ["Snorlax", "Gyarados", "Charizard", "Gengar", "Lapras", "Machamp", "Dragonite", "Tyranitar"];

/* ============================================================= */
/*  Live helpers (Foundry only)                                  */
/* ============================================================= */

const DialogV2 = () => foundry.applications?.api?.DialogV2;

async function findSpecies(name) {
  const pack = game.packs.get("pokemon-masters.species");
  if (!pack) return null;
  const key = String(name).toLowerCase();
  const entry = pack.index.find((e) => e.name.toLowerCase() === key);
  return entry ? pack.getDocument(entry._id) : null;
}

/** Grant a fresh Pokémon of `name` at `level` to a trainer (shared idiom). */
export async function grantSpecies(trainer, name, { level = 5, shiny = false } = {}) {
  const species = await findSpecies(name);
  if (!species) { ui.notifications?.warn(`Species not found: ${name}`); return null; }
  if (!game.user.isGM && !game.user.can("ACTOR_CREATE")) {
    ui.notifications?.info(`${species.name} is yours — ask your GM to add it to your party.`);
    return null;
  }
  const source = species.toObject();
  delete source._id;
  source.folder = null;
  source.system.level = level;
  source.system.hp = { value: null, max: 0 };
  if (trainer) source.system.trainer = trainer.uuid;
  applyIndividuality(source.system);
  if (shiny) source.system.shiny = true;
  const created = await Actor.implementation.create(source);
  if (created && trainer) { await addToParty(trainer, created); await markCaught(trainer, species.name); }
  return created;
}

/** Add or top up a bag item on the trainer (mirrors shop/reward idiom). */
async function giveItem(trainer, name, qty = 1) {
  const existing = trainer.items.find((i) => i.type === "gear" && i.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.update({ "system.quantity": (existing.system.quantity ?? 1) + qty });
  const pack = game.packs.get("pokemon-masters.gear");
  const entry = pack?.index.find((e) => e.name.toLowerCase() === name.toLowerCase());
  const doc = entry ? await pack.getDocument(entry._id) : null;
  const data = doc ? doc.toObject() : { name, type: "gear", system: { category: "item", quantity: qty, price: 0 } };
  delete data._id; data.system.quantity = qty;
  return trainer.createEmbeddedDocuments("Item", [data]);
}

const card = (title, body) => ChatMessage.create({ content: `<div class="pm-encounter-card"><h3>${title}</h3>${body}</div>` });

/* ---- Safari Zone ------------------------------------------- */

/** Run a Safari Zone session: limited Safari Balls, bait/rock, flee mechanics. */
export async function safariZone(trainer, { balls = 30, region = "kanto" } = {}) {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Assign your Trainer first.");
  const D = DialogV2();
  const pool = region === "kanto" ? SAFARI_KANTO : SAFARI_KANTO;
  let caught = [];
  let angry = 0; let eating = 0;
  while (balls > 0) {
    const name = pool[Math.floor(Math.random() * pool.length)];
    const species = await findSpecies(name);
    const catchRate = species?.system?.catchRate ?? 30;
    const level = 15 + Math.floor(Math.random() * 20);
    angry = 0; eating = 0;
    let encounterOver = false;
    while (!encounterOver && balls > 0) {
      const action = D ? await D.wait({
        window: { title: `Safari Zone — ${balls} balls left` },
        content: `<p>A wild <strong>${species?.name ?? name}</strong> (Lv ${level}) appeared!</p><p><small>${angry ? "It looks angry. " : ""}${eating ? "It's eating. " : ""}</small></p>`,
        buttons: [
          { action: "ball", label: "⚪ Safari Ball" },
          { action: "bait", label: "🍡 Bait" },
          { action: "rock", label: "🪨 Rock" },
          { action: "run", label: "Run" }
        ]
      }).catch(() => "run") : "run";
      if (action === "run" || !action) { encounterOver = true; break; }
      if (action === "bait") { eating = 1; angry = 0; continue; }
      if (action === "rock") { angry = 1; eating = 0; continue; }
      // ball
      balls--;
      const res = safariThrow({ catchRate, angry, eating });
      if (res.caught) {
        caught.push(species?.name ?? name);
        await grantSpecies(trainer, name, { level });
        await card("Safari Zone", `<p class="pm-caught">Gotcha! <strong>${species?.name ?? name}</strong> was caught!</p>`);
        encounterOver = true;
      } else if (res.fled) {
        await card("Safari Zone", `<p>The wild ${species?.name ?? name} fled!</p>`);
        encounterOver = true;
      }
    }
    if (!D) break; // no dialog available (tests) — bail after one encounter
  }
  await card("Safari Zone — time's up!", `<p>You caught <strong>${caught.length}</strong> Pokémon: ${caught.join(", ") || "none"}.</p>`);
  return caught;
}

/* ---- Bug-Catching Contest ---------------------------------- */

/** A quick Bug-Catching Contest: catch a few bugs, best score wins a prize. */
export async function bugContest(trainer) {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Assign your Trainer first.");
  const catches = [];
  const rounds = 5;
  for (let i = 0; i < rounds; i++) {
    const name = BUG_CONTEST_POOL[Math.floor(Math.random() * BUG_CONTEST_POOL.length)];
    const species = await findSpecies(name);
    const level = 8 + Math.floor(Math.random() * 12);
    if (Math.random() < 0.65) catches.push({ name, rarity: species?.system?.rarity ?? "common", level });
  }
  const score = scoreBugCatch(catches);
  // Prize by placing: your score vs. two rival NPCs.
  const rivals = [120 + Math.floor(Math.random() * 80), 90 + Math.floor(Math.random() * 90)];
  const place = 1 + rivals.filter((r) => r > score).length;
  const prize = place === 1 ? "Sun Stone" : place === 2 ? "Everstone" : "Great Ball";
  const best = catches.slice().sort((a, b) => scoreBugCatch([b]) - scoreBugCatch([a]))[0];
  if (place === 1 && best) await grantSpecies(trainer, best.name, { level: best.level });
  await giveItem(trainer, prize, 1);
  await card("Bug-Catching Contest", `<p>You caught ${catches.length} bug${catches.length === 1 ? "" : "s"} (best score ${score}).</p><p>You placed <strong>#${place}</strong> and won a <strong>${prize}</strong>!${place === 1 && best ? ` You keep your <strong>${best.name}</strong>.` : ""}</p>`);
  return { place, score, prize };
}

/* ---- Game Corner ------------------------------------------- */

/** Play a slot machine spin (3 coins/spin) and bank any payout in coins. */
export async function playSlots(trainer, bet = 3) {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Assign your Trainer first.");
  let coins = trainer.getFlag("pokemon-masters", "coins") ?? 0;
  if (coins < bet) return ui.notifications?.warn(`Not enough coins (need ${bet}). Buy coins at the counter.`);
  coins -= bet;
  const spin = spinSlots();
  coins += spin.payout;
  await trainer.setFlag("pokemon-masters", "coins", coins);
  await card("Game Corner", `<p class="pm-wobble">🎰 ${spin.reels.join(" | ")}</p><p><strong>${spin.label}</strong>${spin.payout ? ` — +${spin.payout} coins!` : ""}</p><p><small>Coins: ${coins}</small></p>`);
  return { spin, coins };
}

/** Buy Game Corner coins with money (₽ for coins), or exchange coins for prizes. */
export async function gameCorner(trainer) {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Assign your Trainer first.");
  const D = DialogV2();
  const coins = trainer.getFlag("pokemon-masters", "coins") ?? 0;
  if (!D) return playSlots(trainer);
  const action = await D.wait({
    window: { title: `Game Corner — ${coins} coins` },
    content: `<p>Coins: <strong>${coins}</strong> · Money: ₽${trainer.system.money ?? 0}</p>`,
    buttons: [
      { action: "buy", label: "Buy 50 coins (₽1000)" },
      { action: "spin", label: "🎰 Spin (3 coins)" },
      { action: "prizes", label: "🎁 Prize Exchange" },
      { action: "leave", label: "Leave" }
    ]
  }).catch(() => "leave");
  if (action === "buy") {
    if ((trainer.system.money ?? 0) < 1000) return ui.notifications?.warn("Not enough money.");
    await trainer.update({ "system.money": (trainer.system.money ?? 0) - 1000 });
    await trainer.setFlag("pokemon-masters", "coins", coins + 50);
    return card("Game Corner", `<p>Bought 50 coins. You now have ${coins + 50}.</p>`);
  }
  if (action === "spin") return playSlots(trainer);
  if (action === "prizes") return prizeExchange(trainer);
}

async function prizeExchange(trainer) {
  const D = DialogV2();
  const coins = trainer.getFlag("pokemon-masters", "coins") ?? 0;
  const options = GAME_CORNER_PRIZES.map((p, i) => `<option value="${i}">${p.name} — ${p.cost} coins</option>`).join("");
  const idx = await D.prompt({
    window: { title: `Prize Exchange — ${coins} coins` },
    content: `<select name="p" style="width:100%">${options}</select>`,
    ok: { label: "Redeem", callback: (e, b) => Number(b.form.elements.p.value) }
  }).catch(() => null);
  if (idx == null) return;
  const prize = GAME_CORNER_PRIZES[idx];
  if (coins < prize.cost) return ui.notifications?.warn(`Not enough coins (need ${prize.cost}).`);
  await trainer.setFlag("pokemon-masters", "coins", coins - prize.cost);
  if (prize.kind === "pokemon") await grantSpecies(trainer, prize.name, { level: prize.level ?? 10 });
  else await giveItem(trainer, prize.name, 1);
  await card("Game Corner", `<p>Redeemed <strong>${prize.name}</strong> for ${prize.cost} coins.</p>`);
}

/* ---- Battle Tower ------------------------------------------ */

/** Build a random NPC combatant team scaled to a level, for gauntlets. */
async function generateFoeTeam(size, level) {
  const pack = game.packs.get("pokemon-masters.species");
  const pool = pack.index.filter((e) => e.name && !/-(Mega|Primal|Gmax)/.test(e.name));
  const team = [];
  for (let i = 0; i < size; i++) {
    const entry = pool[Math.floor(Math.random() * pool.length)];
    const doc = await pack.getDocument(entry._id);
    const s = doc.system;
    const stats = statsAtLevel(s.baseStats, level);
    const moves = await resolveMoves((s.learnset ?? []).filter((l) => l.level && l.level <= level).slice(-6).map((l) => l.move), s.types, level);
    team.push({
      name: doc.name, level, types: s.types ?? ["Normal"], stats, baseStats: s.baseStats,
      ability: Object.values(s.abilities ?? {})[0] ?? s.ability ?? "", heldItem: "",
      hp: { value: stats.hp, max: stats.hp }, moves
    });
  }
  return team;
}

/** Resolve up to 4 usable move-data objects by name from the moves pack. */
async function resolveMoves(names, types = [], level = 50) {
  const pack = game.packs.get("pokemon-masters.moves");
  const picked = [];
  for (const name of names) {
    const entry = pack.index.find((e) => e.name.toLowerCase() === String(name).toLowerCase());
    if (!entry) continue;
    const doc = await pack.getDocument(entry._id);
    const m = doc.system;
    picked.push({
      name: doc.name, moveType: m.moveType, category: m.category, power: m.power,
      accuracy: m.accuracy ?? 100, priority: m.priority ?? 0, pp: m.pp ?? 15, contact: !!m.contact,
      inflictStatus: m.inflictStatus ?? "", secondaryStatus: m.secondaryStatus ?? "", secondaryChance: m.secondaryChance ?? 0,
      boosts: m.boosts ?? null, boostTarget: m.boostTarget ?? "target", secondaryBoosts: m.secondaryBoosts ?? null,
      multihit: m.multihit ?? null, drain: m.drain ?? 0, recoil: m.recoil ?? 0, healSelf: m.healSelf ?? 0,
      flinchChance: m.flinchChance ?? 0, confuseChance: m.confuseChance ?? 0,
      sideCondition: m.sideCondition ?? "", weather: m.weather ?? "", terrain: m.terrain ?? ""
    });
    if (picked.length >= 4) break;
  }
  // Guarantee at least one damaging move so the AI can act.
  if (!picked.some((m) => m.category !== "Status")) {
    picked.push({ name: "Tackle", moveType: types[0] ?? "Normal", category: "Physical", power: 40, accuracy: 100, priority: 0, pp: 35, contact: true });
  }
  return picked.slice(0, 4);
}

/** The Battle Tower: consecutive auto-battles; a win extends your streak & BP. */
export async function battleTower(trainer) {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Assign your Trainer first.");
  const team = await teamOf(trainer);
  if (!team.length) return ui.notifications?.warn("You need a Pokémon in your party.");
  const level = Math.max(...team.map((m) => m.level ?? 5));
  let streak = trainer.getFlag("pokemon-masters", "towerStreak") ?? 0;
  const foes = await generateFoeTeam(Math.min(3, team.length), level + Math.floor(streak / 3));
  // Fresh copies (full HP) for the challenger.
  const myTeam = (await teamOf(trainer)).map((m) => ({ ...m, hp: { value: m.stats.hp, max: m.stats.hp } }));
  const { winner, log } = simulateBattle(myTeam, foes);
  const won = winner === "A";
  streak = won ? streak + 1 : 0;
  await trainer.setFlag("pokemon-masters", "towerStreak", streak);
  const bp = won ? 3 : 0;
  if (won) {
    const cur = trainer.getFlag("pokemon-masters", "bp") ?? 0;
    await trainer.setFlag("pokemon-masters", "bp", cur + bp);
  }
  await card(`Battle Tower — ${won ? "Victory!" : "Defeat"}`,
    `<p>Opponents: ${foes.map((f) => f.name).join(", ")}.</p>` +
    `<p>${won ? `You won! Streak: <strong>${streak}</strong> (+${bp} BP).` : `Your streak of ${trainer.getFlag("pokemon-masters", "towerStreak") ?? 0} ends here.`}</p>` +
    `<details><summary>Battle log</summary><ol><li>${log.slice(0, 30).join("</li><li>")}</li></ol></details>`);
  return { won, streak };
}

/* ---- Max Raid Battle --------------------------------------- */

/** A Max Raid den: a Dynamaxed boss vs. the trainer's team; win to catch it. */
export async function maxRaid(trainer, bossName = null) {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Assign your Trainer first.");
  const myTeam = await teamOf(trainer);
  if (!myTeam.length) return ui.notifications?.warn("You need a Pokémon in your party.");
  bossName ??= RAID_BOSSES[Math.floor(Math.random() * RAID_BOSSES.length)];
  const doc = await findSpecies(bossName);
  if (!doc) return ui.notifications?.warn(`Unknown raid boss: ${bossName}`);
  const s = doc.system;
  const level = 55;
  const stats = statsAtLevel(s.baseStats, level);
  const moves = await resolveMoves((s.learnset ?? []).filter((l) => l.level && l.level <= level).slice(-8).map((l) => l.move), s.types, level);
  const boss = {
    name: `Dynamax ${doc.name}`, level, types: s.types ?? ["Normal"], stats, baseStats: s.baseStats,
    ability: Object.values(s.abilities ?? {})[0] ?? "", heldItem: "",
    hp: { value: stats.hp, max: stats.hp }, moves, dynamax: true
  };
  const { winner, log } = simulateBattle(myTeam.map((m) => ({ ...m, hp: { value: m.stats.hp, max: m.stats.hp } })), [boss]);
  const won = winner === "A";
  if (won) {
    await grantSpecies(trainer, bossName, { level: 40 }); // raid catch (near-guaranteed)
    await giveItem(trainer, "Rare Candy", 3);
  }
  await card(`Max Raid — ${doc.name}`,
    `<p>A Dynamaxed <strong>${doc.name}</strong> filled the den!</p>` +
    `<p>${won ? `You defeated and <span class="pm-caught">caught</span> it! (+3 Rare Candy)` : "The raid Pokémon was too strong — it fled."}</p>` +
    `<details><summary>Battle log</summary><ol><li>${log.slice(0, 30).join("</li><li>")}</li></ol></details>`);
  return { won, boss: doc.name };
}

/* ---- Fossil revival ---------------------------------------- */

/** Revive a held fossil item into its Pokémon at the lab (Lv 20). */
export async function reviveFossil(trainer, fossilName = null) {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Assign your Trainer first.");
  const fossils = trainer.items.filter((i) => i.type === "gear" && FOSSILS[i.name.toLowerCase()]);
  if (!fossils.length) return ui.notifications?.warn("You have no fossils to revive.");
  let item = fossilName ? fossils.find((f) => f.name.toLowerCase() === fossilName.toLowerCase()) : null;
  const D = DialogV2();
  if (!item && D) {
    const opts = fossils.map((f) => `<option value="${f.id}">${f.name} → ${FOSSILS[f.name.toLowerCase()]}</option>`).join("");
    const id = await D.prompt({
      window: { title: "Fossil Revival" },
      content: `<p>Which fossil should the lab revive?</p><select name="f" style="width:100%">${opts}</select>`,
      ok: { label: "Revive", callback: (e, b) => b.form.elements.f.value }
    }).catch(() => null);
    item = fossils.find((f) => f.id === id);
  }
  item ??= fossils[0];
  const species = FOSSILS[item.name.toLowerCase()];
  await grantSpecies(trainer, species, { level: 20 });
  // Consume one fossil.
  if ((item.system.quantity ?? 1) > 1) await item.update({ "system.quantity": item.system.quantity - 1 });
  else await item.delete();
  await card("Fossil Revival", `<p>The lab revived your ${item.name} into a <strong>${species}</strong>!</p>`);
  return species;
}

/* ---- Daily Loto-ID ----------------------------------------- */

/** Draw the daily lottery once per in-world day; match against your Pokémon IDs. */
export async function dailyLottery(trainer) {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Assign your Trainer first.");
  const day = Math.floor((game.time?.worldTime ?? Date.now() / 1000) / 86400);
  const last = trainer.getFlag("pokemon-masters", "lottoDay");
  if (last === day) return ui.notifications?.info("You've already drawn today's Loto-ID. Come back tomorrow.");
  await trainer.setFlag("pokemon-masters", "lottoDay", day);
  // Collect this trainer's owned Pokémon dex numbers as "IDs".
  const party = await trainer.getParty?.() ?? [];
  const ids = party.map((p) => p?.system?.species?.num ?? 0).filter(Boolean);
  const ticket = Math.floor(Math.random() * 100000);
  const { matched, ticket: t } = matchLottery(ticket, ids.length ? ids : [0]);
  const prize = LOTTERY_PRIZES[matched];
  if (prize) await giveItem(trainer, prize.name, 1);
  await card("Pokémon Lottery Corner",
    `<p>Today's winning number: <strong>${t}</strong></p>` +
    `<p>${matched ? `Matched <strong>${matched}</strong> digit${matched === 1 ? "" : "s"} — you won a <strong>${prize.name}</strong>!` : "No digits matched. Better luck tomorrow!"}</p>`);
  return { matched, ticket: t };
}

/* ---- Berry farming ----------------------------------------- */

/** Plant a berry in one of the trainer's soft-soil plots. */
export async function plantBerry(trainer, berryName = "Oran Berry") {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Assign your Trainer first.");
  const held = trainer.items.find((i) => i.type === "gear" && i.system.category === "berry" && i.name.toLowerCase() === berryName.toLowerCase());
  if (!held) return ui.notifications?.warn(`You don't have a ${berryName} to plant.`);
  const plots = trainer.getFlag("pokemon-masters", "berryPlots") ?? [];
  if (plots.length >= 6) return ui.notifications?.warn("All berry plots are full. Harvest first.");
  if ((held.system.quantity ?? 1) > 1) await held.update({ "system.quantity": held.system.quantity - 1 });
  else await held.delete();
  plots.push({ berry: berryName, plantedAt: game.time?.worldTime ?? Math.floor(Date.now() / 1000) });
  await trainer.setFlag("pokemon-masters", "berryPlots", plots);
  await card("Berry Farming", `<p>You planted a <strong>${berryName}</strong>. Come back later to harvest.</p>`);
}

/** Harvest any fully-grown berry plots (each ripe plant yields 2–4 berries). */
export async function harvestBerries(trainer) {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Assign your Trainer first.");
  const now = game.time?.worldTime ?? Math.floor(Date.now() / 1000);
  const plots = trainer.getFlag("pokemon-masters", "berryPlots") ?? [];
  const remaining = []; const harvested = [];
  for (const p of plots) {
    if (berryStage(p.plantedAt, now) >= 4) {
      const yld = 2 + Math.floor(Math.random() * 3);
      await giveItem(trainer, p.berry, yld);
      harvested.push(`${yld}× ${p.berry}`);
    } else remaining.push(p);
  }
  await trainer.setFlag("pokemon-masters", "berryPlots", remaining);
  await card("Berry Farming", harvested.length
    ? `<p>Harvested: ${harvested.join(", ")}.</p>`
    : `<p>Nothing is ripe yet. ${remaining.length} plot${remaining.length === 1 ? "" : "s"} still growing.</p>`);
  return harvested;
}

/* ============================================================= */

export function registerEventsApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    events: {
      safariZone, bugContest, gameCorner, playSlots, battleTower, maxRaid,
      reviveFossil, dailyLottery, plantBerry, harvestBerries, grantSpecies,
      // pure cores (for tools/tests)
      safariThrow, scoreBugCatch, spinSlots, matchLottery, berryStage
    }
  });

  // A venue arrival card's "enter" button opens the activity on the clicker's
  // own client (as their own trainer) — so no dialog pops on movement.
  document.addEventListener("click", (event) => {
    const btn = event.target?.closest?.(".pm-venue-btn");
    if (!btn) return;
    event.preventDefault();
    const target = btn.dataset.target || null;
    ({
      safari: () => safariZone(),
      bugcontest: () => bugContest(),
      gamecorner: () => gameCorner(),
      battletower: () => battleTower(),
      raid: () => maxRaid(null, target),
      fossil: () => reviveFossil(),
      lottery: () => dailyLottery(),
      berry: () => harvestBerries()
    }[btn.dataset.venue] ?? (() => {}))();
  });
}
