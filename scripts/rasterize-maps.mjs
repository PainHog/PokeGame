/**
 * Pokémon Masters — rasterize generated map SVGs to WebP.
 *
 *   npm run build      (writes assets/maps/<key>.svg + scenes that reference .webp)
 *   npm run maps       (this script: SVG → assets/maps/<key>.webp)
 *
 * Foundry's WebGL canvas loads a scene background as a GPU texture; large SVGs
 * frequently render blank/gray there even when the file is valid. So the maps
 * are rasterized to WebP (which Foundry renders reliably) and vendored into the
 * repo. Flat-colour maps compress to a few KB each.
 *
 * Uses the pre-installed Chromium via playwright-core — no browser download.
 */

import { promises as fs } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAPS = path.join(ROOT, "assets", "maps");
const MAX_DIM = 2000;      // longest side; Foundry scales flat colour maps fine
const QUALITY = 0.82;

/** Locate the bundled Chromium binary (version dir is not fixed). */
function findChrome() { if (process.env.PM_CHROME && existsSync(process.env.PM_CHROME)) return process.env.PM_CHROME; for (const p of ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"]) if (existsSync(p)) return p; const base = "/opt/pw-browsers"; try { for (const d of readdirSync(base)) if (d.startsWith("chromium-")) { const q = path.join(base, d, "chrome-linux", "chrome"); if (existsSync(q)) return q; } } catch { /* */ } return null; }

async function main() {
  if (!existsSync(MAPS)) { console.error("No assets/maps — run `npm run build` first."); process.exitCode = 1; return; }
  const svgs = readdirSync(MAPS).filter((f) => f.endsWith(".svg"));
  if (!svgs.length) { console.error("No SVG maps to rasterize — run `npm run build` first."); process.exitCode = 1; return; }

  const exe = findChrome();
  const browser = await chromium.launch(exe ? { executablePath: exe, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] });
  const page = await browser.newPage();
  console.log(`Rasterizing ${svgs.length} maps → WebP (≤${MAX_DIM}px)…`);

  let done = 0, bytes = 0, skipped = 0;
  for (const f of svgs) {
    const dest = path.join(MAPS, f.replace(/\.svg$/, ".webp"));
    if (existsSync(dest)) { skipped++; continue; } // incremental — delete a .webp to force a re-render
    const svg = await fs.readFile(path.join(MAPS, f), "utf8");
    const b64 = Buffer.from(svg).toString("base64");
    try {
      const url = await page.evaluate(async ({ b64, MAX_DIM, QUALITY }) => {
        const img = new Image();
        img.src = "data:image/svg+xml;base64," + b64;
        await img.decode();
        const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        return c.toDataURL("image/webp", QUALITY);
      }, { b64, MAX_DIM, QUALITY });
      const buf = Buffer.from(url.split(",")[1], "base64");
      await fs.writeFile(dest, buf);
      bytes += buf.length; done++;
    } catch (err) {
      console.warn(`  ! failed ${f}: ${err.message}`);
    }
    if (done % 50 === 0) process.stdout.write(`\r  ${done}/${svgs.length}`);
  }
  await browser.close();
  console.log(`\nDone — ${done} new WebP maps (${skipped} already present), ${(bytes / 1024 / 1024).toFixed(1)} MB added.`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
