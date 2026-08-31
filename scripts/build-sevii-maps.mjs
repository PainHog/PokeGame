/**
 * Pokémon Masters — authentic Gen-3 (FireRed) Sevii Islands + Kanto cave renderer.
 *
 *   npm run seviimaps            (render configured maps + emit metadata)
 *   npm run seviimaps "Mt. Moon"  (a single map)
 *
 * Sibling of build-gba-maps.mjs: same compositing pipeline (per-metatile bottom +
 * top 8×8 tile layers, per-tile palette & flip, ×SCALE nearest upscale, WebP), but
 * targets the Sevii Islands post-game archipelago plus the Kanto caves/dungeons.
 *
 * Each of our scene names maps to a pret/pokefirered map dir. We read that map's
 * map.json to learn its `layout` id, then resolve the layout (dimensions, blockdata,
 * primary/secondary tilesets) from data/layouts/layouts.json by id — robust across
 * the Sevii maps where the map dir and layout dir names diverge. Warps, map
 * connections and wild-grass tiles (tall grass 0x02 AND long grass 0x03) come out at
 * their real positions so the scene builder can place doors, edge exits and wild
 * zones authentically.
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
const MB_TALL_GRASS = 0x02;      // metatile behaviour for tall grass (wild zone)
const MB_LONG_GRASS = 0x03;      // metatile behaviour for long grass (also a wild zone)

// Our scene name → [FireRed MAP dir, our region kind]. The kind drives the wild-
// encounter category the scene builder assigns. Sevii mountains/rock islands
// (Mt. Ember, Navel Rock) are treated as "cave"; outdoor beaches/paths/bridges/
// canyons/meadows/resorts as "route"; the wooded mazes as "forest"; the seven
// numbered island towns (each with a Pokémon Center) as "town".
const SCENES = {
  // Sevii Islands — numbered island towns
  "One Island": ["OneIsland", "town"],
  "Two Island": ["TwoIsland", "town"],
  "Three Island": ["ThreeIsland", "town"],
  "Four Island": ["FourIsland", "town"],
  "Five Island": ["FiveIsland", "town"],
  "Six Island": ["SixIsland", "town"],
  "Seven Island": ["SevenIsland", "town"],
  // Sevii Islands — outdoor routes / areas
  "Kindle Road": ["OneIsland_KindleRoad", "route"],
  "Mt. Ember": ["MtEmber_Exterior", "cave"],
  "Cape Brink": ["TwoIsland_CapeBrink", "route"],
  "Treasure Beach": ["OneIsland_TreasureBeach", "route"],
  "Bond Bridge": ["ThreeIsland_BondBridge", "route"],
  "Berry Forest": ["ThreeIsland_BerryForest", "forest"],
  "Five Isle Meadow": ["FiveIsland_Meadow", "route"],
  "Water Path": ["SixIsland_WaterPath", "route"],
  "Green Path": ["SixIsland_GreenPath", "route"],
  "Pattern Bush": ["SixIsland_PatternBush", "forest"],
  "Ruin Valley": ["SixIsland_RuinValley", "route"],
  "Sevault Canyon": ["SevenIsland_SevaultCanyon", "route"],
  "Tanoby Ruins": ["SevenIsland_TanobyRuins", "route"],
  "Trainer Tower": ["SevenIsland_TrainerTower", "route"],
  "Navel Rock": ["NavelRock_Exterior", "cave"],
  "Birth Island": ["BirthIsland_Exterior", "route"],
  "Lost Cave": ["FiveIsland_LostCave_Entrance", "cave"],
  "Icefall Cave": ["FourIsland_IcefallCave_1F", "cave"],
  "Altering Cave": ["SixIsland_AlteringCave", "cave"],
  "Resort Gorgeous": ["FiveIsland_ResortGorgeous", "route"],
  // Kanto caves / dungeons (render the entrance / primary floor)
  "Mt. Moon": ["MtMoon_1F", "cave"],
  "Rock Tunnel": ["RockTunnel_1F", "cave"],
  "Cerulean Cave": ["CeruleanCave_1F", "cave"],
  "Seafoam Islands": ["SeafoamIslands_1F", "cave"],
  "Diglett's Cave": ["DiglettsCave_B1F", "cave"],
  "Victory Road": ["VictoryRoad_1F", "cave"],
  "Power Plant": ["PowerPlant", "cave"],
  "S.S. Anne": ["SSAnne_Exterior", "route"],
  "Kanto Safari Zone": ["SafariZone_Center", "route"],
};

async function download(url, dest) {
  try {
    const { stdout } = await run("curl", ["-sSL", "--max-time", "40", "-w", "%{http_code}", "-o", dest, url], { maxBuffer: 1 << 20 });
    return stdout.trim() === "200" && existsSync(dest);
  } catch { return false; }
}
async function fetchBuf(url) {
  const tmp = path.join(os.tmpdir(), `sevii_${Math.random().toString(36).slice(2)}`);
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
// gTileset_SeviiIslands123 → sevii_islands_123 (case boundaries AND letter→digit).
function tilesetDir(gName) {
  return gName.replace(/^gTileset_/, "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").replace(/([A-Za-z])([0-9])/g, "$1_$2").toLowerCase();
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

/** Locate the bundled Chromium for the WebP encode step. */
function findChrome() { const base = "/opt/pw-browsers"; for (const d of readdirSync(base)) { if (d.startsWith("chromium-")) { const p = path.join(base, d, "chrome-linux", "chrome"); if (existsSync(p)) return p; } } return null; }

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const only = process.argv.slice(2);
  const entries = Object.entries(SCENES).filter(([n]) => !only.length || only.includes(n));
  const layouts = (await fetchJson(`${FR}/data/layouts/layouts.json`))?.layouts.filter(Boolean) ?? [];
  const byId = new Map(layouts.map((l) => [l.id, l]));
  console.log(`Rendering ${entries.length} authentic Gen-3 Sevii/Kanto maps (×${SCALE})…`);
  const exe = findChrome();
  const browser = await chromium.launch(exe ? { executablePath: exe, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const tilesetCache = new Map();
  const loadTs = async (name, primary) => { if (!tilesetCache.has(name)) tilesetCache.set(name, await loadTileset(name, primary)); return tilesetCache.get(name); };
  const meta = {};
  const skipped = [];
  let ok = 0;

  for (const [ourName, [dir, kind]] of entries) {
    try {
      // Map dir → its layout id → the layout record (robust where dir≠layout name).
      const mapJson = await fetchJson(`${FR}/data/maps/${dir}/map.json`);
      if (!mapJson) { console.warn(`  ! no map.json for ${dir}`); skipped.push([ourName, `no map.json (${dir})`]); continue; }
      const layout = byId.get(mapJson.layout);
      if (!layout) { console.warn(`  ! no layout ${mapJson.layout} for ${dir}`); skipped.push([ourName, `layout ${mapJson.layout} missing`]); continue; }
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
        const b = behaviour(mtId, prim, sec);
        if (b === MB_TALL_GRASS || b === MB_LONG_GRASS) grass.push([col, row]);
      }
      // Warps + connections from the map header.
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
      console.log(`  ✓ ${ourName.padEnd(18)} ${OW * SCALE}×${OH * SCALE}  warps:${warps.length} conns:${conns.length} grass:${grass.length}`);
      ok++;
    } catch (e) { console.warn(`  ! ${ourName}: ${e.message}`); skipped.push([ourName, e.message]); }
  }
  await browser.close();
  await fs.writeFile(path.join(OUT, "gba-sevii.json"), JSON.stringify(meta, null, 1));
  console.log(`Done — ${ok}/${entries.length} rendered. Wrote assets/maps/gba-sevii.json.`);
  if (skipped.length) { console.log("Skipped:"); for (const [n, why] of skipped) console.log(`  - ${n}: ${why}`); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
