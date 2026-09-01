/**
 * Pokémon Masters — WASD / arrow-key overworld movement.
 *
 * Foundry's native arrow-key movement steps one grid cell per keypress and leans
 * on the OS key-repeat, which feels laggy. This drives its own step loop: while a
 * direction key is held the token walks continuously and smoothly (a short glide
 * per tile). It also respects per-scene collision (a flags.pokemon-masters.collision
 * grid, when present) so you can't walk onto buildings, trees, cliffs or water, and
 * never leaves the map.
 *
 * Keybindings MUST be registered during Foundry's `init` hook.
 */

const STEP_MS = 130;              // ms per tile (also the glide duration → continuous)
const held = [];                  // stack of held directions; the last one wins
let loopTimer = null;
let stepping = false;

/** The token this user drives: the controlled one, else their own trainer token. */
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
  if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) return false;         // off the map
  const col = scene?.getFlag?.("pokemon-masters", "collision");
  if (!col?.rows?.length) return true;                                    // no data → walkable
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
  if (!passable(scene, tx, ty)) return;                                   // blocked — hold position
  stepping = true;
  try {
    await t.document.update({ x: tx * gs, y: ty * gs }, { animation: { duration: STEP_MS } });
  } catch (err) {
    console.warn("Pokémon Masters | movement failed:", err);
  } finally {
    stepping = false;
  }
}

function startLoop() {
  if (loopTimer) return;
  step();                                                                 // instant first step
  loopTimer = setInterval(() => { if (held.length) step(); else stopLoop(); }, STEP_MS);
}
function stopLoop() { if (loopTimer) { clearInterval(loopTimer); loopTimer = null; } }

function press(dir) {
  try {
    if (!canvas?.ready) return false;
    if (!held.some((d) => d.id === dir.id)) held.push(dir);
    startLoop();
    return true;
  } catch { return false; }
}
function release(dir) {
  const i = held.findIndex((d) => d.id === dir.id);
  if (i >= 0) held.splice(i, 1);
  if (!held.length) stopLoop();
}

/** Block any trainer-token move onto an impassable tile or off the map — enforced
 *  for EVERY movement method (arrow keys, drag, our WASD, macros), not just our
 *  own step loop, so you can't walk through buildings/trees or into the black. */
function enforceCollision(tokenDoc, change) {
  try {
    if (change.x === undefined && change.y === undefined) return;   // not a move
    if (tokenDoc.actor?.type !== "trainer") return;                 // only player characters
    const scene = tokenDoc.parent; const gs = scene?.grid?.size || 32;
    const W = Math.round((scene?.width || 0) / gs), H = Math.round((scene?.height || 0) / gs);
    const tx = Math.round((change.x ?? tokenDoc.x) / gs), ty = Math.round((change.y ?? tokenDoc.y) / gs);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;       // off the map (black padding)
    const col = scene?.getFlag?.("pokemon-masters", "collision");
    if (col?.rows?.length && col.rows[ty]?.[tx] === "1") return false;  // solid tile
  } catch { /* never block movement on an error */ }
}

export function registerControls() {
  Hooks.on("preUpdateToken", enforceCollision);
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
