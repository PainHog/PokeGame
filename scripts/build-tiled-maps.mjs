/**
 * Pokémon Masters — GBA-tile map composer (the "match the art style" workaround).
 *
 *   npm run tiledmaps            (compose every non-authentic overworld map)
 *   npm run tiledmaps "Jubilife City"   (a single map)
 *
 * For regions with no open decomp to render exactly (Sinnoh, Unova, Kalos, Galar,
 * Paldea, Alola, Hisui, Johto…), we still want authentic Gen-3 art rather than the
 * stylised SVGs. This composer builds each map out of REAL FireRed tiles: it pulls
 * the General primary tileset for terrain (grass, tall grass, trees, water, path,
 * sand, rock, flowers) and extracts real building stamps (Pokémon Center, Poké
 * Mart, Gym, houses) from actual FireRed towns, then lays them out per the map's
 * kind + climate. Output matches the exact-render pipeline: a WebP at grid 32 plus
 * assets/maps/tiled-<region>.json metadata (dims, wild-grass bbox, building warps)
 * so the scene builder treats a composed map exactly like an authentic one.
 *
 * Source: github.com/pret/pokefirered (open decomp; tile art © Nintendo/GF).
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
const SCENES = path.join(ROOT, "src", "packs", "scenes");
const FR = "https://raw.githubusercontent.com/pret/pokefirered/master";
const NUM_TILES_PRIMARY = 640, NUM_METATILES_PRIMARY = 640, NUM_PALS_PRIMARY = 7;
const SCALE = 2, GRID = 16 * SCALE;   // 32px Foundry grid

/* ------------------------------------------------------------------ *
 *  FireRed tileset loading + metatile compositing (as build-gba-maps) *
 * ------------------------------------------------------------------ */
async function download(url, dest) {
  try { const { stdout } = await run("curl", ["-sSL", "--max-time", "40", "-w", "%{http_code}", "-o", dest, url], { maxBuffer: 1 << 20 }); return stdout.trim() === "200" && existsSync(dest); } catch { return false; }
}
async function fetchBuf(url) { const tmp = path.join(os.tmpdir(), `t_${Math.random().toString(36).slice(2)}`); if (!(await download(url, tmp))) throw new Error(`fetch ${url}`); const b = await fs.readFile(tmp); await fs.rm(tmp, { force: true }); return b; }
const fetchText = async (u) => (await fetchBuf(u)).toString("utf8");
async function fetchJson(u) { try { return JSON.parse(await fetchText(u)); } catch { return null; } }
function parsePal(t) { const pal = []; for (const l of t.split(/\r?\n/).slice(3)) { const m = l.trim().split(/\s+/).map(Number); if (m.length >= 3 && m.slice(0, 3).every((n) => !isNaN(n))) pal.push([m[0], m[1], m[2]]); if (pal.length === 16) break; } while (pal.length < 16) pal.push([0, 0, 0]); return pal; }
function decodeTileIndices(png) { const { width, height, data, palette } = png; const rev = new Map(); (palette ?? []).forEach((c, i) => rev.set(`${c[0]},${c[1]},${c[2]}`, i)); const idx = new Uint8Array(width * height); for (let p = 0; p < width * height; p++) { const o = p << 2; idx[p] = rev.get(`${data[o]},${data[o + 1]},${data[o + 2]}`) ?? 0; } return { width, height, idx }; }
function tilesetDir(g) { return g.replace(/^gTileset_/, "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase(); }
async function loadTileset(g, primary) {
  const dir = `${FR}/data/tilesets/${primary ? "primary" : "secondary"}/${tilesetDir(g)}`;
  const tiles = decodeTileIndices(PNG.sync.read(await fetchBuf(`${dir}/tiles.png`)));
  const metatiles = new Uint16Array((await fetchBuf(`${dir}/metatiles.bin`)).buffer.slice(0));
  let attrs = new Uint32Array(0); try { attrs = new Uint32Array((await fetchBuf(`${dir}/metatile_attributes.bin`)).buffer.slice(0)); } catch { /* opt */ }
  const palettes = {}; const lo = primary ? 0 : NUM_PALS_PRIMARY, hi = primary ? NUM_PALS_PRIMARY : 13;
  for (let i = lo; i < hi; i++) { try { palettes[i] = parsePal(await fetchText(`${dir}/palettes/${String(i).padStart(2, "0")}.pal`)); } catch { /* not all */ } }
  return { tiles, metatiles, attrs, palettes, tilesPerRow: tiles.width >> 3 };
}
function tilePixel(ts, tileId, x, y) { const tr = Math.floor(tileId / ts.tilesPerRow), tc = tileId % ts.tilesPerRow; return ts.tiles.idx[(tr * 8 + y) * ts.tiles.width + (tc * 8 + x)]; }
function drawMetatile(out, ow, ox, oy, mtId, prim, sec) {
  if (mtId < 0) return;
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

/* ------------------------------------------------------------------ *
 *  Terrain palette (hand-picked General-tileset metatile IDs, read    *
 *  off a rendered atlas of the tileset)                               *
 * ------------------------------------------------------------------ */
const T = {
  grass: 1, grass2: 8, grass3: 16, tallgrass: 13, flower: 4,
  tree: 36, tree2: 5, sand: 209, sand2: 208, water: 49, water2: 50,
  rock: 120, rockLight: 118,
};
// Terrain metatile ids that block movement in composed maps: trees, rock/cliff
// walls and open water. Grass (1/8/16), tall grass (13), flowers (4), sand
// (208/209) and the sandy path are all walkable; building-stamp footprints and
// cave/venue walls are handled separately in compose()/main().
const IMPASSABLE = new Set([T.tree, T.tree2, T.rock, T.rockLight, T.water, T.water2]);
// Cave floor/wall metatile ids are sampled from a real cave map at runtime.
let CAVE = { prim: null, sec: null, floor: [T.sand], wall: [T.rock] };

/**
 * Per-tile collision grid from real blockdata (used for venue interiors, which
 * render a genuine FireRed indoor map verbatim). Collision is bits 10-11 of each
 * block entry ((block>>10)&0x3; nonzero = impassable — walls, counters,
 * furniture). Returns { w, h, rows } with rows[ty][tx] === "1" for impassable.
 */
function collisionGridFromBlock(block, w, h) {
  const rows = [];
  for (let r = 0; r < h; r++) { let s = ""; for (let c = 0; c < w; c++) s += ((block[r * w + c] >> 10) & 0x3) ? "1" : "0"; rows.push(s); }
  return { w, h, rows };
}

/* ------------------------------------------------------------------ *
 *  Venue interiors — real FireRed indoor maps rendered directly       *
 * ------------------------------------------------------------------ *
 * Sampling single "floor" tiles out of a tileset produced garbled art
 * (it kept picking shelf/counter tiles). Instead we render a handful of
 * genuine FireRed interior maps' blockdata verbatim — a real tiled floor,
 * walls and furniture — and assign one to each venue by theme. Every one
 * uses the shared "Building" primary tileset plus its own secondary. */
const VENUE_INTERIORS = [
  { key: "powerplant", bd: "data/layouts/PowerPlant/map.bin",                             w: 49, h: 40, sec: "gTileset_PowerPlant" },
  { key: "lab",        bd: "data/layouts/CinnabarIsland_PokemonLab_ResearchRoom/map.bin", w: 15, h: 11, sec: "gTileset_Lab" },
  { key: "oakslab",    bd: "data/layouts/PalletTown_ProfessorOaksLab/map.bin",            w: 13, h: 14, sec: "gTileset_Lab" },
  { key: "hotel",      bd: "data/layouts/CeladonCity_Hotel/map.bin",                      w: 17, h: 11, sec: "gTileset_RestaurantHotel" },
  { key: "mansion",    bd: "data/layouts/PokemonMansion_1F/map.bin",                      w: 38, h: 35, sec: "gTileset_PokemonMansion" },
  { key: "tower",      bd: "data/layouts/TrainerTower_Lobby/map.bin",                     w: 19, h: 17, sec: "gTileset_TrainerTower" },
  { key: "tower2",     bd: "data/layouts/TrainerTower_1F/map.bin",                        w: 18, h: 17, sec: "gTileset_TrainerTower" },
  { key: "dojo",       bd: "data/layouts/SaffronCity_Dojo/map.bin",                       w: 13, h: 16, sec: "gTileset_PewterGym" },
  { key: "museum",     bd: "data/layouts/PewterCity_Museum_1F/map.bin",                   w: 28, h: 11, sec: "gTileset_Museum" },
  { key: "shop",       bd: "data/layouts/CeladonCity_DepartmentStore_2F/map.bin",         w: 13, h: 15, sec: "gTileset_DepartmentStore" },
  { key: "resthouse",  bd: "data/layouts/SafariZone_RestHouse/map.bin",                   w: 13, h: 11, sec: "gTileset_SafariZoneBuilding" },
  { key: "gym",        bd: "data/layouts/ViridianCity_Gym/map.bin",                       w: 20, h: 24, sec: "gTileset_ViridianGym" },
];
// Each of the 24 special venues → the interior whose theme fits best. Several
// venues intentionally share one interior (like the gyms already do).
const VENUE_ART = {
  "Blueberry Academy": "tower",     "Battle Tree": "tower",
  "Battle Maison": "tower2",        "Sinnoh Battle Tower": "tower2",
  "Battle Royal Dome": "gym",
  "Master Dojo": "dojo",            "Tower of Mastery": "dojo",
  "Valley Windworks": "powerplant", "Kalos Power Plant": "powerplant",
  "Team Flare Secret HQ": "powerplant", "Zero Gate": "powerplant",
  "Zero Lab": "lab",                "Aether Paradise": "lab",
  "Trainers' School": "oakslab",    "Weather Institute": "oakslab",
  "Hokulani Observatory": "museum", "Altar of the Sunne": "museum",
  "Hano Grand Resort": "hotel",     "Lost Hotel": "hotel",
  "Parfum Palace": "mansion",       "Olivine Lighthouse": "mansion",
  "Thrifty Megamart": "shop",
  "Aether House": "resthouse",      "Safari Zone Gate": "resthouse",
};
// Loaded in main(): the shared Building primary tileset + each interior's
// { grid (2D metatile ids), w, h, sec (secondary tileset) }.
let VENUE = { building: null, byKey: {} };

/* ------------------------------------------------------------------ *
 *  Building + tree stamps extracted from real FireRed town blockdata  *
 * ------------------------------------------------------------------ */
// A stamp is a small grid of metatile ids (from prim/sec of its source town),
// with a door column so we know where the warp tile sits.
async function extractStamps(layouts) {
  const stamps = {};
  // Towns to mine, and which building keyword → stamp name.
  const sources = [
    ["ViridianCity", { center: /pokemon_?center/i, mart: /(?<!depared)mart/i, gym: /gym/i, house: /house/i }],
    ["CeladonCity", { center: /pokemon_?center/i, mart: /department_?store/i, gym: /gym/i, house: /condominiums|house|hotel|mansion/i }],
    ["PewterCity", { gym: /gym/i, house: /house/i }],
  ];
  // Load a shared tileset context for stamps: General + Celadon secondary covers most.
  for (const [town, kinds] of sources) {
    const layout = layouts.find((l) => (l.blockdata_filepath || "").split("/")[2]?.toLowerCase() === town.toLowerCase());
    const mapJson = await fetchJson(`${FR}/data/maps/${town}/map.json`);
    if (!layout || !mapJson) continue;
    const w = layout.width, h = layout.height;
    const block = new Uint16Array((await fetchBuf(`${FR}/${layout.blockdata_filepath}`)).buffer.slice(0));
    for (const wv of mapJson.warp_events ?? []) {
      for (const [name, re] of Object.entries(kinds)) {
        if (stamps[name] || !re.test(wv.dest_map || "")) continue;
        // The warp (wv.x, wv.y) is the door tile at the building's base; the
        // building rises above it. Buildings come in different sizes (Center 6×5,
        // house 4×4, gym 6×6, Mart 4×4), so instead of a fixed crop we trim to the
        // building's real footprint using the collision bits: roof/walls are solid
        // ((block>>10)&0x3 != 0), the surrounding ground is passable. This captures
        // each building whole — no clipped roofs, no stray ground rows.
        const solid = (bx, by) => bx >= 0 && by >= 0 && bx < w && by < h && (((block[by * w + bx] >> 10) & 0x3) !== 0);
        // Flood-fill the building: the connected block of solid (roof/wall) tiles
        // reachable from just above the door. This captures the whole building and
        // ONLY the building — detached fences, signs and flowers nearby are not
        // connected, so they can't bloat the crop.
        const R = 4, UP = 6;
        const seen = new Set(), stack = [];
        for (let sx = wv.x - 1; sx <= wv.x + 1; sx++) if (solid(sx, wv.y - 1)) stack.push([sx, wv.y - 1]);
        let minx = wv.x, maxx = wv.x, miny = wv.y - 1;
        while (stack.length) {
          const [bx, by] = stack.pop(), k = bx + "," + by;
          if (seen.has(k)) continue;
          if (bx < wv.x - R || bx > wv.x + R || by < wv.y - UP || by >= wv.y || !solid(bx, by)) continue;
          seen.add(k); minx = Math.min(minx, bx); maxx = Math.max(maxx, bx); miny = Math.min(miny, by);
          stack.push([bx - 1, by], [bx + 1, by], [bx, by - 1], [bx, by + 1]);
        }
        const x0 = minx, x1 = maxx, y0 = miny, y1 = wv.y;               // door row = y1
        const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
        if (bw < 2 || bh < 2 || bw > 8) continue;
        const grid = [];
        for (let r = 0; r < bh; r++) { const row = []; for (let c = 0; c < bw; c++) row.push(block[(y0 + r) * w + (x0 + c)] & 0x3FF); grid.push(row); }
        stamps[name] = { grid, bw, bh, door: [wv.x - x0, bh - 1], sec: layout.secondary_tileset };
      }
    }
  }
  return stamps;
}

/* ------------------------------------------------------------------ *
 *  Scene inventory: what to compose, and how                          *
 * ------------------------------------------------------------------ */
function classify(scene) {
  const pm = scene.flags?.["pokemon-masters"]; if (!pm) return null;
  const regions = scene.regions ?? [];
  // A building interior (Center/Mart/House/Gym) has a return-door and is rendered
  // by makeInterior — never recompose those here.
  if (regions.some((r) => r.behaviors?.[0]?.system?.returnDoor)) return null;
  const isTown = regions.some((r) => r.name === "Town");
  const wild = regions.find((r) => r.behaviors?.[0]?.type?.endsWith("wildTile"));
  const isVenue = regions.some((r) => r.name === "Indoors") && !isTown && !wild;
  const n = scene.name.toLowerCase();
  let climate = "temperate";
  if (/snow|ice|icy|frost|icicle|icepeak|glacier|glaseado|alabaster|snowpoint|freez|tundra|winter/.test(n)) climate = "snow";
  else if (/desert|sand|dune|asado|haina|quicksand/.test(n)) climate = "desert";
  else if (/volcan|lava|magma|wela|blush|stark|fiery|jagged|ember|cinder|ashfall/.test(n)) climate = "volcanic";
  let kind = "field";
  if (isTown) kind = "town";
  else if (isVenue) kind = "venue";
  else if (/cave|cavern|tunnel|mine|chamber|chasm|grotto|den|pit|quarry|depths|\bmt\b|mount|coronet|pillar|chargestone|hollow|core|dungeon/.test(n)) kind = "cave";
  else if (/forest|woods|jungle|grove|thicket|tangle|wilds|weald/.test(n)) kind = "forest";
  else if (/\bsea\b|ocean|lake|bay|beach|coast|marinada|pacifidlog|undella|water|marsh|swamp|mire|river|falls|cascade|coastland|surf/.test(n)) kind = "water";
  else if (/route|road|path|pass|bridge|way|avenue|street|trail|approach|outskirts/.test(n)) kind = "route";
  const w = scene.width || 2400, h = scene.height || 1600;
  const hasGym = (scene.regions ?? []).some((r) => (r.behaviors?.[0]?.system?.destinationSceneName || "").endsWith("Gym"));
  return { name: scene.name, region: pm.region || "misc", kind, climate, aspect: w / h, hasGym, authentic: !!pm.authentic };
}

/* pick tile dimensions (in metatiles) from kind + aspect */
function dimsFor(kind, aspect) {
  const base = { town: [30, 26], route: [40, 26], forest: [34, 34], cave: [34, 28], water: [40, 30], field: [34, 28], venue: [26, 22] }[kind] || [34, 28];
  let [w, h] = base;
  if (aspect > 1.5) w = Math.round(h * Math.min(aspect, 2.2)); else if (aspect < 0.75) h = Math.round(w / Math.max(aspect, 0.5));
  return [Math.max(20, Math.min(w, 60)), Math.max(18, Math.min(h, 50))];
}

/* deterministic PRNG so a map looks the same every build */
function rng(seed) { let s = 0; for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; }; }

/* ------------------------------------------------------------------ *
 *  Composition per kind → a grid of metatile ids (-1 = leave)         *
 * ------------------------------------------------------------------ */
function stampInto(grid, stamp, gx, gy) {
  for (let r = 0; r < stamp.bh; r++) for (let c = 0; c < stamp.bw; c++) {
    const y = gy + r, x = gx + c; if (grid[y] && grid[y][x] !== undefined) grid[y][x] = stamp.grid[r][c];
  }
}
function compose(kind, W, H, rand, stamps, hasGym) {
  const g = Array.from({ length: H }, () => new Array(W).fill(T.grass));
  const warps = [];
  const grassPatches = [];
  // Collision bookkeeping: building stamps mark their whole footprint blocked,
  // then punch their door tile back walkable. Everything else is classified by
  // tile id (trees/rock/water impassable; cave = non-floor impassable).
  const blockedStamp = new Set();   // "x,y" cells covered by a building stamp
  const doorCells = new Set();      // "x,y" door tiles kept walkable
  const buildCollision = () => {
    const rows = [];
    for (let y = 0; y < H; y++) {
      let s = "";
      for (let x = 0; x < W; x++) {
        const kk = `${x},${y}`;
        let blocked;
        if (doorCells.has(kk)) blocked = false;
        else if (blockedStamp.has(kk)) blocked = true;
        else if (kind === "cave") blocked = !CAVE.floor.includes(g[y][x]);
        else blocked = IMPASSABLE.has(g[y][x]);
        s += blocked ? "1" : "0";
      }
      rows.push(s);
    }
    return { w: W, h: H, rows };
  };
  const border = (id) => { for (let x = 0; x < W; x++) { g[0][x] = id; g[1][x] = id; g[H - 1][x] = id; } for (let y = 0; y < H; y++) { g[y][0] = id; g[y][1] = id; g[y][W - 1] = id; } };
  const blob = (cx, cy, rad, id, prob = 0.8) => { for (let y = -rad; y <= rad; y++) for (let x = -rad; x <= rad; x++) { const gx = cx + x, gy = cy + y; if (gx < 2 || gy < 2 || gx >= W - 2 || gy >= H - 2) continue; if (x * x + y * y <= rad * rad && rand() < prob) g[gy][gx] = id; } };

  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  if (kind === "cave") {
    const wall = CAVE.wall, floor = CAVE.floor;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y][x] = pick(wall);
    // carve a big rounded floor cavern + a couple of side chambers
    const carve = (cx, cy, rx, ry) => { for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++) { const gx = cx + x, gy = cy + y; if (gx < 2 || gy < 2 || gx >= W - 2 || gy >= H - 2) continue; if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) g[gy][gx] = pick(floor); } };
    carve(W >> 1, H >> 1, (W >> 1) - 3, (H >> 1) - 3);
    for (let i = 0; i < 3; i++) carve(4 + Math.floor(rand() * (W - 8)), 4 + Math.floor(rand() * (H - 8)), 2 + Math.floor(rand() * 3), 2 + Math.floor(rand() * 3));
    // scatter rock rubble on the floor
    for (let i = 0; i < W * H * 0.02; i++) { const x = 3 + Math.floor(rand() * (W - 6)), y = 3 + Math.floor(rand() * (H - 6)); if (floor.includes(g[y][x])) g[y][x] = pick(wall); }
    return { g, warps, grass: null, collision: buildCollision() };
  }
  // NOTE: kind === "venue" never reaches compose(); venues render a real FireRed
  // interior map's blockdata directly in main() (see the VENUE registry).
  if (kind === "water") {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y][x] = (rand() < 0.5 ? T.water : T.water2);
    for (let i = 0; i < 3; i++) blob(4 + Math.floor(rand() * (W - 8)), 4 + Math.floor(rand() * (H - 8)), 2 + Math.floor(rand() * 2), T.sand, 0.9);
    return { g, warps, grass: null, collision: buildCollision() };
  }
  // grass-based kinds: field / route / forest / town — rock/tree wall border
  border(kind === "forest" ? T.tree : T.rock);
  if (kind === "forest") {
    // dense canopy with grass clearings
    for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) if (rand() < 0.55) g[y][x] = (rand() < 0.5 ? T.tree : T.tree2);
    for (let i = 0; i < 5; i++) blob(4 + Math.floor(rand() * (W - 8)), 4 + Math.floor(rand() * (H - 8)), 2 + Math.floor(rand() * 2), T.grass, 1);
  }

  // scatter flowers + grass detail on open ground
  for (let i = 0; i < W * H * 0.03; i++) { const x = 2 + Math.floor(rand() * (W - 4)), y = 2 + Math.floor(rand() * (H - 4)); if (g[y][x] === T.grass) g[y][x] = (rand() < 0.5 ? T.flower : T.grass2); }

  if (kind === "route" || kind === "field" || kind === "forest") {
    // a winding sandy trail
    let py = Math.floor(H / 2);
    for (let x = 2; x < W - 2; x++) { if (g[py][x] !== undefined) g[py][x] = T.sand; if (g[py + 1]) g[py + 1][x] = T.sand; if (rand() < 0.22) py += rand() < 0.5 ? 1 : -1; py = Math.max(3, Math.min(H - 4, py)); }
    // tall-grass patches (wild zone) — record bbox
    const patches = 2 + Math.floor(rand() * 3);
    let minx = W, miny = H, maxx = 0, maxy = 0;
    for (let i = 0; i < patches; i++) { const cx = 4 + Math.floor(rand() * (W - 8)), cy = 4 + Math.floor(rand() * (H - 8)), r = 2 + Math.floor(rand() * 2); blob(cx, cy, r, T.tallgrass, 0.85); minx = Math.min(minx, cx - r); miny = Math.min(miny, cy - r); maxx = Math.max(maxx, cx + r); maxy = Math.max(maxy, cy + r); }
    const grass = { x: Math.max(1, minx), y: Math.max(1, miny), w: Math.min(W - 2, maxx - minx + 1), h: Math.min(H - 2, maxy - miny + 1) };
    return { g, warps, grass, collision: buildCollision() };
  }

  if (kind === "town") {
    // sandy plaza patches between buildings
    for (let i = 0; i < 5; i++) blob(4 + Math.floor(rand() * (W - 8)), 4 + Math.floor(rand() * (H - 8)), 1 + Math.floor(rand() * 2), T.sand2, 0.7);
    const plan = [["center", stamps.center], ["mart", stamps.mart], ["gym", hasGym ? (stamps.gym) : null], ["house", stamps.house], ["house", stamps.house], ["house", stamps.house]].filter(([, s]) => s);
    const cols = 3, gapx = Math.floor(W / (cols + 1)), gapy = Math.floor(H / 3);
    plan.forEach(([type, stamp], i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const gx = gapx * (col + 1) - (stamp.bw >> 1), gy = gapy * (row + 1) - (stamp.bh - 1);
      if (gy < 2 || gx < 2 || gx + stamp.bw > W - 2 || gy + stamp.bh > H - 2) return;
      // clear a pavement pad under/around
      for (let r = -1; r <= stamp.bh; r++) for (let c = -1; c <= stamp.bw; c++) { const y = gy + r, x = gx + c; if (g[y] && g[y][x] !== undefined) g[y][x] = T.sand2; }
      stampInto(g, stamp, gx, gy);
      // The whole building footprint is impassable (you can't walk through it)…
      for (let r = 0; r < stamp.bh; r++) for (let c = 0; c < stamp.bw; c++) { const y = gy + r, x = gx + c; if (g[y] && g[y][x] !== undefined) blockedStamp.add(`${x},${y}`); }
      const dx = gx + stamp.door[0], dy = gy + stamp.door[1];
      doorCells.add(`${dx},${dy}`);   // …except the door tile, which stays walkable
      const dest = type === "center" ? "MAP_TOWN_POKEMON_CENTER" : type === "mart" ? "MAP_TOWN_MART" : type === "gym" ? "MAP_TOWN_GYM" : "MAP_TOWN_HOUSE";
      warps.push({ x: dx, y: dy + 1, dest });
    });
    // a police station door (feature parity) at a free pavement tile
    warps.push({ x: 4, y: H - 4, dest: "MAP_TOWN_POLICE_STATION" });
    for (let c = -1; c <= 2; c++) if (g[H - 4] && g[H - 4][4 + c] !== undefined) g[H - 4][4 + c] = T.sand2;
    return { g, warps, grass: null, collision: buildCollision() };
  }
  return { g, warps, grass: null, collision: buildCollision() };
}

/* recolour the rendered RGBA in place for climate variety.
   Blends a fraction of the original toward a climate tint (keeps buildings
   readable) and CLAMPS every channel — a value >255 into a Uint8Array wraps,
   which turned snow magenta. */
const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
function reclimate(data, climate) {
  if (climate === "temperate") return;
  for (let o = 0; o < data.length; o += 4) {
    const r = data[o], g = data[o + 1], b = data[o + 2];
    if (climate === "snow") { data[o] = clamp8(r * 0.45 + 140); data[o + 1] = clamp8(g * 0.45 + 146); data[o + 2] = clamp8(b * 0.45 + 156); }
    else if (climate === "desert") { data[o] = clamp8(r * 0.55 + 118); data[o + 1] = clamp8(g * 0.5 + 92); data[o + 2] = clamp8(b * 0.45 + 40); }
    else if (climate === "volcanic") { data[o] = clamp8(r * 0.8 + 46); data[o + 1] = clamp8(g * 0.42 + 12); data[o + 2] = clamp8(b * 0.4 + 12); }
  }
}

/* ------------------------------------------------------------------ */
function findChrome() { if (process.env.PM_CHROME && existsSync(process.env.PM_CHROME)) return process.env.PM_CHROME; for (const p of ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"]) if (existsSync(p)) return p; const base = "/opt/pw-browsers"; try { for (const d of readdirSync(base)) if (d.startsWith("chromium-")) { const q = path.join(base, d, "chrome-linux", "chrome"); if (existsSync(q)) return q; } } catch { /* */ } return null; }

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const only = process.argv.slice(2);
  // inventory from the last build
  const targets = [];
  for (const f of readdirSync(SCENES)) { const s = JSON.parse(readFileSync(path.join(SCENES, f), "utf8")); const c = classify(s); if (c && (only.length ? only.includes(c.name) : !c.authentic)) targets.push(c); }
  console.log(`Composing ${targets.length} GBA-tile maps…`);

  const layouts = (await fetchJson(`${FR}/data/layouts/layouts.json`))?.layouts.filter(Boolean) ?? [];
  const prim = await loadTileset("gTileset_General", true);
  const stamps = await extractStamps(layouts);
  console.log("  stamps:", Object.keys(stamps).join(", ") || "(none)");

  // Sample real cave floor/wall metatiles from a real cave (its own tilesets), so
  // caves render from authentic cave art rather than General grass/rock.
  const needCave = targets.some((t) => t.kind === "cave");
  if (needCave) {
    try {
      const cl = layouts.find((l) => (l.blockdata_filepath || "").split("/")[2]?.toLowerCase() === "mtmoon_1f");
      if (cl) {
        const cw = cl.width, chh = cl.height;
        const cblock = new Uint16Array((await fetchBuf(`${FR}/${cl.blockdata_filepath}`)).buffer.slice(0));
        const cprim = await loadTileset(cl.primary_tileset, true);
        const csec = cl.secondary_tileset ? await loadTileset(cl.secondary_tileset, false) : prim;
        const freq = new Map(), bord = new Map();
        for (let r = 0; r < chh; r++) for (let c = 0; c < cw; c++) { const id = cblock[r * cw + c] & 0x3FF; freq.set(id, (freq.get(id) || 0) + 1); if (r === 0 || c === 0 || r === chh - 1 || c === cw - 1) bord.set(id, (bord.get(id) || 0) + 1); }
        const wall = [...bord].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id);
        const floor = [...freq].filter(([id]) => !wall.includes(id)).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id);
        CAVE = { prim: cprim, sec: csec, floor: floor.length ? floor : [T.sand], wall: wall.length ? wall : [T.rock] };
        console.log(`  cave tiles: floor=${CAVE.floor} wall=${CAVE.wall}`);
      }
    } catch (e) { console.warn("  ! cave sample failed:", e.message); }
  }

  // Load real FireRed interior maps for venues: the shared Building primary
  // tileset, then each interior's blockdata + its own secondary tileset. We
  // render these verbatim (a genuine tiled floor + walls + furniture) instead
  // of the old sampled-tile compositing that produced garbled art.
  const needVenue = targets.some((t) => t.kind === "venue");
  if (needVenue) {
    VENUE.building = await loadTileset("gTileset_Building", true);
    const secCacheV = new Map();
    for (const iv of VENUE_INTERIORS) {
      try {
        if (!secCacheV.has(iv.sec)) secCacheV.set(iv.sec, await loadTileset(iv.sec, false));
        const sec = secCacheV.get(iv.sec);
        const bd = new Uint16Array((await fetchBuf(`${FR}/${iv.bd}`)).buffer.slice(0));
        const grid = Array.from({ length: iv.h }, (_, y) => Array.from({ length: iv.w }, (_, x) => bd[y * iv.w + x] & 0x3FF));
        // Authentic interior collision straight from the block bits (walls,
        // counters and furniture impassable; the walkable floor stays open).
        VENUE.byKey[iv.key] = { grid, w: iv.w, h: iv.h, sec, collision: collisionGridFromBlock(bd, iv.w, iv.h) };
      } catch (e) { console.warn(`  ! venue interior ${iv.key}: ${e.message}`); }
    }
    console.log(`  venue interiors: ${Object.keys(VENUE.byKey).join(", ") || "(none)"}`);
  }
  // Load every secondary tileset a stamp needs, so building metatiles render.
  const secCache = new Map();
  for (const st of Object.values(stamps)) if (st.sec && !secCache.has(st.sec)) secCache.set(st.sec, await loadTileset(st.sec, false));
  const anySec = [...secCache.values()][0] || { metatiles: new Uint16Array(0), attrs: new Uint32Array(0), palettes: {}, tiles: { idx: new Uint8Array(0), width: 0 }, tilesPerRow: 16 };

  const exe = findChrome();
  const browser = await chromium.launch(exe ? { executablePath: exe, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] });
  const page = await browser.newPage();

  const byRegion = {}; let ok = 0;
  for (const t of targets) {
    try {
      let W, H, g, warps, grass, usePrim, sec, collision;
      if (t.kind === "venue") {
        // Render a real FireRed interior map verbatim as the venue background.
        const iv = VENUE.byKey[VENUE_ART[t.name] || "lab"] || Object.values(VENUE.byKey)[0];
        if (!iv) throw new Error("no venue interior loaded");
        g = iv.grid; W = iv.w; H = iv.h; warps = []; grass = null; collision = iv.collision;
        usePrim = VENUE.building; sec = iv.sec;
      } else {
        [W, H] = dimsFor(t.kind, t.aspect);
        ({ g, warps, grass, collision } = compose(t.kind, W, H, rng(t.name), stamps, t.hasGym));
        // caves use the real cave tilesets; towns the building-stamp secondary; else General.
        usePrim = t.kind === "cave" && CAVE.prim ? CAVE.prim : prim;
        sec = t.kind === "cave" && CAVE.sec ? CAVE.sec : t.kind === "town" ? (secCache.get(stamps.center?.sec) || anySec) : anySec;
      }
      const OW = W * 16, OH = H * 16, png = new PNG({ width: OW, height: OH }); png.data.fill(0);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) drawMetatile(png.data, OW, x * 16, y * 16, g[y][x], usePrim, sec);
      if (t.kind !== "venue") reclimate(png.data, t.climate);   // indoor rooms keep their true colours
      const b64 = PNG.sync.write(png).toString("base64");
      const url = await page.evaluate(async ({ b64, W, H, S }) => { const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode(); const c = document.createElement("canvas"); c.width = W * S; c.height = H * S; const ctx = c.getContext("2d"); ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 0, 0, W * S, H * S); return c.toDataURL("image/webp", 0.9); }, { b64, W: OW, H: OH, S: SCALE });
      await fs.writeFile(path.join(OUT, `${slug(t.name)}.webp`), Buffer.from(url.split(",")[1], "base64"));
      (byRegion[t.region] = byRegion[t.region] || {})[slug(t.name)] = { name: t.name, kind: t.kind, w: W, h: H, grid: GRID, warps, connections: [], grass, collision };
      ok++;
      if (ok % 25 === 0) console.log(`  …${ok}/${targets.length}`);
    } catch (e) { console.warn(`  ! ${t.name}: ${e.message}`); }
  }
  await browser.close();
  // Merge into any existing tiled-<region>.json so a partial (by-name) run never
  // drops the maps it didn't touch this pass.
  for (const [region, maps] of Object.entries(byRegion)) {
    const p = path.join(OUT, `tiled-${region}.json`);
    let existing = {}; if (existsSync(p)) { try { existing = JSON.parse(readFileSync(p, "utf8")); } catch { /* rewrite */ } }
    await fs.writeFile(p, JSON.stringify({ ...existing, ...maps }, null, 1));
  }
  console.log(`Done — ${ok}/${targets.length} composed. Updated tiled-<region>.json for: ${Object.keys(byRegion).join(", ")}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
