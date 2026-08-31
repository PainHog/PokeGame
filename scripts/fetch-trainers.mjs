/**
 * Pokémon Masters — fetch & bundle trainer / NPC sprites locally.
 *
 *   npm run trainers        (run once; re-run to fill gaps)
 *
 * Downloads a large, uniform set of full-colour pixel-art trainer & NPC sprites
 * so the overworld looks like the games: gym leaders, the Elite Four, champions,
 * every villain team (Rocket / Magma / Aqua) grunt→admin→boss, professors, the
 * player protagonists (Red, Leaf, Brendan, May, Wally) and dozens of civilian
 * trainer classes — plus a few townsfolk (Nurse Joy, …) that only exist as
 * overworld sprites, normalised to the same 64×64 framing.
 *
 * Everything is a 64×64 colour sprite so trainers/NPCs read uniformly beside the
 * front-facing Pokémon battle sprites. Output → assets/trainers/<key>.png with an
 * index.json the game & pack builder read. Re-runnable and incremental.
 *
 * Sources (authoritative game data, enumerated from each project's own source
 * headers so nothing is guessed):
 *   - pret/pokefirered  graphics/trainers/front_pics/*   (Kanto FRLG + RS variants)
 *   - pret/pokeemerald   graphics/object_events/pics/people/*  (overworld townsfolk)
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PNG } from "pngjs";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "assets", "trainers");
const TMP = path.join(ROOT, ".trainer-tmp");

const FR = "https://raw.githubusercontent.com/pret/pokefirered/master";
const EM = "https://raw.githubusercontent.com/pret/pokeemerald/master";

/** Download a URL to a file with curl; returns true on a 200 with bytes. */
async function download(url, dest) {
  try {
    const { stdout } = await run(
      "curl",
      ["-sSL", "--max-time", "30", "-w", "%{http_code} %{size_download}", "-o", dest, url],
      { maxBuffer: 1 << 20 }
    );
    const [code, size] = stdout.trim().split(/\s+/);
    if (code === "200" && Number(size) > 0) return true;
    await fs.rm(dest, { force: true });
    return false;
  } catch { await fs.rm(dest, { force: true }).catch(() => {}); return false; }
}

/** Fetch a text file into a string (or "" on failure). */
async function fetchText(url) {
  const tmp = path.join(TMP, `t_${Math.random().toString(36).slice(2)}.txt`);
  if (!(await download(url, tmp))) return "";
  const txt = await fs.readFile(tmp, "utf8").catch(() => "");
  await fs.rm(tmp, { force: true }).catch(() => {});
  return txt;
}

/**
 * Enumerate every FireRed trainer front-pic filename from the project's own
 * source header — no hard-coded guessing. Returns [{ key, url }].
 */
async function firedRedFrontPics() {
  const h = await fetchText(`${FR}/src/data/graphics/trainers.h`);
  const names = [...new Set([...h.matchAll(/front_pics\/([a-z0-9_]+)\.4bpp/g)].map((m) => m[1]))];
  return names.map((file) => ({
    key: file.replace(/_front_pic$/, ""),                     // clean id
    url: `${FR}/graphics/trainers/front_pics/${file}.png`,
  }));
}

// Overworld townsfolk that have no battle front-pic (nurse, etc.). Their sheets
// are horizontal strips of 16×32 frames; we take frame 0 (facing the camera),
// scale ×2 and pad to a centred 64×64 so they share the trainers' framing.
const OVERWORLD = [
  { key: "nurse",    url: `${EM}/graphics/object_events/pics/people/nurse.png` },
  { key: "policeman", url: `${FR}/graphics/object_events/pics/people/policeman.png` },
  { key: "old_man",  url: `${EM}/graphics/object_events/pics/people/old_man.png` },
  { key: "mart_clerk", url: `${EM}/graphics/object_events/pics/people/mart_employee.png` },
  { key: "mom",      url: `${EM}/graphics/object_events/pics/people/mom.png` },
  { key: "old_woman", url: `${EM}/graphics/object_events/pics/people/old_woman.png` },
  { key: "little_boy", url: `${EM}/graphics/object_events/pics/people/little_boy.png` },
  { key: "little_girl", url: `${EM}/graphics/object_events/pics/people/little_girl.png` },
  { key: "cook",     url: `${EM}/graphics/object_events/pics/people/cook.png` },
  { key: "reporter_f", url: `${EM}/graphics/object_events/pics/people/reporter_f.png` },
  { key: "reporter_m", url: `${EM}/graphics/object_events/pics/people/reporter_m.png` },
];

/** Nearest-neighbour ×2 of the first 16×32 frame, padded into a 64×64 canvas. */
function padOverworld(srcPng) {
  const fw = 16, fh = 32;                       // standard people frame
  const out = new PNG({ width: 64, height: 64, colorType: 6 });
  out.data.fill(0);                             // transparent
  const dx = (64 - fw * 2) >> 1;                // centre horizontally (=16)
  const dy = 0;
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      // guard against sprites narrower/shorter than one frame
      if (x >= srcPng.width || y >= srcPng.height) continue;
      const si = (srcPng.width * y + x) << 2;
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const oy = dy + y * 2 + sy, ox = dx + x * 2 + sx;
          const di = (64 * oy + ox) << 2;
          out.data[di] = srcPng.data[si];
          out.data[di + 1] = srcPng.data[si + 1];
          out.data[di + 2] = srcPng.data[si + 2];
          out.data[di + 3] = srcPng.data[si + 3];
        }
      }
    }
  }
  return PNG.sync.write(out);
}

async function buildOverworld(key, url) {
  const dest = path.join(OUT, `${key}.png`);
  if (existsSync(dest)) return true;
  const raw = path.join(TMP, `ow_${key}.png`);
  if (!(await download(url, raw))) return false;
  try {
    const src = PNG.sync.read(await fs.readFile(raw));
    await fs.writeFile(dest, padOverworld(src));
    return true;
  } catch (e) {
    console.warn(`  ! could not process overworld ${key}: ${e.message}`);
    return false;
  } finally {
    await fs.rm(raw, { force: true }).catch(() => {});
  }
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  await fs.mkdir(TMP, { recursive: true });

  const front = await firedRedFrontPics();
  if (!front.length) {
    console.error("Could not enumerate FireRed front pics — network blocked?");
    process.exitCode = 1; return;
  }
  console.log(`Fetching ${front.length} trainer front sprites + ${OVERWORLD.length} overworld NPCs…`);

  const have = [];
  let got = 0, miss = 0;

  // Battle front pics (64×64 colour) — the uniform set.
  const BATCH = 16;
  for (let i = 0; i < front.length; i += BATCH) {
    await Promise.all(front.slice(i, i + BATCH).map(async ({ key, url }) => {
      const dest = path.join(OUT, `${key}.png`);
      if (existsSync(dest)) { have.push(key); got++; return; }
      if (await download(url, dest)) { have.push(key); got++; }
      else miss++;
    }));
    process.stdout.write(`\r  ${Math.min(i + BATCH, front.length)}/${front.length}`);
  }

  // Overworld-only townsfolk, normalised to 64×64.
  for (const { key, url } of OVERWORLD) {
    if (await buildOverworld(key, url)) { have.push(key); got++; } else miss++;
  }

  have.sort();
  await fs.writeFile(path.join(OUT, "index.json"), JSON.stringify({
    base: "systems/pokemon-masters/assets/trainers/",
    files: have,
  }));
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
  console.log(`\nDone — ${got} sprites (${miss} missing). Wrote assets/trainers/index.json (${have.length} keys).`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
