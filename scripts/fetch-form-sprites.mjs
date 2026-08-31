/**
 * Pokémon Masters — fetch & bundle FORM-specific sprites locally.
 *
 *   npm run forms          (run once; re-run to fill gaps)
 *
 * The base sprite set (`npm run sprites`) is keyed by National Dex NUMBER, so
 * every alternate form (Alolan Raichu, Charizard-Mega-X, Toxtricity-Low-Key, …)
 * shares its base species' art. This script gives each form its OWN sprite where
 * one is reachable, downloading into assets/sprites/forms/<species.id>.<ext> and
 * writing an index.json the pack builder reads. Forms without a reachable sprite
 * simply keep the base-number sprite (safe fallback, no regressions).
 *
 * How a form's sprite is found:
 *   1. @pkmn/img gives the Pokémon Showdown slug for the form (e.g. Raichu-Alola
 *      → "raichu-alola", Charizard-Mega-X → "charizard-megax").
 *   2. PokeAPI ships its source data as a small CSV keyed by a numeric id, whose
 *      `identifier` column carries hyphenated form names (e.g. "raichu-alola").
 *   3. Normalising both sides (lowercase, strip every non-alphanumeric char) makes
 *      the Showdown slug and the PokeAPI identifier line up for most forms.
 *   4. PokeAPI's sprite repo has an ANIMATED gif per numeric id under
 *      other/showdown/<id>.gif (static <id>.png fallback).
 *
 * Source: https://github.com/PokeAPI/sprites + https://github.com/PokeAPI/pokeapi
 * (both CC0 / open data). Self-contained: sprites are vendored into the repo.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Dex } from "@pkmn/dex";
import { Sprites } from "@pkmn/img";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "assets", "sprites", "forms");
const CSV_URL = "https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/pokemon.csv";
const SPRITE_BASE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon";
const ANI = (n) => `${SPRITE_BASE}/other/showdown/${n}.gif`;
const PNG = (n) => `${SPRITE_BASE}/${n}.png`;

/** Lowercase + strip every non-alphanumeric char (the bridge between the two id spaces). */
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Download a URL to a file with curl; returns true on a 200 with bytes. */
async function download(url, dest) {
  try {
    const { stdout } = await run("curl", ["-sSL", "--max-time", "30", "-w", "%{http_code} %{size_download}", "-o", dest, url], { maxBuffer: 1 << 20 });
    const [code, size] = stdout.trim().split(/\s+/);
    if (code === "200" && Number(size) > 0) return true;
    await fs.rm(dest, { force: true });
    return false;
  } catch { await fs.rm(dest, { force: true }).catch(() => {}); return false; }
}

/** curl a text URL to a string (used for the small PokeAPI CSV). */
async function fetchText(url) {
  const tmp = path.join(os.tmpdir(), `pm-pokeapi-${process.pid}.csv`);
  const ok = await download(url, tmp);
  if (!ok) throw new Error(`could not fetch ${url}`);
  const text = await fs.readFile(tmp, "utf8");
  await fs.rm(tmp, { force: true }).catch(() => {});
  return text;
}

/** The Showdown slug for a species (basename of the sprite url, minus extension). */
function showdownSlug(name) {
  try {
    const url = Sprites.getPokemon(name, { gen: "ani" }).url;
    return url.split("/").pop().replace(/\.(gif|png)$/, "");
  } catch { return null; }
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });

  // Every alternate form: a real species whose name differs from its base
  // species. Exclude `isNonstandard: "Future"` — those are fan/CAP speculative
  // "megas" (e.g. Clefable-Mega) that the game itself does not ship, so their
  // art would just be dead weight. Real Mega/regional forms are "Past"/null and
  // stay in.
  const forms = [...Dex.species.all()]
    .filter((s) => s.exists && s.num > 0 && s.baseSpecies && s.baseSpecies !== s.name
      && s.isNonstandard !== "Future");

  // PokeAPI id space: normalized identifier -> numeric id.
  console.log("Fetching PokeAPI pokemon.csv…");
  const csv = await fetchText(CSV_URL);
  const idByIdentifier = new Map();
  for (const line of csv.split("\n").slice(1)) {
    if (!line.trim()) continue;
    const [id, identifier] = line.split(",");
    if (identifier) idByIdentifier.set(norm(identifier), id);
  }

  // A handful of notable forms whose PokeAPI identifier the slug bridge can't
  // reach (PokeAPI spells them out — "-mask", "-breed", "-standard", "-female",
  // "-single-strike-gmax" …). These are exactly the visually-distinct forms
  // players notice, so map them explicitly to the right PokeAPI identifier.
  const OVERRIDES = {
    necrozmaduskmane: "necrozma-dusk", necrozmadawnwings: "necrozma-dawn",
    ogerponwellspring: "ogerpon-wellspring-mask", ogerponhearthflame: "ogerpon-hearthflame-mask",
    ogerponcornerstone: "ogerpon-cornerstone-mask",
    taurospaldeablaze: "tauros-paldea-blaze-breed", taurospaldeaaqua: "tauros-paldea-aqua-breed",
    taurospaldeacombat: "tauros-paldea-combat-breed",
    darmanitangalar: "darmanitan-galar-standard", darmanitangalarzen: "darmanitan-galar-zen",
    urshifugmax: "urshifu-single-strike-gmax", urshifurapidstrikegmax: "urshifu-rapid-strike-gmax",
    meowsticf: "meowstic-female", basculegionf: "basculegion-female",
    miniormeteor: "minior-red-meteor", mausholdfour: "maushold-family-of-four",
    palafinhero: "palafin-hero",
  };
  // Generic candidate identifiers to try when the direct slug misses — catches
  // many gendered / Gigantamax forms whose PokeAPI id spells the suffix out.
  const candidatesFor = (s, slug) => {
    const base = (s.baseSpecies || s.name).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const out = [];
    if (slug) out.push(slug);
    if (/(^|-)f$/i.test(slug || "") || /-f$/i.test(s.id)) out.push(`${base}-female`);
    if (/(^|-)m$/i.test(slug || "")) out.push(`${base}-male`);
    if (/gmax/i.test(slug || "") || /gmax/i.test(s.id)) out.push(`${base}-gmax`);
    return out;
  };

  // Resolve each form to a PokeAPI numeric id via override → slug → candidates.
  const targets = []; // { id: species.id, num }
  const unmatched = [];
  for (const s of forms) {
    const slug = showdownSlug(s.name);
    let num = OVERRIDES[s.id] ? idByIdentifier.get(norm(OVERRIDES[s.id])) : null;
    if (!num) {
      for (const cand of candidatesFor(s, slug)) {
        num = idByIdentifier.get(norm(cand));
        if (num) break;
      }
    }
    if (num) targets.push({ speciesId: s.id, name: s.name, num });
    else unmatched.push(s.name);
  }

  console.log(`Forms: ${forms.length} total — ${targets.length} matched a PokeAPI sprite, ${unmatched.length} will fall back to their base sprite.`);
  console.log(`Downloading form sprites into assets/sprites/forms/…`);

  const index = {};
  let got = 0; let miss = 0;
  const BATCH = 16;
  for (let i = 0; i < targets.length; i += BATCH) {
    await Promise.all(targets.slice(i, i + BATCH).map(async ({ speciesId, num }) => {
      const gif = path.join(OUT, `${speciesId}.gif`);
      const png = path.join(OUT, `${speciesId}.png`);
      if (existsSync(gif)) { index[speciesId] = `${speciesId}.gif`; got++; return; }
      if (existsSync(png)) { index[speciesId] = `${speciesId}.png`; got++; return; }
      if (await download(ANI(num), gif)) { index[speciesId] = `${speciesId}.gif`; got++; return; }
      if (await download(PNG(num), png)) { index[speciesId] = `${speciesId}.png`; got++; return; }
      miss++;
    }));
    process.stdout.write(`\r  ${Math.min(i + BATCH, targets.length)}/${targets.length}`);
  }

  await fs.writeFile(path.join(OUT, "index.json"), JSON.stringify(index));
  console.log(`\nDone — ${got} form sprites bundled, ${miss} matched-but-unreachable, ${unmatched.length} fell back to base.`);
  console.log("Wrote assets/sprites/forms/index.json (species.id -> filename).");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
