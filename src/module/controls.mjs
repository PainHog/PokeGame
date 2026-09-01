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

import { performTransit, findTransit, justTeleported } from "./regions.mjs";

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

/** Which compass edge a tile (tx,ty) falls off of, given a W×H grid — or null. */
function offEdge(tx, ty, W, H) {
  if (ty < 0) return "north";
  if (ty >= H) return "south";
  if (tx < 0) return "west";
  if (tx >= W) return "east";
  return null;
}

/** A transit descriptor for this scene's edge exit in `dir`, or null. This is the
 *  DETERMINISTIC edge-travel path: the scene stores its exits by compass direction
 *  (flags.pokemon-masters.exits) at build time, so walking off an edge always
 *  transits — no dependence on v14 region hit-testing, which misfires at scene
 *  edges. performTransit still enforces requiredMove (Surf) and does the crossScene. */
function edgeExitSys(scene, dir) {
  const ex = scene?.getFlag?.("pokemon-masters", "exits")?.[dir];
  if (!ex?.scene) return null;
  return { destinationSceneName: ex.scene, destX: ex.x, destY: ex.y, requiredMove: ex.requiredMove || "" };
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
  // Don't act on a token that's mid-transition — it's about to be deleted and
  // re-created on another scene; updating it now throws "does not exist".
  if (justTeleported(t.actor?.id)) return;
  const scene = t.document.parent, gs = canvas?.grid?.size || 100;
  if (!scene?.tokens?.get(t.document.id)) return;   // token already gone (transit)
  const tx = Math.round(t.document.x / gs) + dir.dx;
  const ty = Math.round(t.document.y / gs) + dir.dy;
  if (!passable(scene, tx, ty)) {
    // Blocked because it's off the map? If that edge has an exit, travel through it
    // (walk to the edge and keep pressing → next zone). Otherwise just stop.
    const W = Math.round((scene?.width || 0) / gs), H = Math.round((scene?.height || 0) / gs);
    const dir2 = offEdge(tx, ty, W, H);
    const ex = dir2 && edgeExitSys(scene, dir2);
    if (ex) { console.log(`Pokémon Masters | walked off ${dir2} edge → ${ex.destinationSceneName}`); await performTransit(ex, t.document, t.actor); }
    return;
  }
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
    // v13.333 auto-rotates a token toward its travel direction (default on). Our
    // overworld sprites bake facing INTO the art (via the texture swap), so any
    // rotation lays the character on its side — turn it off, and hide the drag
    // ruler on these keyboard steps.
    try { movement.autoRotate = false; movement.showRuler = false; } catch { /* read-only fields */ }
    const scene = doc.parent;
    const d = destTile(scene, movement, doc);
    if (!d) return;
    if (!passable(scene, d.tx, d.ty)) return false;   // off-map or solid → block
  } catch { /* never block on error */ }
}

/** Reset any already-rotated player token upright + lock its rotation, so tokens
 *  placed before the auto-rotate fix (or freshly spawned) sit straight. */
function healTokenRotation() {
  try {
    for (const t of canvas?.tokens?.placeables ?? []) {
      const d = t.document;
      if (t.actor?.type === "trainer" && d?.isOwner && (d.rotation !== 0 || !d.lockRotation)) {
        d.update({ rotation: 0, lockRotation: true }, { animate: false }).catch(() => {});
      }
    }
  } catch { /* ignore */ }
}

// The updateToken hooks below are the RELIABLE path (they fire for every
// movement method in v14 with x/y in `change`), independent of the movement
// pipeline. preMoveToken above is a best-effort clean block; these guarantee it.
const lastPos = new Map();   // token id → {x,y} before its current move

/** Stash the pre-move position so we can bounce an illegal move back. */
function onPreUpdate(doc, change) {
  if (change.x === undefined && change.y === undefined) return;
  if (doc.actor?.type !== "trainer") return;
  lastPos.set(doc.id, { x: doc.x, y: doc.y });
}

/** After a move lands: bounce back if it went off-map / onto a solid tile, else
 *  fire the zone transition for whatever region the token is now in. */
async function onUpdate(doc, change, options, userId) {
  try {
    if (change.x === undefined && change.y === undefined) return;
    if (options?.pmBounce) return;                    // our own bounce-back
    if (doc.actor?.type !== "trainer" || userId !== game.user?.id || !doc.parent) return;
    if (justTeleported(doc.actor.id)) return;         // mid-transition; ignore
    const scene = doc.parent, gs = scene.grid?.size || 32;
    // The document position can lag during animated movement — trust `change`.
    const nx = change.x ?? doc.x, ny = change.y ?? doc.y;
    const tx = Math.round(nx / gs), ty = Math.round(ny / gs);
    const W = Math.round((scene.width || 0) / gs), H = Math.round((scene.height || 0) / gs);
    const off = tx < 0 || ty < 0 || tx >= W || ty >= H;
    const col = scene.getFlag?.("pokemon-masters", "collision");
    const solid = !off && !!col?.rows?.length && col.rows[ty]?.[tx] === "1";
    if (off || solid) {
      // Walked/dragged off an edge that leads somewhere → travel there instead of bouncing.
      if (off) {
        const dir = offEdge(tx, ty, W, H);
        const ex = dir && edgeExitSys(scene, dir);
        if (ex) { console.log(`Pokémon Masters | [${scene.name}] off ${dir} edge → ${ex.destinationSceneName}`); await performTransit(ex, doc, doc.actor); return; }
      }
      const back = lastPos.get(doc.id);
      console.log(`Pokémon Masters | [${scene.name}] blocked move to (${tx},${ty}) of ${W}x${H} [off=${off} solid=${solid}] — bounce to`, back);
      if (back) await doc.update({ x: back.x, y: back.y }, { pmBounce: true, animate: false });
      return;
    }
    const sys = findTransit(scene, doc, nx, ny);
    console.log(`Pokémon Masters | [${scene.name}] moved to (${tx},${ty}) of ${W}x${H}; transit here:`, sys ? (sys.destinationSceneName || (sys.returnDoor ? "return-door" : "interior")) : "none");
    if (sys) await performTransit(sys, doc, doc.actor);
  } catch (err) { console.warn("Pokémon Masters | move handler error", err); }
}

export function registerControls() {
  Hooks.on("preMoveToken", onPreMove);        // best-effort clean block + autoRotate off
  Hooks.on("preUpdateToken", onPreUpdate);    // stash pre-move position
  Hooks.on("updateToken", onUpdate);          // reliable: bounce off-map/solid + fire transit
  Hooks.on("canvasReady", healTokenRotation);
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
