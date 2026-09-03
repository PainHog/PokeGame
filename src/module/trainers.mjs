/**
 * Pokémon Masters — overworld trainer challenges (line-of-sight).
 *
 * An NPC Trainer token can be given a line of sight: a facing direction and a
 * range. When a player's Trainer token steps into that straight line, the NPC
 * turns to face them, strides up, and challenges them — a click-through line of
 * dialogue, then the battle. Only ONE such challenge runs at a time (a global
 * lock), so trainers never mob a player; a defeated trainer won't re-challenge.
 *
 * Set up on the GM side by flagging an NPC Trainer token:
 *   token.setFlag("pokemon-masters","sight", { dir:"south", range:5, line:"Hey! You looked at me — battle!" })
 * The token's Actor must be a Trainer with a party (that's the opposing team).
 *
 * Written to the documented v13/v14 API; the movement/LoS behavior is the one
 * part that can only be fully proven inside a live Foundry world.
 */

import { isResponsible } from "./permissions.mjs";

const FLAG = "pokemon-masters";
const OPP = { north: "south", south: "north", east: "west", west: "east" };

/** Is a challenge already in progress on this client? (the one-at-a-time lock) */
function locked() { return !!game.pokemonMasters?._challengeActive; }
function setLock(v) { game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, { _challengeActive: v }); }

/** Grid coordinates of a token. */
function cell(scene, token) {
  const gs = scene?.grid?.size || 100;
  return { x: Math.round(token.x / gs), y: Math.round(token.y / gs), gs };
}

/**
 * Does the NPC (with a `sight` flag) see the player token in a straight line?
 * Pure geometry — exported for testing.
 */
export function inSight(npcCell, playerCell, sight) {
  const dir = sight?.dir; const range = sight?.range ?? 5;
  if (npcCell.x === playerCell.x) {
    if (dir === "north" && playerCell.y < npcCell.y && npcCell.y - playerCell.y <= range) return true;
    if (dir === "south" && playerCell.y > npcCell.y && playerCell.y - npcCell.y <= range) return true;
  }
  if (npcCell.y === playerCell.y) {
    if (dir === "west" && playerCell.x < npcCell.x && npcCell.x - playerCell.x <= range) return true;
    if (dir === "east" && playerCell.x > npcCell.x && playerCell.x - npcCell.x <= range) return true;
  }
  return false;
}

/** After a player token moves, see whether any NPC trainer now spots them. */
async function checkSpotting(playerToken) {
  try {
    if (locked()) return;
    const scene = playerToken.parent;
    const player = playerToken.actor;
    if (!scene || player?.type !== "trainer") return;
    if (!isResponsible(playerToken)) return;

    const pc = cell(scene, playerToken);
    for (const npc of scene.tokens) {
      if (npc.id === playerToken.id || npc.actor?.type !== "trainer") continue;
      const sight = npc.getFlag(FLAG, "sight");
      if (!sight || npc.getFlag(FLAG, "defeated")) continue;
      if (!inSight(cell(scene, npc), pc, sight)) continue;

      // Spotted! Lock, approach, and challenge (only the first one this pass).
      setLock(true);
      await approach(scene, npc, playerToken, sight);
      await challenge(npc, player, sight);
      return;
    }
  } catch (err) {
    console.warn("Pokémon Masters | trainer spotting failed", err);
    setLock(false);
  }
}

/** Walk the NPC in a straight line to the tile just short of the player. */
async function approach(scene, npc, playerToken, sight) {
  const gs = scene.grid.size || 100;
  const pc = cell(scene, playerToken);
  const step = { north: [0, 1], south: [0, -1], east: [-1, 0], west: [1, 0] }[sight.dir] ?? [0, 0];
  const tx = pc.x + step[0];
  const ty = pc.y + step[1];
  try {
    // Face the player, then move adjacent.
    const rotation = { north: 0, east: 90, south: 180, west: 270 }[OPP[sight.dir]] ?? npc.rotation;
    await npc.update({ x: tx * gs, y: ty * gs, rotation });
  } catch (err) { /* movement is best-effort */ }
}

/** Post the challenge dialogue with an Accept button that starts the battle. */
async function challenge(npc, player, sight) {
  const line = sight.line || "Our eyes met — that means we have to battle!";
  await ChatMessage.create({
    speaker: { alias: npc.name },
    content: `<div class="pm-encounter-card pm-challenge-card">
      <h3>⚔️ ${npc.name} wants to battle!</h3>
      <p>"${line}"</p>
      <button type="button" class="pm-challenge-btn" data-npc="${npc.uuid}" data-player="${player.uuid}">Accept the challenge</button>
    </div>`
  });
}

/** Configure an NPC trainer token's line of sight (GM helper). */
export async function setTrainerSight(token, { dir = "south", range = 5, line = "" } = {}) {
  const doc = token?.document ?? token;
  if (!doc?.setFlag) return ui.notifications?.warn("Select an NPC trainer token first.");
  await doc.setFlag(FLAG, "sight", { dir, range, line });
  await doc.unsetFlag(FLAG, "defeated");
  ui.notifications?.info(`${doc.name} will now challenge trainers to the ${dir} (range ${range}).`);
}

export function registerTrainerChallenges() {
  // A player token moving may step into a trainer's sight line.
  Hooks.on("updateToken", (tokenDoc, changes) => {
    if (("x" in changes) || ("y" in changes)) checkSpotting(tokenDoc);
  });

  // The Accept button opens the interactive on-map trainer battle (the same
  // popup as wild battles): the player picks moves, the foe's team fights back,
  // and victory pays prize money. The one-at-a-time lock is released when the
  // battle ENDS (onWin/onLose, which the window also fires if it's abandoned) —
  // not immediately — so a new challenge can't start mid-battle. Marking the NPC
  // defeated (so it won't re-challenge) is deferred to a win. If the window can't
  // open, fall back to the old auto-battle so the challenge still concludes.
  document.addEventListener("click", async (event) => {
    const btn = event.target?.closest?.(".pm-challenge-btn");
    if (!btn) return;
    event.preventDefault();
    btn.disabled = true;
    let started = false;
    try {
      const npc = await fromUuid(btn.dataset.npc);
      const player = await fromUuid(btn.dataset.player);
      const npcActor = npc?.actor ?? npc;
      if (npcActor && player) {
        const markDefeated = async () => {
          try {
            for (const t of npcActor.getActiveTokens?.() ?? []) await t.document?.setFlag(FLAG, "defeated", true).catch(() => {});
            if (npc?.setFlag) await npc.setFlag(FLAG, "defeated", true).catch(() => {});
          } catch (err) { /* soft */ }
        };
        // The player's token on the current scene (needed to place the battle).
        const playerToken = player.getActiveTokens?.(false, true)?.[0]
          ?? canvas?.scene?.tokens?.find((t) => t.actorId === player.id)
          ?? null;
        const foeParty = ((await npcActor.getParty?.()) ?? []).filter((p) => p?.type === "pokemon");
        const level = foeParty.length ? Math.max(...foeParty.map((p) => p.system?.level ?? 5)) : 5;
        const startTrainer = game.pokemonMasters?.wildBattle?.startTrainer;
        if (startTrainer && playerToken && foeParty.length) {
          started = await startTrainer(playerToken, {
            foeName: npcActor.name,
            foeImg: npcActor.img,
            foeSources: foeParty,
            prize: level * 30,
            onWin: () => { markDefeated(); setLock(false); },
            onLose: () => { setLock(false); }
          });
        }
        // Fallback: window couldn't open (no token, no party, or a battle is
        // already in progress) — resolve the old way, then release the lock.
        if (!started) {
          await game.pokemonMasters?.npc?.autoBattle?.(npcActor, player);
          await markDefeated();
        }
      }
    } catch (err) {
      console.warn("Pokémon Masters | trainer challenge failed", err);
    } finally {
      if (!started) setLock(false); // when the window opened, onWin/onLose owns the release
    }
  });

  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    trainers: { setSight: setTrainerSight, inSight }
  });
}
