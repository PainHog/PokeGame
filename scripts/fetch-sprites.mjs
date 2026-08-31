/**
 * Pokémon Masters — fetch & bundle sprites locally.
 *
 *   npm run sprites          (run once; re-run to fill gaps)
 *
 * Downloads an animated sprite for every National Dex number into
 * assets/sprites/<num>.gif (falling back to a static PNG when a species has no
 * animated sprite), from the PokeAPI sprite mirror, and writes an index.json
 * the pack builder reads. Once bundled, the system needs no external image host
 * — img fields point at the local files. Re-runnable and incremental.
 *
 * Source: https://github.com/PokeAPI/sprites (CC0). Keyed by dex number, so
 * regional forms share their base species' sprite.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Dex } from "@pkmn/dex";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "assets", "sprites");
const BASE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon";
const ANI = (n) => `${BASE}/other/showdown/${n}.gif`;
const PNG = (n) => `${BASE}/${n}.png`;

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

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  // Every unique National Dex number present in the dataset.
  const nums = [...new Set([...Dex.species.all()].filter((s) => s.exists && s.num > 0).map((s) => s.num))].sort((a, b) => a - b);
  const index = {};
  let got = 0; let miss = 0;
  console.log(`Fetching sprites for ${nums.length} Pokémon…`);

  // Small concurrency so we don't hammer the host.
  const BATCH = 16;
  for (let i = 0; i < nums.length; i += BATCH) {
    await Promise.all(nums.slice(i, i + BATCH).map(async (n) => {
      const gif = path.join(OUT, `${n}.gif`);
      const png = path.join(OUT, `${n}.png`);
      if (existsSync(gif)) { index[n] = `${n}.gif`; got++; return; }
      if (existsSync(png)) { index[n] = `${n}.png`; got++; return; }
      if (await download(ANI(n), gif)) { index[n] = `${n}.gif`; got++; return; }
      if (await download(PNG(n), png)) { index[n] = `${n}.png`; got++; return; }
      miss++;
    }));
    process.stdout.write(`\r  ${Math.min(i + BATCH, nums.length)}/${nums.length}`);
  }
  await fs.writeFile(path.join(OUT, "index.json"), JSON.stringify(index));
  console.log(`\nDone — ${got} sprites, ${miss} missing. Wrote assets/sprites/index.json.`);
  if (miss) console.log("  (missing numbers will fall back to the external sprite URL at build time)");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
