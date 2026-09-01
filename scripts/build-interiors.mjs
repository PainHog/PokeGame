/**
 * Pokémon Masters — authentic building-interior renderer.
 *
 *   npm run interiors
 *
 * Renders the shared walk-in interiors (Pokémon Center, Poké Mart, House, Police
 * Station) and a generic Gym from real FireRed interior maps, so stepping inside
 * a building shows authentic Gen-3 art instead of the stylised placeholder room.
 * Emits assets/maps/gba-interiors.json — keyed by our interior scene slug — with
 * the native size plus the exit-door tile and a counter strip, so the scene
 * builder can drop the service zone and the return door onto the real art.
 *
 * Source: github.com/pret/pokefirered (open decomp; tile art © Nintendo/GF).
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
const SCALE = 2, GRID = 16 * SCALE;

// Our interior scene name → candidate FireRed map dirs (first that resolves wins).
// Police has no FireRed building, so it borrows a plain house/office room.
const INTERIORS = [
  ["Pokémon Center", "center", ["ViridianCity_PokemonCenter_1F", "PewterCity_PokemonCenter_1F", "CeruleanCity_PokemonCenter_1F"]],
  ["Poké Mart", "mart", ["ViridianCity_Mart", "PewterCity_Mart", "CeruleanCity_Mart", "LavenderTown_Mart"]],
  ["House", "house", ["PalletTown_PlayersHouse_1F", "ViridianCity_House", "CeruleanCity_House1", "PalletTown_RivalsHouse"]],
  ["Police Station", "police", ["ViridianCity_House", "PewterCity_House1", "VermilionCity_House", "SaffronCity_House"]],
  ["Gym", "gym", ["ViridianCity_Gym", "CeruleanCity_Gym", "PewterCity_Gym", "VermilionCity_Gym"]],
];

async function download(url, dest) { try { const { stdout } = await run("curl", ["-sSL", "--max-time", "40", "-w", "%{http_code}", "-o", dest, url], { maxBuffer: 1 << 20 }); return stdout.trim() === "200" && existsSync(dest); } catch { return false; } }
async function fetchBuf(url) { const tmp = path.join(os.tmpdir(), `i_${Math.random().toString(36).slice(2)}`); if (!(await download(url, tmp))) throw new Error(`fetch ${url}`); const b = await fs.readFile(tmp); await fs.rm(tmp, { force: true }); return b; }
const fetchText = async (u) => (await fetchBuf(u)).toString("utf8");
async function fetchJson(u) { try { return JSON.parse(await fetchText(u)); } catch { return null; } }
function parsePal(t) { const pal = []; for (const l of t.split(/\r?\n/).slice(3)) { const m = l.trim().split(/\s+/).map(Number); if (m.length >= 3 && m.slice(0, 3).every((n) => !isNaN(n))) pal.push([m[0], m[1], m[2]]); if (pal.length === 16) break; } while (pal.length < 16) pal.push([0, 0, 0]); return pal; }
function decodeTileIndices(png) { const { width, height, data, palette } = png; const rev = new Map(); (palette ?? []).forEach((c, i) => rev.set(`${c[0]},${c[1]},${c[2]}`, i)); const idx = new Uint8Array(width * height); for (let p = 0; p < width * height; p++) { const o = p << 2; idx[p] = rev.get(`${data[o]},${data[o + 1]},${data[o + 2]}`) ?? 0; } return { width, height, idx }; }
function tilesetDir(g) { return g.replace(/^gTileset_/, "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").replace(/([a-zA-Z])([0-9])/g, "$1_$2").toLowerCase(); }
async function loadTileset(g, primary) {
  const dir = `${FR}/data/tilesets/${primary ? "primary" : "secondary"}/${tilesetDir(g)}`;
  const tiles = decodeTileIndices(PNG.sync.read(await fetchBuf(`${dir}/tiles.png`)));
  const metatiles = new Uint16Array((await fetchBuf(`${dir}/metatiles.bin`)).buffer.slice(0));
  const palettes = {}; const lo = primary ? 0 : NUM_PALS_PRIMARY, hi = primary ? NUM_PALS_PRIMARY : 13;
  for (let i = lo; i < hi; i++) { try { palettes[i] = parsePal(await fetchText(`${dir}/palettes/${String(i).padStart(2, "0")}.pal`)); } catch { /* */ } }
  return { tiles, metatiles, palettes, tilesPerRow: tiles.width >> 3 };
}
function tilePixel(ts, tileId, x, y) { const tr = Math.floor(tileId / ts.tilesPerRow), tc = tileId % ts.tilesPerRow; return ts.tiles.idx[(tr * 8 + y) * ts.tiles.width + (tc * 8 + x)]; }
/**
 * Per-tile collision grid from the interior blockdata: collision field is bits
 * 10-11 of each block entry ((block>>10)&0x3; nonzero = impassable — counters,
 * walls, furniture). The real interiors already leave the entrance mat and a
 * walkable path up to the counter open, so this is authentic. Returns
 * { w, h, rows } with rows[ty][tx] === "1" for impassable tiles.
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
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function findChrome() { if (process.env.PM_CHROME && existsSync(process.env.PM_CHROME)) return process.env.PM_CHROME; for (const p of ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"]) if (existsSync(p)) return p; const base = "/opt/pw-browsers"; try { for (const d of readdirSync(base)) if (d.startsWith("chromium-")) { const q = path.join(base, d, "chrome-linux", "chrome"); if (existsSync(q)) return q; } } catch { /* */ } return null; }

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const layouts = (await fetchJson(`${FR}/data/layouts/layouts.json`))?.layouts.filter(Boolean) ?? [];
  const byLayoutId = new Map(layouts.map((l) => [l.id, l]));
  const exe = findChrome();
  const browser = await chromium.launch(exe ? { executablePath: exe, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const tsCache = new Map();
  const loadTs = async (n, p) => { if (!tsCache.has(n)) tsCache.set(n, await loadTileset(n, p)); return tsCache.get(n); };
  const meta = {}; let ok = 0;

  for (const [ourName, kind, dirs] of INTERIORS) {
    let done = false;
    for (const dir of dirs) {
      try {
        const mapJson = await fetchJson(`${FR}/data/maps/${dir}/map.json`);
        if (!mapJson?.layout) continue;
        const layout = byLayoutId.get(mapJson.layout) || layouts.find((l) => (l.blockdata_filepath || "").toLowerCase().includes(`/${dir.toLowerCase()}/`));
        if (!layout) continue;
        const w = layout.width, h = layout.height;
        const block = new Uint16Array((await fetchBuf(`${FR}/${layout.blockdata_filepath}`)).buffer.slice(0));
        const prim = await loadTs(layout.primary_tileset, true);
        const sec = layout.secondary_tileset ? await loadTs(layout.secondary_tileset, false) : { metatiles: new Uint16Array(0), palettes: {}, tiles: { idx: new Uint8Array(0), width: 0 }, tilesPerRow: 16 };
        const OW = w * 16, OH = h * 16, png = new PNG({ width: OW, height: OH }); png.data.fill(0);
        for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) drawMetatile(png.data, OW, c * 16, r * 16, block[r * w + c] & 0x3FF, prim, sec);
        const collision = collisionGrid(block, w, h);
        // Exit = the bottom-most warp (the door back outside).
        const warps = mapJson.warp_events ?? [];
        const exit = warps.length ? warps.reduce((a, b) => (b.y > a.y ? b : a)) : { x: Math.floor(w / 2), y: h - 1 };
        const b64 = PNG.sync.write(png).toString("base64");
        const url = await page.evaluate(async ({ b64, W, H, S }) => { const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode(); const cv = document.createElement("canvas"); cv.width = W * S; cv.height = H * S; const ctx = cv.getContext("2d"); ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 0, 0, W * S, H * S); return cv.toDataURL("image/webp", 0.92); }, { b64, W: OW, H: OH, S: SCALE });
        const outSlug = kind === "gym" ? "gym-interior" : slug(ourName);
        await fs.writeFile(path.join(OUT, `${outSlug}.webp`), Buffer.from(url.split(",")[1], "base64"));
        meta[outSlug] = { name: ourName, kind, w, h, grid: GRID, exit: { x: exit.x, y: exit.y }, source: dir, collision };
        console.log(`  ✓ ${ourName.padEnd(16)} ${dir.padEnd(28)} ${OW * SCALE}×${OH * SCALE}  exit(${exit.x},${exit.y})`);
        ok++; done = true; break;
      } catch (e) { console.warn(`    · ${dir}: ${e.message}`); }
    }
    if (!done) console.warn(`  ! ${ourName}: no candidate dir resolved (${dirs.join(", ")})`);
  }
  await browser.close();
  await fs.writeFile(path.join(OUT, "gba-interiors.json"), JSON.stringify(meta, null, 1));
  console.log(`Done — ${ok}/${INTERIORS.length} interiors. Wrote assets/maps/gba-interiors.json.`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
