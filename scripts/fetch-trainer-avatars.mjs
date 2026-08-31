/**
 * Pokémon Masters — fetch REAL named-character portraits from Pokémon Showdown.
 *
 *   npm run avatars     (run anywhere Showdown is reachable; re-run to fill gaps)
 *
 * Every named leader / Elite Four / champion / professor across all nine regions
 * has a real portrait on Pokémon Showdown (Cynthia, Leon, Nessa, Iono, …), for
 * every generation — the later-gen trainers that no open GitHub decomp ships as
 * loose files. Showdown is blocked inside the build sandbox, but reachable from
 * an ordinary machine, so this is an OPT-IN vendoring step:
 *
 *   1. it downloads each character's portrait into assets/trainers/avatar_<id>.png
 *   2. it rewrites src/module/avatars.mjs so the game uses the real portraits
 *   3. the files are committed → the game stays self-contained (no run-time calls)
 *
 * Fail-open: characters Showdown doesn't have (or if the host is unreachable)
 * simply keep the gender/role-appropriate class sprite already chosen in
 * config.mjs, so running this never makes the world worse — only better.
 *
 * Source: https://play.pokemonshowdown.com/sprites/trainers/<id>.png (each id is
 * a lowercased, alphanumeric form of the character's name; we try a few
 * candidate ids per name and keep the first that returns a real PNG).
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PM } from "../src/module/config.mjs";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "assets", "trainers");
const BASE = "https://play.pokemonshowdown.com/sprites/trainers";

/** Download a URL to a file; true only on a 200 with real (PNG-sized) bytes. */
async function download(url, dest) {
  try {
    const { stdout } = await run("curl", ["-sSL", "--max-time", "30", "-w", "%{http_code} %{size_download}", "-o", dest, url], { maxBuffer: 1 << 20 });
    const [code, size] = stdout.trim().split(/\s+/);
    if (code === "200" && Number(size) > 600) return true;   // real portraits are a few KB; a 404 page is tiny
    await fs.rm(dest, { force: true });
    return false;
  } catch { await fs.rm(dest, { force: true }).catch(() => {}); return false; }
}

/** Candidate Showdown ids for a character name, most-likely first. */
function candidates(name) {
  const alnum = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const c = new Set();
  c.add(alnum(name));                                        // "cynthia", "ltsurge", "crasherwake"
  c.add(alnum(name.replace(/&/g, "and")));                   // "tateandliza"
  const stripped = name.replace(/^(professor|prof\.?|lt\.?|crasher)\s+/i, "");
  c.add(alnum(stripped));                                    // "surge", "wake", "oak"
  const first = name.split(/[,/&]/)[0].trim();               // trios/pairs/dual-profs → first member
  if (first) { c.add(alnum(first)); c.add(alnum(first.replace(/^(professor|prof\.?)\s+/i, ""))); }
  const words = name.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  if (words.length) c.add(alnum(words[words.length - 1]));   // last word ("surge","wake","liza")
  return [...c].filter(Boolean);
}

// A broad library of famous named characters BEYOND the League roster — villain
// bosses & admins, rivals, and player protagonists across all nine regions — so
// the world has a real portrait ready for any of them, even ones no NPC is named
// after yet. Showdown lacks a few of these; those are simply skipped.
const EXTRA_CHARACTERS = [
  // Villain leaders / notable admins
  "Giovanni", "Archer", "Ariana", "Proton", "Petrel", "Maxie", "Archie", "Tabitha", "Courtney", "Matt", "Shelly",
  "Cyrus", "Mars", "Jupiter", "Saturn", "Charon", "Ghetsis", "Colress", "Zinzolin", "Rood",
  "Lysandre", "Xerosic", "Aliana", "Bryony", "Celosia", "Mable",
  "Guzma", "Plumeria", "Lusamine", "Faba", "Gladion",
  "Rose", "Oleana", "Nemona", "Arven", "Penny", "Cassiopeia",
  // Rivals & companions
  "Blue", "Silver", "Barry", "Cheren", "Bianca", "Hugh", "Serena", "Calem", "Hau",
  "Hop", "Bede", "Marnie", "Nessa", "Wally", "Brendan", "May",
  // Player protagonists
  "Red", "Leaf", "Ethan", "Lyra", "Lucas", "Dawn", "Hilbert", "Hilda", "Nate", "Rosa",
  "Elio", "Selene", "Victor", "Gloria", "Florian", "Juliana",
];

/** Every named character in the League roster: leaders, E4, champions, professors. */
function roster() {
  const names = new Set();
  for (const data of Object.values(PM.gymLeaders ?? {})) {
    if (data.professor) names.add(data.professor);
    if (data.champion) names.add(data.champion);
    for (const l of data.leaders ?? []) names.add(l.name);
    for (const e of data.eliteFour ?? []) names.add(e.name);
  }
  return [...names];
}

/** The League roster plus the wider famous-character library, de-duplicated. */
function allNamed() {
  return [...new Set([...roster(), ...EXTRA_CHARACTERS])];
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const names = allNamed();
  console.log(`Fetching real portraits for ${names.length} named characters from Pokémon Showdown…`);

  const map = {};            // lowercase name -> avatar_<id>.png
  const added = [];          // index keys (no extension)
  let got = 0, miss = 0;
  for (const name of names) {
    let done = false;
    for (const id of candidates(name)) {
      const file = `avatar_${id}.png`;
      const dest = path.join(OUT, file);
      if (existsSync(dest)) { map[name.toLowerCase()] = file; added.push(`avatar_${id}`); got++; done = true; break; }
      if (await download(`${BASE}/${id}.png`, dest)) { map[name.toLowerCase()] = file; added.push(`avatar_${id}`); got++; done = true; break; }
    }
    if (!done) miss++;
  }

  if (!got) {
    console.error("No portraits fetched — is Pokémon Showdown reachable from here?");
    console.error("(play.pokemonshowdown.com is blocked inside the build sandbox; run this on an unrestricted machine.)");
    process.exitCode = 1;
    return;
  }

  // Rewrite the override map the game reads.
  const entries = Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  const body = entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n");
  const header = (await fs.readFile(path.join(ROOT, "src", "module", "avatars.mjs"), "utf8")).split("export const NAMED_AVATARS")[0];
  await fs.writeFile(path.join(ROOT, "src", "module", "avatars.mjs"), `${header}export const NAMED_AVATARS = {\n${body}\n};\n`);

  // Keep the trainers index in sync so the fidelity checks see the new files.
  const idxPath = path.join(OUT, "index.json");
  const idx = JSON.parse(await fs.readFile(idxPath, "utf8"));
  idx.files = [...new Set([...idx.files, ...added])].sort();
  await fs.writeFile(idxPath, JSON.stringify(idx));

  console.log(`\nDone — vendored ${got} real portraits (${miss} not on Showdown, kept their class sprite).`);
  console.log("Wrote src/module/avatars.mjs and updated assets/trainers/index.json.");
  console.log("Commit assets/trainers/avatar_*.png + src/module/avatars.mjs to keep the game self-contained.");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
