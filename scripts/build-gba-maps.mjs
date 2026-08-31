/**
 * Pokémon Masters — authentic Gen-3 (FireRed) map renderer.
 *
 *   npm run gbamaps            (renders configured maps to assets/maps/<key>.webp)
 *
 * Composites real FireRed overworld maps from the open pret/pokefirered decomp:
 * fetches each map's blockdata (metatile grid) + its primary/secondary tilesets
 * (tiles.png, metatiles.bin, JASC palettes) and draws every 16×16 metatile
 * (bottom + top 8×8 tile layers, per-tile palette & flip) into a full map image,
 * exactly as the GBA renders it. Output is a PNG that `rasterize-maps` / the
 * build convert to the WebP the scenes use.
 *
 * FRLG tileset split: 640 tiles / 640 metatiles in the primary; palettes 0-6
 * primary, 7+ secondary.
 *
 * Source: github.com/pret/pokefirered (disassembly; tile art © Nintendo/GF — same
 * open-decomp source as the sprites, vendored for this fan project).
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PNG } from "pngjs";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "assets", "maps");
const FR = "https://raw.githubusercontent.com/pret/pokefirered/master";
const NUM_TILES_PRIMARY = 640, NUM_METATILES_PRIMARY = 640, NUM_PALS_PRIMARY = 7;

/** Our scene name → FireRed layout directory (under data/layouts/<dir>/map.bin). */
const KANTO = {
  "Pallet Town": "PalletTown", "Viridian City": "ViridianCity", "Pewter City": "PewterCity",
  "Cerulean City": "CeruleanCity", "Vermilion City": "VermilionCity", "Lavender Town": "LavenderTown",
  "Celadon City": "CeladonCity", "Fuchsia City": "FuchsiaCity", "Saffron City": "SaffronCity",
  "Cinnabar Island": "CinnabarIsland", "Indigo Plateau": "IndigoPlateau_Exterior",
  "Route 1": "Route1", "Route 2": "Route2", "Route 3": "Route3", "Route 4": "Route4",
  "Route 22": "Route22", "Route 24": "Route24", "Route 25": "Route25",
  "Viridian Forest": "ViridianForest",
};

const httpsAgent = process.env.HTTPS_PROXY ? undefined : undefined;
async function download(url, dest) {
  const { stdout } = await run("curl", ["-sSL", "--max-time", "40", "-w", "%{http_code}", "-o", dest, url], { maxBuffer: 1 << 20 });
  return stdout.trim() === "200" && existsSync(dest);
}
async function fetchBuf(url) {
  const tmp = path.join(os.tmpdir(), `gba_${Math.random().toString(36).slice(2)}`);
  if (!(await download(url, tmp))) throw new Error(`fetch failed: ${url}`);
  const b = await fs.readFile(tmp); await fs.rm(tmp, { force: true }); return b;
}
async function fetchText(url) { return (await fetchBuf(url)).toString("utf8"); }

/** Parse a JASC-PAL into 16 [r,g,b]. */
function parsePal(text) {
  const lines = text.split(/\r?\n/).slice(3); // skip "JASC-PAL", "0100", count
  const pal = [];
  for (const l of lines) { const m = l.trim().split(/\s+/).map(Number); if (m.length >= 3 && m.every((n) => !isNaN(n))) pal.push([m[0], m[1], m[2]]); if (pal.length === 16) break; }
  while (pal.length < 16) pal.push([0, 0, 0]);
  return pal;
}

/** Decode an indexed tiles.png into a flat Uint8Array of palette indices (0-15). */
function decodeTileIndices(png) {
  const { width, height, data, palette } = png;
  const rev = new Map();
  (palette ?? []).forEach((c, i) => rev.set(`${c[0]},${c[1]},${c[2]}`, i));
  const idx = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const o = p << 2;
    idx[p] = rev.get(`${data[o]},${data[o + 1]},${data[o + 2]}`) ?? 0;
  }
  return { width, height, idx };
}

/** Load a tileset: tiles (indices), metatiles.bin, and its palette files. */
async function loadTileset(gName, primary) {
  const dir = `${FR}/data/tilesets/${primary ? "primary" : "secondary"}/${tilesetDir(gName)}`;
  const tilesPng = PNG.sync.read(await fetchBuf(`${dir}/tiles.png`));
  const tiles = decodeTileIndices(tilesPng);
  const metatiles = new Uint16Array((await fetchBuf(`${dir}/metatiles.bin`)).buffer.slice(0));
  const palettes = {};
  const lo = primary ? 0 : NUM_PALS_PRIMARY, hi = primary ? NUM_PALS_PRIMARY : 13;
  for (let i = lo; i < hi; i++) {
    const f = String(i).padStart(2, "0");
    try { palettes[i] = parsePal(await fetchText(`${dir}/palettes/${f}.pal`)); } catch { /* not all exist */ }
  }
  return { tiles, metatiles, palettes, tilesPerRow: tiles.width >> 3 };
}
/** gTileset_General → general ; gTileset_PalletTown → pallet_town (snake_case dir). */
function tilesetDir(gName) {
  return gName.replace(/^gTileset_/, "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
}

/** One 8×8 tile's index at (x,y) from a tileset's tile sheet. */
function tilePixel(ts, tileId, x, y) {
  const tr = Math.floor(tileId / ts.tilesPerRow), tc = tileId % ts.tilesPerRow;
  return ts.tiles.idx[(tr * 8 + y) * ts.tiles.width + (tc * 8 + x)];
}

/** Draw metatile `mtId` (from primary or secondary) into out at (ox,oy). */
function drawMetatile(out, ow, ox, oy, mtId, prim, sec) {
  const local = mtId < NUM_METATILES_PRIMARY ? mtId : mtId - NUM_METATILES_PRIMARY;
  const mtTs = mtId < NUM_METATILES_PRIMARY ? prim : sec;
  const base = local * 8; // 8 u16 entries per metatile
  for (let layer = 0; layer < 2; layer++) {
    for (let sub = 0; sub < 4; sub++) {
      const entry = mtTs.metatiles[base + layer * 4 + sub];
      if (entry === undefined) continue;
      const tileId = entry & 0x3FF, hflip = entry & 0x400, vflip = entry & 0x800, pal = (entry >> 12) & 0xF;
      const tileTs = tileId < NUM_TILES_PRIMARY ? prim : sec;
      const tId = tileId < NUM_TILES_PRIMARY ? tileId : tileId - NUM_TILES_PRIMARY;
      const colors = (pal < NUM_PALS_PRIMARY ? prim : sec).palettes[pal];
      if (!colors) continue;
      const sx0 = (sub & 1) * 8, sy0 = (sub >> 1) * 8;
      for (let py = 0; py < 8; py++) for (let px = 0; px < 8; px++) {
        const idx = tilePixel(tileTs, tId, hflip ? 7 - px : px, vflip ? 7 - py : py);
        if (layer === 1 && idx === 0) continue; // top layer: colour 0 is transparent
        const c = colors[idx];
        const o = ((oy + sy0 + py) * ow + (ox + sx0 + px)) << 2;
        out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
      }
    }
  }
}

async function renderMap(ourName, dirName, layouts) {
  const layout = layouts.find((l) => (l.blockdata_filepath || "").split("/")[2]?.toLowerCase() === dirName.toLowerCase());
  if (!layout) { console.warn(`  ! no layout for ${dirName}`); return false; }
  const w = layout.width, h = layout.height;
  const block = new Uint16Array((await fetchBuf(`${FR}/${layout.blockdata_filepath}`)).buffer.slice(0));
  const prim = await loadTileset(layout.primary_tileset, true);
  const sec = layout.secondary_tileset ? await loadTileset(layout.secondary_tileset, false) : { metatiles: new Uint16Array(0), palettes: {}, tiles: { idx: new Uint8Array(0), width: 0 }, tilesPerRow: 16 };
  const OW = w * 16, OH = h * 16;
  const png = new PNG({ width: OW, height: OH });
  png.data.fill(0);
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    const mtId = block[row * w + col] & 0x3FF;
    drawMetatile(png.data, OW, col * 16, row * 16, mtId, prim, sec);
  }
  const key = ourName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const dest = path.join(OUT, `${key}.png`);
  await fs.writeFile(dest, PNG.sync.write(png));
  console.log(`  ✓ ${ourName.padEnd(16)} ${OW}×${OH}  → ${key}.png`);
  return true;
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const only = process.argv.slice(2);
  const entries = Object.entries(KANTO).filter(([n]) => !only.length || only.includes(n));
  console.log(`Fetching FireRed layouts…`);
  const layouts = JSON.parse(await fetchText(`${FR}/data/layouts/layouts.json`)).layouts.filter(Boolean);
  console.log(`Rendering ${entries.length} authentic Gen-3 maps…`);
  let ok = 0;
  for (const [ourName, dirName] of entries) {
    try { if (await renderMap(ourName, dirName, layouts)) ok++; }
    catch (e) { console.warn(`  ! ${ourName}: ${e.message}`); }
  }
  console.log(`Done — ${ok}/${entries.length} rendered.`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
