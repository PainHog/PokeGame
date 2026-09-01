/**
 * Pokémon Masters — authentic Gen-3 (Emerald / Hoenn) map renderer + metadata.
 *
 *   node scripts/build-emerald-maps.mjs                 (render all Hoenn maps + metadata)
 *   node scripts/build-emerald-maps.mjs "Route 101"     (a single map)
 *
 * Sibling of build-gba-maps.mjs (FireRed/Kanto). Composites real Hoenn overworld
 * maps from the open pret/pokeemerald decomp: for each map it fetches the blockdata
 * (metatile grid) + its primary/secondary tilesets (tiles.png, metatiles.bin,
 * metatile_attributes.bin, JASC palettes), draws every 16×16 metatile (bottom + top
 * 8×8 tile layers, per-tile palette & flip) exactly as the GBA renders it, upscales
 * ×SCALE for crisp pixels at a Foundry-friendly grid, and encodes WebP. It also reads
 * each map's warps, map connections and tall-grass tiles and writes
 * assets/maps/gba-hoenn.json so the scene builder can place the walk-in doors, edge
 * exits and wild-grass zones at their REAL positions.
 *
 * RSE split (verified against the actual files, differs from FRLG):
 *   NUM_TILES_IN_PRIMARY=512, NUM_METATILES_IN_PRIMARY=512, NUM_PALS_IN_PRIMARY=6.
 *   tiles.png primary = 128×256 (512 tiles); metatiles.bin = 512×16 = 8192 bytes;
 *   metatile_attributes.bin is u16 (2 bytes/metatile), behaviour = low byte
 *   (METATILE_ATTR_BEHAVIOR_MASK = 0x00FF). Palettes 0-5 primary, 6-12 secondary.
 * Source: github.com/pret/pokeemerald (open decomp; tile art © Nintendo/GF, same
 * source as the sprites — vendored for this fan project).
 */

import { promises as fs } from "node:fs";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
const EM = "https://raw.githubusercontent.com/pret/pokeemerald/master";
// RSE split — 512 tiles / 512 metatiles primary; palettes 0-5 primary, 6-12 secondary.
const NUM_TILES_PRIMARY = 512, NUM_METATILES_PRIMARY = 512, NUM_PALS_PRIMARY = 6;
const SCALE = 2;                 // native 16px metatile → 32px on the Foundry grid
const GRID = 16 * SCALE;         // 32
const MB_TALL_GRASS = 0x02;      // metatile behaviour for tall grass (RSE enum: NORMAL,SECRET_BASE_WALL,TALL_GRASS,…)
const MB_LONG_GRASS = 0x03;      // waist-high grass — also a wild-encounter zone (Routes 119/120 use this, not 0x02)

// Our scene name → Emerald map/layout dir (CamelCase) + our region kind. The kind
// drives the wild-encounter category the scene builder assigns.
const HOENN = {
  "Littleroot Town": ["LittlerootTown", "town"], "Oldale Town": ["OldaleTown", "town"],
  "Petalburg City": ["PetalburgCity", "town"], "Rustboro City": ["RustboroCity", "town"],
  "Dewford Town": ["DewfordTown", "town"], "Slateport City": ["SlateportCity", "town"],
  "Mauville City": ["MauvilleCity", "town"], "Verdanturf Town": ["VerdanturfTown", "town"],
  "Fallarbor Town": ["FallarborTown", "town"], "Lavaridge Town": ["LavaridgeTown", "town"],
  "Fortree City": ["FortreeCity", "town"], "Lilycove City": ["LilycoveCity", "town"],
  "Mossdeep City": ["MossdeepCity", "town"], "Sootopolis City": ["SootopolisCity", "town"],
  "Pacifidlog Town": ["PacifidlogTown", "town"], "Ever Grande City": ["EverGrandeCity", "town"],
  "Petalburg Woods": ["PetalburgWoods", "forest"],
  "Route 101": ["Route101", "route"], "Route 102": ["Route102", "route"], "Route 103": ["Route103", "route"],
  "Route 104": ["Route104", "route"], "Route 105": ["Route105", "route"], "Route 106": ["Route106", "route"],
  "Route 107": ["Route107", "route"], "Route 108": ["Route108", "route"], "Route 109": ["Route109", "route"],
  "Route 110": ["Route110", "route"], "Route 111": ["Route111", "route"], "Route 112": ["Route112", "route"],
  "Route 113": ["Route113", "route"], "Route 114": ["Route114", "route"], "Route 115": ["Route115", "route"],
  "Route 116": ["Route116", "route"], "Route 117": ["Route117", "route"], "Route 118": ["Route118", "route"],
  "Route 119": ["Route119", "route"], "Route 120": ["Route120", "route"], "Route 121": ["Route121", "route"],
  "Route 122": ["Route122", "route"], "Route 123": ["Route123", "route"], "Route 124": ["Route124", "route"],
  "Route 125": ["Route125", "route"], "Route 126": ["Route126", "route"], "Route 127": ["Route127", "route"],
  "Route 128": ["Route128", "route"], "Route 129": ["Route129", "route"], "Route 130": ["Route130", "route"],
  "Route 131": ["Route131", "route"], "Route 132": ["Route132", "route"], "Route 133": ["Route133", "route"],
  "Route 134": ["Route134", "route"],
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
  const dir = `${EM}/data/tilesets/${primary ? "primary" : "secondary"}/${tilesetDir(gName)}`;
  const tiles = decodeTileIndices(PNG.sync.read(await fetchBuf(`${dir}/tiles.png`)));
  const metatiles = new Uint16Array((await fetchBuf(`${dir}/metatiles.bin`)).buffer.slice(0));
  // RSE metatile attributes are u16 (2 bytes each), not u32 like FRLG.
  let attrs = new Uint16Array(0);
  try { attrs = new Uint16Array((await fetchBuf(`${dir}/metatile_attributes.bin`)).buffer.slice(0)); } catch { /* optional */ }
  const palettes = {};
  const lo = primary ? 0 : NUM_PALS_PRIMARY, hi = primary ? NUM_PALS_PRIMARY : 13;
  for (let i = lo; i < hi; i++) { try { palettes[i] = parsePal(await fetchText(`${dir}/palettes/${String(i).padStart(2, "0")}.pal`)); } catch { /* not all exist */ } }
  return { tiles, metatiles, attrs, palettes, tilesPerRow: tiles.width >> 3 };
}
function tilePixel(ts, tileId, x, y) {
  const tr = Math.floor(tileId / ts.tilesPerRow), tc = tileId % ts.tilesPerRow;
  return ts.tiles.idx[(tr * 8 + y) * ts.tiles.width + (tc * 8 + x)];
}
/** Behaviour byte of a metatile (for grass detection). Low byte of the u16 attr. */
function behaviour(mtId, prim, sec) {
  const ts = mtId < NUM_METATILES_PRIMARY ? prim : sec, local = mtId < NUM_METATILES_PRIMARY ? mtId : mtId - NUM_METATILES_PRIMARY;
  return (ts.attrs[local] ?? 0) & 0xFF;
}
/**
 * Per-tile collision grid straight from the blockdata. Each block entry packs
 * the metatile id in bits 0-9, the authentic game COLLISION in bits 10-11
 * ((block>>10)&0x3; nonzero = impassable — buildings, trees, cliffs, water,
 * cave walls) and the elevation in bits 12-15 (ignored). Returns { w, h, rows }
 * with rows[ty][tx] === "1" for impassable tiles, matching the shape the
 * movement handler (src/module/controls.mjs) reads.
 */
function collisionGrid(block, w, h) {
  const rows = [];
  for (let r = 0; r < h; r++) { let s = ""; for (let c = 0; c < w; c++) s += ((block[r * w + c] >> 10) & 0x3) ? "1" : "0"; rows.push(s); }
  return { w, h, rows };
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
// Hoenn route numbers collide with other regions' routes, so the scene builder
// (build-packs' qualifyName) names them "Hoenn Route NNN" and looks their art up
// by the slug "hoenn-route-nnn"; towns/woods keep their unique bare names. Qualify
// the same way here so the metadata key, `name`, and webp filename all match the
// scenes (kept in lockstep with build-packs.mjs).
const qualify = (name) => (/^Route \d+$/.test(name) ? `Hoenn ${name}` : name);

/** Locate the vendored Chromium playwright-core downloaded under /opt/pw-browsers. */
function findChrome() { if (process.env.PM_CHROME && existsSync(process.env.PM_CHROME)) return process.env.PM_CHROME; for (const p of ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"]) if (existsSync(p)) return p; const base = "/opt/pw-browsers"; try { for (const d of readdirSync(base)) if (d.startsWith("chromium-")) { const q = path.join(base, d, "chrome-linux", "chrome"); if (existsSync(q)) return q; } } catch { /* */ } return null; }

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const only = process.argv.slice(2);
  const entries = Object.entries(HOENN).filter(([n]) => !only.length || only.includes(n));
  const layouts = (await fetchJson(`${EM}/data/layouts/layouts.json`))?.layouts.filter(Boolean) ?? [];
  const outPath = path.join(OUT, "gba-hoenn.json");
  // Metadata-only mode (PM_META_ONLY=1): fetch ONLY each map's tiny blockdata,
  // inject the authentic `collision` grid into the EXISTING metadata, and leave
  // every rendered webp untouched (no tileset load, no Chromium, no re-encode).
  const metaOnly = process.env.PM_META_ONLY === "1";
  console.log(`${metaOnly ? "Injecting collision into" : "Rendering"} ${entries.length} authentic Gen-3 Hoenn maps${metaOnly ? "" : ` (×${SCALE})`}…`);
  let meta = {};
  if (metaOnly) { try { meta = JSON.parse(readFileSync(outPath, "utf8")); } catch { /* start fresh */ } }
  let browser = null, page = null;
  const tilesetCache = new Map();
  const loadTs = async (name, primary) => { if (!tilesetCache.has(name)) tilesetCache.set(name, await loadTileset(name, primary)); return tilesetCache.get(name); };
  if (!metaOnly) {
    const exe = findChrome();
    browser = await chromium.launch(exe ? { executablePath: exe, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] });
    page = await browser.newPage();
  }
  let ok = 0;

  for (const [ourName, [dir, kind]] of entries) {
    try {
      const qname = qualify(ourName);   // scene name / metadata key / webp filename
      const layout = layouts.find((l) => (l.blockdata_filepath || "").split("/")[2]?.toLowerCase() === dir.toLowerCase());
      if (!layout) { console.warn(`  ! no layout for ${dir}`); continue; }
      const w = layout.width, h = layout.height;
      const block = new Uint16Array((await fetchBuf(`${EM}/${layout.blockdata_filepath}`)).buffer.slice(0));
      const collision = collisionGrid(block, w, h);
      if (metaOnly) {
        const k = key(qname);
        if (meta[k]) meta[k].collision = collision;
        else meta[k] = { name: qname, kind, w, h, grid: GRID, warps: [], connections: [], grass: null, collision };
        console.log(`  · ${qname.padEnd(16)} collision ${w}×${h}`);
        ok++;
        continue;
      }
      const prim = await loadTs(layout.primary_tileset, true);
      const sec = layout.secondary_tileset ? await loadTs(layout.secondary_tileset, false) : { metatiles: new Uint16Array(0), attrs: new Uint16Array(0), palettes: {}, tiles: { idx: new Uint8Array(0), width: 0 }, tilesPerRow: 16 };
      const OW = w * 16, OH = h * 16, png = new PNG({ width: OW, height: OH });
      png.data.fill(0);
      const grass = [];
      for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
        const mtId = block[row * w + col] & 0x3FF;
        drawMetatile(png.data, OW, col * 16, row * 16, mtId, prim, sec);
        const beh = behaviour(mtId, prim, sec);
        if (beh === MB_TALL_GRASS || beh === MB_LONG_GRASS) grass.push([col, row]);
      }
      // Warps + connections from the map header (best-effort; layout dir == map dir).
      const mapJson = await fetchJson(`${EM}/data/maps/${dir}/map.json`);
      const warps = (mapJson?.warp_events ?? []).map((wv) => ({ x: wv.x, y: wv.y, dest: wv.dest_map }));
      const conns = (mapJson?.connections ?? []).map((c) => ({ dir: c.direction, map: c.map, offset: c.offset }));
      // Grass bounding box (a single wild-zone rectangle in grid units).
      let gb = null;
      if (grass.length) { const xs = grass.map((g) => g[0]), ys = grass.map((g) => g[1]); gb = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1 }; }
      meta[key(qname)] = { name: qname, kind, w, h, grid: GRID, warps, connections: conns, grass: gb, collision };

      // Upscale ×SCALE (nearest) and encode WebP via Chromium.
      const b64 = PNG.sync.write(png).toString("base64");
      const url = await page.evaluate(async ({ b64, W, H, S }) => {
        const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
        const c = document.createElement("canvas"); c.width = W * S; c.height = H * S;
        const ctx = c.getContext("2d"); ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 0, 0, W * S, H * S);
        return c.toDataURL("image/webp", 0.9);
      }, { b64, W: OW, H: OH, S: SCALE });
      await fs.writeFile(path.join(OUT, `${key(qname)}.webp`), Buffer.from(url.split(",")[1], "base64"));
      console.log(`  ✓ ${qname.padEnd(16)} ${OW * SCALE}×${OH * SCALE}  warps:${warps.length} conns:${conns.length} grass:${grass.length}`);
      ok++;
    } catch (e) { console.warn(`  ! ${ourName}: ${e.message}`); }
  }
  if (browser) await browser.close();
  await fs.writeFile(outPath, JSON.stringify(meta, null, 1));
  console.log(`Done — ${ok}/${entries.length} ${metaOnly ? "collision grids injected" : "rendered"}. Wrote assets/maps/gba-hoenn.json.`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
