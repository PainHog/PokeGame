/**
 * Build the Pokémon Masters compendium packs from the offline @pkmn dataset.
 *
 *   node scripts/build-packs.mjs            # full Pokédex (all species/moves/…)
 *   node scripts/build-packs.mjs --limit=60 # quick subset for fast iteration
 *
 * Pipeline:
 *   1. Read species / moves / abilities / items from @pkmn/data (Gen 9).
 *   2. Emit one Foundry document JSON per entry under src/packs/<pack>/.
 *   3. Compile each source dir into a LevelDB pack under packs/<pack>/ with the
 *      official @foundryvtt/foundryvtt-cli.
 *
 * The output is a build artifact (git-ignored). Re-running is idempotent: IDs
 * are derived deterministically from names, so a rebuild keeps stable UUIDs.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Dex } from "@pkmn/dex";
import { Generations } from "@pkmn/data";
import { compilePack } from "@foundryvtt/foundryvtt-cli";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src", "packs");
const OUT = path.join(ROOT, "packs");

const LIMIT = (() => {
  const arg = process.argv.find((a) => a.startsWith("--limit="));
  return arg ? parseInt(arg.split("=")[1], 10) : Infinity;
})();

const gens = new Generations(Dex);
const gen = gens.get(9);

/* -------------------------------------------- */
/*  Helpers                                      */
/* -------------------------------------------- */

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Deterministic 16-char Foundry _id from a namespace + key (stable across rebuilds). */
function stableId(namespace, key) {
  let h = 0xcbf29ce484222325n;
  const str = `${namespace}:${key}`;
  for (const ch of str) {
    h = (h ^ BigInt(ch.charCodeAt(0))) * 0x100000001b3n & 0xffffffffffffffffn;
  }
  let n = h;
  let id = "";
  while (id.length < 16) {
    id += ID_ALPHABET[Number(n % 62n)];
    n = n / 62n;
    if (n === 0n) n = h + BigInt(id.length + 1);
  }
  return id.slice(0, 16);
}

function rarityForBst(bst) {
  if (bst >= 600) return "legendary";
  if (bst >= 525) return "veryrare";
  if (bst >= 450) return "rare";
  if (bst >= 330) return "uncommon";
  return "common";
}

const CATCH_RATE = { common: 190, uncommon: 120, rare: 60, veryrare: 30, legendary: 3 };

const BALL_MODIFIERS = {
  "poke ball": 1, "great ball": 1.5, "ultra ball": 2, "master ball": 255,
  "net ball": 3.5, "dive ball": 3.5, "nest ball": 4, "repeat ball": 3.5,
  "timer ball": 4, "dusk ball": 3, "quick ball": 5, "heal ball": 1, "luxury ball": 1,
  "premier ball": 1
};

async function writePack(name, docs) {
  const dir = path.join(SRC, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  for (const doc of docs) {
    await fs.writeFile(path.join(dir, `${doc._id}.json`), JSON.stringify(doc, null, 2));
  }
  const dest = path.join(OUT, name);
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  await compilePack(dir, dest, { log: false });
  console.log(`  ${name.padEnd(10)} ${String(docs.length).padStart(5)} documents`);
}

/* -------------------------------------------- */
/*  Species  ->  pokemon Actors                  */
/* -------------------------------------------- */

async function buildSpecies() {
  const docs = [];
  let count = 0;
  for (const s of gen.species) {
    if (count >= LIMIT) break;
    if (s.isNonstandard && s.isNonstandard !== "Past") continue; // skip CAP/etc.
    count++;

    const bs = s.baseStats;
    const bst = bs.hp + bs.atk + bs.def + bs.spa + bs.spd + bs.spe;
    const rarity = rarityForBst(bst);

    let learnset = [];
    try {
      const ls = await gen.learnsets.get(s.name);
      if (ls?.learnset) {
        learnset = Object.keys(ls.learnset).map((moveId) => {
          const move = gen.moves.get(moveId);
          // Earliest level-up entry, if any (format e.g. "9L14").
          const sources = ls.learnset[moveId] || [];
          let level = 0;
          for (const src of sources) {
            const m = /^\d+L(\d+)$/.exec(src);
            if (m) level = level ? Math.min(level, Number(m[1])) : Number(m[1]);
          }
          const name = move?.name ?? moveId.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
          return { move: name, level };
        });
      }
    } catch { /* some formes have no learnset */ }

    docs.push({
      _id: stableId("species", s.id),
      name: s.name,
      type: "pokemon",
      img: "icons/svg/mystery-man.svg",
      system: {
        species: { name: s.name, num: s.num },
        types: s.types,
        level: 5,
        rarity,
        catchRate: CATCH_RATE[rarity],
        abilities: Object.values(s.abilities).filter(Boolean),
        ability: s.abilities?.["0"] ?? "",
        baseStats: { hp: bs.hp, atk: bs.atk, def: bs.def, spa: bs.spa, spd: bs.spd, spe: bs.spe },
        hp: { value: null, max: 0 },
        moves: [],
        learnset,
        evolution: {
          from: s.prevo ?? "",
          into: s.evos ?? [],
          method: s.evoType ?? "",
          level: s.evoLevel ?? null,
          item: s.evoItem ?? "",
          condition: s.evoCondition ?? ""
        },
        trainer: null
      },
      prototypeToken: {
        name: s.name,
        actorLink: false,
        disposition: -1,
        bar1: { attribute: "hp" }
      }
    });
  }
  return docs;
}

/* -------------------------------------------- */
/*  Moves / Abilities / Gear  ->  Items          */
/* -------------------------------------------- */

function buildMoves() {
  const docs = [];
  let count = 0;
  for (const m of gen.moves) {
    if (count >= LIMIT) break;
    if (m.isNonstandard && m.isNonstandard !== "Past") continue;
    count++;
    docs.push({
      _id: stableId("move", m.id),
      name: m.name,
      type: "move",
      img: "icons/svg/sword.svg",
      system: {
        moveType: m.type,
        category: m.category,
        power: typeof m.basePower === "number" ? m.basePower : 0,
        accuracy: m.accuracy === true ? 100 : (m.accuracy || 0),
        alwaysHits: m.accuracy === true,
        pp: m.pp ?? 0,
        priority: m.priority ?? 0,
        target: m.target ?? "normal",
        description: m.shortDesc || m.desc || ""
      }
    });
  }
  return docs;
}

function buildAbilities() {
  const docs = [];
  let count = 0;
  for (const a of gen.abilities) {
    if (count >= LIMIT) break;
    if (a.isNonstandard) continue;
    count++;
    docs.push({
      _id: stableId("ability", a.id),
      name: a.name,
      type: "ability",
      img: "icons/svg/aura.svg",
      system: {
        isNonstandard: !!a.isNonstandard,
        description: a.shortDesc || a.desc || ""
      }
    });
  }
  return docs;
}

function buildGear() {
  const docs = [];
  let count = 0;
  for (const it of gen.items) {
    if (count >= LIMIT) break;
    if (it.isNonstandard) continue;
    count++;
    const lower = it.name.toLowerCase();
    const isBall = lower.endsWith(" ball") && lower in BALL_MODIFIERS;
    const category = isBall ? "ball"
      : it.isBerry ? "berry"
      : it.name.startsWith("TM") || it.name.startsWith("HM") ? "tm"
      : "item";
    docs.push({
      _id: stableId("gear", it.id),
      name: it.name,
      type: "gear",
      img: isBall ? "icons/svg/target.svg" : "icons/svg/item-bag.svg",
      system: {
        category,
        price: 0,
        quantity: 1,
        catchModifier: isBall ? (BALL_MODIFIERS[lower] ?? 1) : 1,
        description: it.desc || it.shortDesc || ""
      }
    });
  }
  return docs;
}

/* -------------------------------------------- */
/*  Run                                          */
/* -------------------------------------------- */

async function main() {
  await fs.mkdir(SRC, { recursive: true });
  await fs.mkdir(OUT, { recursive: true });
  console.log(`Building Pokémon Masters packs (gen 9${LIMIT !== Infinity ? `, limit ${LIMIT}` : ""})…`);
  await writePack("species", await buildSpecies());
  await writePack("moves", buildMoves());
  await writePack("abilities", buildAbilities());
  await writePack("gear", buildGear());
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
