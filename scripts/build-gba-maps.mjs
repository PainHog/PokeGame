/**
 * Pokémon Masters — authentic Gen-3 (FireRed) map renderer + metadata.
 *
 *   npm run gbamaps            (render configured maps + emit metadata)
 *   npm run gbamaps "Route 1"  (a single map)
 *
 * Composites real FireRed overworld maps from the open pret/pokefirered decomp:
 * for each map it fetches the blockdata (metatile grid) + its primary/secondary
 * tilesets (tiles.png, metatiles.bin, metatile_attributes.bin, JASC palettes),
 * draws every 16×16 metatile (bottom + top 8×8 tile layers, per-tile palette &
 * flip) exactly as the GBA renders it, upscales ×SCALE for crisp pixels at a
 * Foundry-friendly grid, and encodes WebP. It also reads each map's warps, map
 * connections and tall-grass tiles and writes assets/maps/gba-<region>.json so
 * the scene builder can place the walk-in doors, edge exits and wild-grass zones
 * at their REAL positions.
 *
 * FRLG split: 640 tiles / 640 metatiles primary; palettes 0-6 primary, 7+ secondary.
 * Source: github.com/pret/pokefirered (open decomp; tile art © Nintendo/GF, same
 * source as the sprites — vendored for this fan project).
 */

import { promises as fs } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { chromium } from "playwright-core";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "assets", "maps");
const FR = "https://raw.githubusercontent.com/pret/pokefirered/master";
const NUM_TILES_PRIMARY = 640, NUM_METATILES_PRIMARY = 640, NUM_PALS_PRIMARY = 7;
const SCALE = 2;                 // native 16px metatile → 32px on the Foundry grid
const GRID = 16 * SCALE;         // 32
const MB_TALL_GRASS = 0x02;      // metatile behaviour for tall grass

// Our scene name → FireRed map/layout dir + our region kind. The kind drives the
// wild-encounter category the scene builder assigns.
const KANTO = {
  "Pallet Town": ["PalletTown", "town"], "Viridian City": ["ViridianCity", "town"],
  "Pewter City": ["PewterCity", "town"], "Cerulean City": ["CeruleanCity", "town"],
  "Vermilion City": ["VermilionCity", "town"], "Lavender Town": ["LavenderTown", "town"],
  "Celadon City": ["CeladonCity", "town"], "Fuchsia City": ["FuchsiaCity", "town"],
  "Saffron City": ["SaffronCity", "town"], "Cinnabar Island": ["CinnabarIsland", "town"],
  "Indigo Plateau": ["IndigoPlateau_Exterior", "town"],
  "Viridian Forest": ["ViridianForest", "forest"],
  "Route 1": ["Route1", "route"], "Route 2": ["Route2", "route"], "Route 3": ["Route3", "route"],
  "Route 4": ["Route4", "route"], "Route 5": ["Route5", "route"], "Route 6": ["Route6", "route"],
  "Route 7": ["Route7", "route"], "Route 8": ["Route8", "route"], "Route 9": ["Route9", "route"],
  "Route 10": ["Route10", "route"], "Route 11": ["Route11", "route"], "Route 12": ["Route12", "route"],
  "Route 13": ["Route13", "route"], "Route 14": ["Route14", "route"], "Route 15": ["Route15", "route"],
  "Route 16": ["Route16", "route"], "Route 17": ["Route17", "route"], "Route 18": ["Route18", "route"],
  "Route 19": ["Route19", "route"], "Route 20": ["Route20", "route"], "Route 21": ["Route21_Sea", "route"],
  "Route 22": ["Route22", "route"], "Route 23": ["Route23", "route"], "Route 24": ["Route24", "route"],
  "Route 25": ["Route25", "route"],
};

async function download(url, dest) {
  try {
    const { stdout } = await run("curl", ["-sSL", "--max-time", "40", "-w", "%{http_code}", "-o", dest, url], { maxBuffer: 1 << 20 });
    return stdout.trim() === "200" && existsSync(dest);
  } catch { return false; }
}
async function fetchBuf(url) {
  const tmp = path.join(os.tmpdir(), `gba_${Math.random().toString(36).slice(2)}`);
  if (!(await download(url, tmp))) throw new Error(`fetch failed: ${url}`);
  const b = await fs.readFile(tmp); await fs.rm(tmp, { force: true }); return b;
}
const fetchText = async (u) => (await fetchBuf(u)).toString("utf8");
async function fetchJson(u) { try { return JSON.parse(await fetchText(u)); } catch { return null; } }

function parsePal(text) {
  const pal = [];
  for (const l of text.split(/\r?\n/).slice(3)) { const m = l.trim().split(/\s+/).map(Number); if (m.length >= 3 && m.slice(0, 3).every((n) => !isNaN(n))) pal.push([m[0], m[1], m[2]]); if (pal.length === 16) break; }
  while (pal.length < 16) pal.push([0, 0, 0]);
  return pal;
}
function decodeTileIndices(png) {
  const { width, height, data, palette } = png;
  const rev = new Map();
  (palette ?? []).forEach((c, i) => rev.set(`${c[0]},${c[1]},${c[2]}`, i));
  const idx = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) { const o = p << 2; idx[p] = rev.get(`${data[o]},${data[o + 1]},${data[o + 2]}`) ?? 0; }
  return { width, height, idx };
}
function tilesetDir(gName) {
  return gName.replace(/^gTileset_/, "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
}
async function loadTileset(gName, primary) {
  const dir = `${FR}/data/tilesets/${primary ? "primary" : "secondary"}/${tilesetDir(gName)}`;
  const tiles = decodeTileIndices(PNG.sync.read(await fetchBuf(`${dir}/tiles.png`)));
  const metatiles = new Uint16Array((await fetchBuf(`${dir}/metatiles.bin`)).buffer.slice(0));
  let attrs = new Uint32Array(0);
  try { attrs = new Uint32Array((await fetchBuf(`${dir}/metatile_attributes.bin`)).buffer.slice(0)); } catch { /* optional */ }
  const palettes = {};
  const lo = primary ? 0 : NUM_PALS_PRIMARY, hi = primary ? NUM_PALS_PRIMARY : 13;
  for (let i = lo; i < hi; i++) { try { palettes[i] = parsePal(await fetchText(`${dir}/palettes/${String(i).padStart(2, "0")}.pal`)); } catch { /* not all exist */ } }
  return { tiles, metatiles, attrs, palettes, tilesPerRow: tiles.width >> 3 };
}
function tilePixel(ts, tileId, x, y) {
  const tr = Math.floor(tileId / ts.tilesPerRow), tc = tileId % ts.tilesPerRow;
  return ts.tiles.idx[(tr * 8 + y) * ts.tiles.width + (tc * 8 + x)];
}
/** Behaviour byte of a metatile (for grass detection). */
function behaviour(mtId, prim, sec) {
  const ts = mtId < NUM_METATILES_PRIMARY ? prim : sec, local = mtId < NUM_METATILES_PRIMARY ? mtId : mtId - NUM_METATILES_PRIMARY;
  return (ts.attrs[local] ?? 0) & 0xFF;
}
function drawMetatile(out, ow, ox, oy, mtId, prim, sec) {
  const mtTs = mtId < NUM_METATILES_PRIMARY ? prim : sec, base = (mtId < NUM_METATILES_PRIMARY ? mtId : mtId - NUM_METATILES_PRIMARY) * 8;
  for (let layer = 0; layer < 2; layer++) for (let sub = 0; sub < 4; sub++) {
    const entry = mtTs.metatiles[base + layer * 4 + sub]; if (entry === undefined) continue;
    const tileId = entry & 0x3FF, hflip = entry & 0x400, vflip = entry & 0x800, pal = (entry >> 12) & 0xF;
    const tileTs = tileId < NUM_TILES_PRIMARY ? prim : sec, tId = tileId < NUM_TILES_PRIMARY ? tileId : tileId - NUM_TILES_PRIMARY;
    const colors = (pal < NUM_PALS_PRIMARY ? prim : sec).palettes[pal]; if (!colors) continue;
    const sx0 = (sub & 1) * 8, sy0 = (sub >> 1) * 8;
    for (let py = 0; py < 8; py++) for (let px = 0; px < 8; px++) {
      const idx = tilePixel(tileTs, tId, hflip ? 7 - px : px, vflip ? 7 - py : py);
      if (layer === 1 && idx === 0) continue;
      const c = colors[idx], o = ((oy + sy0 + py) * ow + (ox + sx0 + px)) << 2;
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
    }
  }
}
const key = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Encode a native-res PNG (upscaled ×SCALE, nearest) to a WebP via Chromium. */
function findChrome() { const base = "/opt/pw-browsers"; for (const d of readdirSync(base)) { if (d.startsWith("chromium-")) { const p = path.join(base, d, "chrome-linux", "chrome"); if (existsSync(p)) return p; } } return null; }

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const only = process.argv.slice(2);
  const entries = Object.entries(KANTO).filter(([n]) => !only.length || only.includes(n));
  const layouts = (await fetchJson(`${FR}/data/layouts/layouts.json`))?.layouts.filter(Boolean) ?? [];
  console.log(`Rendering ${entries.length} authentic Gen-3 maps (×${SCALE})…`);
  const exe = findChrome();
  const browser = await chromium.launch(exe ? { executablePath: exe, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const tilesetCache = new Map();
  const loadTs = async (name, primary) => { if (!tilesetCache.has(name)) tilesetCache.set(name, await loadTileset(name, primary)); return tilesetCache.get(name); };
  const meta = {};
  let ok = 0;

  for (const [ourName, [dir, kind]] of entries) {
    try {
      const layout = layouts.find((l) => (l.blockdata_filepath || "").split("/")[2]?.toLowerCase() === dir.toLowerCase());
      if (!layout) { console.warn(`  ! no layout for ${dir}`); continue; }
      const w = layout.width, h = layout.height;
      const block = new Uint16Array((await fetchBuf(`${FR}/${layout.blockdata_filepath}`)).buffer.slice(0));
      const prim = await loadTs(layout.primary_tileset, true);
      const sec = layout.secondary_tileset ? await loadTs(layout.secondary_tileset, false) : { metatiles: new Uint16Array(0), attrs: new Uint32Array(0), palettes: {}, tiles: { idx: new Uint8Array(0), width: 0 }, tilesPerRow: 16 };
      const OW = w * 16, OH = h * 16, png = new PNG({ width: OW, height: OH });
      png.data.fill(0);
      const grass = [];
      for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
        const mtId = block[row * w + col] & 0x3FF;
        drawMetatile(png.data, OW, col * 16, row * 16, mtId, prim, sec);
        if (behaviour(mtId, prim, sec) === MB_TALL_GRASS) grass.push([col, row]);
      }
      // Warps + connections from the map header (best-effort; dir==map dir).
      const mapJson = await fetchJson(`${FR}/data/maps/${dir}/map.json`);
      const warps = (mapJson?.warp_events ?? []).map((wv) => ({ x: wv.x, y: wv.y, dest: wv.dest_map }));
      const conns = (mapJson?.connections ?? []).map((c) => ({ dir: c.direction, map: c.map, offset: c.offset }));
      // Grass bounding box (a single wild-zone rectangle in grid units).
      let gb = null;
      if (grass.length) { const xs = grass.map((g) => g[0]), ys = grass.map((g) => g[1]); gb = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1 }; }
      meta[key(ourName)] = { name: ourName, kind, w, h, grid: GRID, warps, connections: conns, grass: gb };

      // Upscale ×SCALE (nearest) and encode WebP via Chromium.
      const b64 = PNG.sync.write(png).toString("base64");
      const url = await page.evaluate(async ({ b64, W, H, S }) => {
        const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
        const c = document.createElement("canvas"); c.width = W * S; c.height = H * S;
        const ctx = c.getContext("2d"); ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 0, 0, W * S, H * S);
        return c.toDataURL("image/webp", 0.9);
      }, { b64, W: OW, H: OH, S: SCALE });
      await fs.writeFile(path.join(OUT, `${key(ourName)}.webp`), Buffer.from(url.split(",")[1], "base64"));
      console.log(`  ✓ ${ourName.padEnd(16)} ${OW * SCALE}×${OH * SCALE}  warps:${warps.length} conns:${conns.length} grass:${grass.length}`);
      ok++;
    } catch (e) { console.warn(`  ! ${ourName}: ${e.message}`); }
  }
  await browser.close();
  await fs.writeFile(path.join(OUT, "gba-kanto.json"), JSON.stringify(meta, null, 1));
  console.log(`Done — ${ok}/${entries.length} rendered. Wrote assets/maps/gba-kanto.json.`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
