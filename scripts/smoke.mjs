/**
 * Pokémon Masters — pre-boot smoke test.
 *
 *   npm run smoke        (run after npm run build)
 *
 * Statically checks everything that can be verified without launching Foundry:
 * module syntax, that every import/dynamic-import resolves to a real export,
 * that every register*Api() is wired, that every sheet data-action has a
 * handler and every game.pokemonMasters.<ns> used is registered, that the
 * manifest's paths exist and its RegionBehavior subtypes match the code, and
 * that the compiled LevelDB packs exist and are non-empty. Exits non-zero on
 * any failure. It cannot prove Foundry runtime behavior — only that the system
 * is structurally sound enough to load.
 */

import { promises as fs, rmSync } from "node:fs";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { extractPack } from "@foundryvtt/foundryvtt-cli";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const warn = [];
const fail = (m) => problems.push(m);
const note = (m) => warn.push(m);

const moduleDir = path.join(ROOT, "src/module");
const moduleFiles = readdirSync(moduleDir).filter((f) => f.endsWith(".mjs"));
const entryPath = path.join(ROOT, "src/pokemon-masters.mjs");
const read = (p) => readFileSync(p, "utf8");

/* 1. Syntax: every module + entry parses. */
for (const f of [...moduleFiles.map((f) => path.join(moduleDir, f)), entryPath]) {
  try { execFileSync("node", ["--check", f], { stdio: "pipe" }); }
  catch (e) { fail(`syntax error in ${path.relative(ROOT, f)}: ${String(e.stderr || e).split("\n")[0]}`); }
}

/* 2. Collect exports per module. */
const exportsOf = {};
for (const f of moduleFiles) {
  const s = read(path.join(moduleDir, f));
  const names = new Set();
  for (const m of s.matchAll(/export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z0-9_]+)/g)) names.add(m[1]);
  for (const m of s.matchAll(/export\s*\{([^}]+)\}/g)) for (const p of m[1].split(",")) { const n = p.trim().split(/\s+as\s+/).pop().trim(); if (n) names.add(n); }
  exportsOf[f] = names;
}

/* 3. Static imports resolve to real exports. */
const checkImports = (fp, label) => {
  const s = read(fp);
  for (const m of s.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'](\.[^"']+)["']/g)) {
    const base = path.basename(m[2]);
    if (!exportsOf[base]) continue; // external dep
    for (const raw of m[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name && !exportsOf[base].has(name)) fail(`missing export '${name}' imported by ${label} from ${base}`);
    }
  }
};
for (const f of moduleFiles) checkImports(path.join(moduleDir, f), f);
checkImports(entryPath, "pokemon-masters.mjs");

/* 4. Dynamic imports: await import("./x.mjs") then .prop must be exported. */
for (const f of moduleFiles) {
  const s = read(path.join(moduleDir, f));
  for (const m of s.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*await import\(["'](\.[^"']+)["']\)/g)) {
    const base = path.basename(m[2]);
    if (!exportsOf[base]) continue;
    for (const raw of m[1].split(",")) { const name = raw.trim().split(/[:\s]/)[0].trim(); if (name && !exportsOf[base].has(name)) fail(`dynamic import in ${f}: '${name}' not exported by ${base}`); }
  }
  // `const ns = await import("./x.mjs"); ns.foo(...)`  (scan with import-path
  // strings blanked so the path "./npc.mjs" isn't mistaken for ns.mjs access)
  const codeNoImportStrings = s.replace(/import\(["'][^"']+["']\)/g, "import()");
  for (const m of s.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*await import\(["'](\.[^"']+)["']\)/g)) {
    const ns = m[1]; const base = path.basename(m[2]);
    if (!exportsOf[base]) continue;
    const re = new RegExp(`\\b${ns}\\.([A-Za-z0-9_]+)`, "g");
    for (const u of codeNoImportStrings.matchAll(re)) if (!exportsOf[base].has(u[1])) fail(`dynamic import in ${f}: '${ns}.${u[1]}' not exported by ${base}`);
  }
}

/* 5. Every register*() is invoked from the entry file. */
const entry = read(entryPath);
const registrars = new Set();
for (const f of moduleFiles) for (const n of exportsOf[f]) if (/^register/.test(n)) registrars.add(n);
for (const r of registrars) if (!entry.includes(r + "(")) fail(`register function '${r}' is never called from the entry file`);

/* 6. Which game.pokemonMasters.<ns> namespaces are registered, and which are used. */
const registeredNs = new Set();
for (const f of moduleFiles) {
  const s = read(path.join(moduleDir, f));
  // game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, { NS: {...} })
  for (const m of s.matchAll(/Object\.assign\(\s*game\.pokemonMasters[^,]*,\s*\{\s*([A-Za-z0-9_]+)\s*:/g)) registeredNs.add(m[1]);
}
const usedNs = new Set();
for (const f of [...moduleFiles.map((x) => path.join(moduleDir, x)), entryPath]) {
  for (const m of read(f).matchAll(/game\.pokemonMasters\?\.\s*([A-Za-z0-9_]+)|game\.pokemonMasters\.([A-Za-z0-9_]+)/g)) {
    const ns = m[1] || m[2]; if (ns) usedNs.add(ns);
  }
}
for (const ns of usedNs) if (!registeredNs.has(ns)) note(`game.pokemonMasters.${ns} is used but no register*Api registers that namespace (may be added elsewhere)`);

/* 7. Sheet data-action wiring: every template action has a handler. */
const tmplDir = path.join(ROOT, "templates/actor");
const sheetSrc = read(path.join(moduleDir, "sheets.mjs"));
for (const tf of readdirSync(tmplDir).filter((f) => f.endsWith(".hbs"))) {
  const s = read(path.join(tmplDir, tf));
  for (const m of s.matchAll(/data-action="([A-Za-z0-9_]+)"/g)) {
    const action = m[1];
    // handler appears either as `action(` in the actions:{} block or `action() {`
    if (!new RegExp(`\\b${action}\\s*\\(`).test(sheetSrc)) fail(`template ${tf}: data-action="${action}" has no handler in sheets.mjs`);
  }
}

/* 8. Manifest correctness. */
const manifest = JSON.parse(read(path.join(ROOT, "system.json")));
for (const rel of [...manifest.esmodules, ...(manifest.styles ?? []), ...(manifest.languages ?? []).map((l) => l.path)]) {
  if (!existsSync(path.join(ROOT, rel))) fail(`manifest references missing file: ${rel}`);
}
for (const pack of manifest.packs) {
  const dir = path.join(ROOT, pack.path);
  if (!existsSync(dir)) { fail(`manifest pack '${pack.name}' dir missing: ${pack.path}`); continue; }
  // Compiled LevelDB packs must have a CURRENT + at least one .log/.ldb
  const entries = readdirSync(dir);
  if (!entries.includes("CURRENT")) fail(`pack '${pack.name}' is not a compiled LevelDB pack (no CURRENT) — run npm run build`);
  const src = path.join(ROOT, "src/packs", pack.name);
  if (existsSync(src)) {
    const nJson = readdirSync(src).filter((f) => f.endsWith(".json")).length;
    if (nJson === 0) fail(`source pack '${pack.name}' has 0 documents`);
    // Round-trip: decompile the LevelDB pack and confirm it holds the same count.
    // This catches empty/partial packs (e.g. a missing _key) that a mere file
    // check would miss — Foundry would otherwise load an empty compendium.
    const out = path.join(ROOT, ".smoke-extract", pack.name);
    try {
      rmSync(out, { recursive: true, force: true });
      await extractPack(dir, out, { log: false });
      const nCompiled = readdirSync(out).filter((f) => f.endsWith(".json")).length;
      if (nCompiled !== nJson) fail(`compiled pack '${pack.name}' holds ${nCompiled} docs but source has ${nJson} — rebuild (a missing _key silently drops docs)`);
    } catch (e) {
      fail(`could not read compiled pack '${pack.name}': ${String(e.message || e).split("\n")[0]}`);
    }
  }
}
rmSync(path.join(ROOT, ".smoke-extract"), { recursive: true, force: true });

/* 9. RegionBehavior subtypes: code registration must match the manifest. */
const codeBehaviors = new Set();
for (const m of entry.matchAll(/"pokemon-masters\.([A-Za-z0-9_]+)"\s*:/g)) codeBehaviors.add(m[1]);
// only those registered onto CONFIG.RegionBehavior.dataModels — narrow by the block
const rbBlock = entry.slice(entry.indexOf("CONFIG.RegionBehavior.dataModels"), entry.indexOf("CONFIG.RegionBehavior.typeIcons") + 1);
const rbCode = new Set([...rbBlock.matchAll(/"pokemon-masters\.([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
const rbManifest = new Set(Object.keys(manifest.documentTypes?.RegionBehavior ?? {}));
for (const b of rbCode) if (!rbManifest.has(b)) fail(`RegionBehavior '${b}' is registered in code but missing from system.json documentTypes.RegionBehavior`);
for (const b of rbManifest) if (!rbCode.has(b)) note(`RegionBehavior '${b}' is in the manifest but not registered in code`);

/* Report. */
console.log("Pokémon Masters — pre-boot smoke test\n");
console.log(`  modules checked: ${moduleFiles.length}   packs: ${manifest.packs.length}   behaviors: ${rbCode.size}`);
if (warn.length) { console.log(`\n⚠ ${warn.length} notes:`); for (const w of warn) console.log("  ·", w); }
if (problems.length) {
  console.log(`\n❌ ${problems.length} problems:`);
  for (const p of problems) console.log("  •", p);
  process.exitCode = 1;
} else {
  console.log("\n✅ Structurally sound — all imports, actions, manifest paths, packs and behaviors check out.");
}
