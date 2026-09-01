/**
 * Pokémon Masters — overworld movement: WASD/arrow walking, collision, and the
 * zone-transition trigger.
 *
 * Foundry v13.341+ moved token movement into a dedicated pipeline. The old
 * preUpdateToken hook no longer blocks an x/y move (returning false is ignored),
 * and region events (tokenMoveIn) don't fire reliably for a region that sits on
 * the very edge of a scene — which is exactly where our map-exit triggers live.
 * So we drive the real movement hooks:
 *   • preMoveToken → reject a move onto a solid tile or off the map (return false).
 *   • moveToken    → after a move, fire the zone transition for the region the
 *                    token landed in (doors AND edge exits), via performTransit.
 * Keybindings + these hooks are registered from the system `init` hook.
 */

import { performTransit, findTransit } from "./regions.mjs";

const STEP_MS = 130;
const held = [];
let loopTimer = null;
let stepping = false;

function driverToken() {
  let t = (canvas?.tokens?.controlled ?? [])[0];
  if (!t) {
    const owned = (canvas?.tokens?.placeables ?? []).filter((x) => x.actor?.isOwner && x.actor?.type === "trainer");
    t = owned[0];
    if (t) t.control({ releaseOthers: true });
  }
  return t && t.document?.isOwner ? t : null;
}

/** Is tile (tx,ty) inside the scene and not blocked by the collision grid? */
function passable(scene, tx, ty) {
  const gs = scene?.grid?.size || 100;
  const cols = Math.floor((scene?.width || 0) / gs), rows = Math.floor((scene?.height || 0) / gs);
  if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) return false;
  const col = scene?.getFlag?.("pokemon-masters", "collision");
  if (!col?.rows?.length) return true;
  const row = col.rows[Math.min(ty, col.rows.length - 1)];
  return !(row && row[tx] === "1");
}

async function step() {
  if (stepping) return;
  const dir = held[held.length - 1];
  if (!dir) return;
  const t = driverToken();
  if (!t) return;
  const scene = t.document.parent, gs = canvas?.grid?.size || 100;
  const tx = Math.round(t.document.x / gs) + dir.dx;
  const ty = Math.round(t.document.y / gs) + dir.dy;
  if (!passable(scene, tx, ty)) return;
  stepping = true;
  try { await t.document.update({ x: tx * gs, y: ty * gs }, { animation: { duration: STEP_MS } }); }
  catch (err) { console.warn("Pokémon Masters | movement failed:", err); }
  finally { stepping = false; }
}

function startLoop() { if (loopTimer) return; step(); loopTimer = setInterval(() => { if (held.length) step(); else stopLoop(); }, STEP_MS); }
function stopLoop() { if (loopTimer) { clearInterval(loopTimer); loopTimer = null; } }
function press(dir) { try { if (!canvas?.ready) return false; if (!held.some((d) => d.id === dir.id)) held.push(dir); startLoop(); return true; } catch { return false; } }
function release(dir) { const i = held.findIndex((d) => d.id === dir.id); if (i >= 0) held.splice(i, 1); if (!held.length) stopLoop(); }

/* ---- v14 movement pipeline hooks ---- */

/** The final tile of a movement operation, as {tx,ty}, or null. */
function destTile(scene, movement, doc) {
  const gs = scene?.grid?.size || 100;
  const wp = movement?.destination
    ?? (Array.isArray(movement?.waypoints) ? movement.waypoints[movement.waypoints.length - 1] : null)
    ?? { x: doc.x, y: doc.y };
  if (wp?.x === undefined) return null;
  return { tx: Math.round(wp.x / gs), ty: Math.round(wp.y / gs) };
}

/** Reject a trainer-token move onto a solid tile or off the map. v14: return
 *  false from preMoveToken to cancel the whole movement. */
function onPreMove(doc, movement) {
  try {
    if (doc.actor?.type !== "trainer") return;
    const scene = doc.parent;
    const d = destTile(scene, movement, doc);
    if (!d) return;
    if (!passable(scene, d.tx, d.ty)) return false;   // off-map or solid → block
  } catch { /* never block on error */ }
}

/** After a move completes, fire the zone transition for the region the token
 *  landed in — the reliable trigger for doors AND scene-edge exits in v14. */
function onMoved(doc) {
  try {
    const actor = doc.actor;
    if (actor?.type !== "trainer" || !doc.parent) return;
    const sys = findTransit(doc.parent, doc);
    if (sys) performTransit(sys, doc, actor);
  } catch { /* ignore */ }
}

export function registerControls() {
  Hooks.on("preMoveToken", onPreMove);
  Hooks.on("moveToken", onMoved);
  const dirs = [
    { id: "moveUp", key: "KeyW", label: "Up", dx: 0, dy: -1 },
    { id: "moveDown", key: "KeyS", label: "Down", dx: 0, dy: 1 },
    { id: "moveLeft", key: "KeyA", label: "Left", dx: -1, dy: 0 },
    { id: "moveRight", key: "KeyD", label: "Right", dx: 1, dy: 0 }
  ];
  for (const dir of dirs) {
    game.keybindings.register("pokemon-masters", dir.id, {
      name: `Move ${dir.label}`,
      hint: `Walk your trainer's token ${dir.label.toLowerCase()} (hold to keep walking).`,
      editable: [{ key: dir.key }],
      onDown: () => press(dir),
      onUp: () => { release(dir); return true; }
    });
  }
}
