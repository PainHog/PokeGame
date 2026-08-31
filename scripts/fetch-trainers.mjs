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
const CR = "https://raw.githubusercontent.com/pret/pokecrystal/master"; // Gen-2 = Johto

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
  // Professor Birch has no battle front-pic; his overworld sprite is the real
  // Birch (Hoenn), so he no longer falls back to Professor Oak's portrait.
  { key: "professor_birch", url: `${EM}/graphics/object_events/pics/people/prof_birch.png` },
];

// Johto's League has no Gen-3 front-pics; pret/pokecrystal ships each trainer
// class as a full-colour (GBC 4-shade) battle sprite. These are the ONLY real
// portraits reachable for Johto's leaders + Will/Karen, so we vendor them and
// normalise (white background → transparent, centred in a 64×64 frame) so they
// read beside the Gen-3 sprites instead of a generic stand-in. The `cls` is the
// trainer-class filename in pokecrystal/gfx/trainers/.
const POKECRYSTAL = [
  { key: "leader_falkner",  cls: "falkner" }, { key: "leader_bugsy",  cls: "bugsy" },
  { key: "leader_whitney",  cls: "whitney" }, { key: "leader_morty",  cls: "morty" },
  { key: "leader_chuck",    cls: "chuck" },   { key: "leader_jasmine", cls: "jasmine" },
  { key: "leader_pryce",    cls: "pryce" },   { key: "leader_clair",  cls: "clair" },
  { key: "elite_four_will", cls: "will" },    { key: "elite_four_karen", cls: "karen" },
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

/**
 * Gen-2 (GBC) trainer sprites are 56×56 with an opaque white background (the
 * lightest palette shade). Foundry tokens want transparency, and the Gen-3
 * sprites are 64×64 & transparent, so: flood-fill the white background from the
 * border to transparent (interior white highlights, being enclosed, survive)
 * and centre the 56×56 art in a 64×64 canvas so it reads uniformly beside them.
 */
function normaliseGbc(srcPng) {
  const W = srcPng.width, H = srcPng.height, d = srcPng.data;
  const isWhite = (i) => d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245;
  const stack = [];
  for (let x = 0; x < W; x++) { stack.push([x, 0], [x, H - 1]); }
  for (let y = 0; y < H; y++) { stack.push([0, y], [W - 1, y]); }
  const seen = new Uint8Array(W * H);
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const p = y * W + x;
    if (seen[p]) continue;
    seen[p] = 1;
    const i = p << 2;
    if (!isWhite(i)) continue;
    d[i + 3] = 0;                                 // border-connected white → transparent
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  const out = new PNG({ width: 64, height: 64, colorType: 6 });
  out.data.fill(0);
  const dx = (64 - W) >> 1, dy = (64 - H) >> 1;   // centre the art
  for (let y = 0; y < H && y + dy < 64; y++) {
    for (let x = 0; x < W && x + dx < 64; x++) {
      const si = (W * y + x) << 2, oi = (64 * (y + dy) + (x + dx)) << 2;
      out.data[oi] = d[si]; out.data[oi + 1] = d[si + 1];
      out.data[oi + 2] = d[si + 2]; out.data[oi + 3] = d[si + 3];
    }
  }
  return PNG.sync.write(out);
}

async function buildGbc(key, cls) {
  const dest = path.join(OUT, `${key}.png`);
  if (existsSync(dest)) return true;
  const raw = path.join(TMP, `cr_${key}.png`);
  if (!(await download(`${CR}/gfx/trainers/${cls}.png`, raw))) return false;
  try {
    await fs.writeFile(dest, normaliseGbc(PNG.sync.read(await fs.readFile(raw))));
    return true;
  } catch (e) {
    console.warn(`  ! could not process gen-2 ${key}: ${e.message}`);
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

  // Johto (Gen-2) League portraits — the only real ones reachable for them.
  for (const { key, cls } of POKECRYSTAL) {
    if (await buildGbc(key, cls)) { have.push(key); got++; } else miss++;
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
