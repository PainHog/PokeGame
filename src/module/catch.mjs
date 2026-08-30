/**
 * Pokémon Masters — the catch flow.
 *
 * Throw a Poké Ball at a wild Pokémon; odds follow the classic Gen III/IV
 * formula (HP left × catch rate × ball bonus × status bonus), resolved as up to
 * four "shakes". A success imports the species into the world, levels/rolls it,
 * and adds it to the thrower's party.
 *
 * `computeCatch` is a pure function (dependency-injected RNG) so it can be unit
 * tested outside Foundry. Everything else touches game state and only runs in a
 * live client.
 */

import { PM } from "./config.mjs";
import { addToParty } from "./storage.mjs";
import { ballBonus, BALL_NAMES } from "./balls.mjs";
import { markCaught, hasCaught } from "./dex.mjs";

/** Status multipliers on the catch rate (classic values). */
export const STATUS_BONUS = {
  none: 1,
  sleep: 2,
  freeze: 2,
  paralysis: 1.5,
  burn: 1.5,
  poison: 1.5
};

/**
 * The Gen III/IV catch calculation.
 * @param {object} o
 * @param {number} o.hpFraction  Target HP as a fraction of max (0–1). Lower = easier.
 * @param {number} o.catchRate   Species catch rate (1–255).
 * @param {number} [o.ballBonus] Ball multiplier (Poké 1×, Great 1.5×, Ultra 2×, Master 255×).
 * @param {number} [o.statusBonus] Status multiplier.
 * @param {() => number} [o.rng] Random source in [0,1). Injectable for tests.
 * @returns {{a:number, b:number, shakes:number, caught:boolean, chancePct:number, guaranteed:boolean}}
 */
export function computeCatch({ hpFraction = 1, catchRate, ballBonus = 1, statusBonus = 1, rng = Math.random }) {
  const frac = Math.max(0, Math.min(1, hpFraction));
  // (3*max - 2*cur) / (3*max)  ==  1 - (2/3)*fraction  →  ranges 1/3 (full) … 1 (near 0).
  const hpFactor = 1 - (2 / 3) * frac;
  const a = hpFactor * catchRate * ballBonus * statusBonus;

  if (a >= 255) return { a, b: 65535, shakes: 4, caught: true, chancePct: 100, guaranteed: true };
  if (a <= 0) return { a, b: 0, shakes: 0, caught: false, chancePct: 0, guaranteed: false };

  const b = Math.floor(1048560 / Math.sqrt(Math.sqrt(16711680 / a)));
  const perShake = b / 65536;
  let shakes = 0;
  for (let i = 0; i < 4; i++) {
    if (Math.floor(rng() * 65536) < b) shakes++;
    else break;
  }
  return {
    a,
    b,
    shakes,
    caught: shakes === 4,
    chancePct: Math.round(Math.pow(perShake, 4) * 1000) / 10,
    guaranteed: false
  };
}

/* -------------------------------------------- */
/*  Live-game helpers (Foundry only)             */
/* -------------------------------------------- */

async function findSpeciesByName(name) {
  const pack = game.packs.get("pokemon-masters.species");
  if (!pack) return null;
  const key = String(name).toLowerCase();
  const entry = pack.index.find((e) => e.name.toLowerCase() === key);
  return entry ? pack.getDocument(entry._id) : null;
}

/** The acting trainer: the user's assigned character, else their first owned Trainer. */
export function resolveTrainer() {
  const char = game.user.character;
  if (char?.type === "trainer") return char;
  return game.actors.find((a) => a.type === "trainer" && a.isOwner) ?? null;
}

/** HTML for a "Throw Poké Ball" button embedded in an encounter chat card. */
export function catchButtonHtml({ speciesUuid, level, shiny = false }) {
  return `<button type="button" class="pm-catch-btn"
    data-species-uuid="${speciesUuid}" data-level="${level}" data-shiny="${shiny}">
    ⚪ Throw Poké Ball</button>`;
}

/** Ask the thrower which ball to use (owned balls first). Falls back to Poké Ball. */
async function pickBall(trainer) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  // Balls the trainer carries, then the standard list.
  const owned = (trainer?.items ?? []).filter((i) => i.type === "gear" && i.system.category === "ball").map((i) => i.name);
  const names = [...new Set([...owned, ...BALL_NAMES])];
  try {
    if (!DialogV2) return names[0];
    const options = names.map((n) => `<option value="${n}">${n} (${(PM.ballModifiers[n.toLowerCase()] ?? 1)}×)</option>`).join("");
    const ball = await DialogV2.prompt({
      window: { title: "Throw which ball?" },
      content: `<p>Choose a Poké Ball:</p><select name="ball" style="width:100%">${options}</select>`,
      ok: { label: "Throw", callback: (event, button) => button.form.elements.ball.value }
    });
    return ball ?? names[0];
  } catch (err) {
    return names[0];
  }
}

/**
 * Attempt to catch a wild Pokémon. Posts a chat card and, on success, imports
 * and configures the caught Pokémon for the trainer.
 */
export async function attemptCatch({
  trainer = null, speciesUuid = null, speciesName = null, level = 5,
  ballName = null, hpFraction = 1, status = "none", shiny = false, token = null
} = {}) {
  const species = speciesUuid ? await fromUuid(speciesUuid) : await findSpeciesByName(speciesName);
  if (!species) return ui.notifications?.warn("Pokémon Masters: unknown species.");

  trainer ??= resolveTrainer();
  ballName ??= await pickBall(trainer);

  const catchRate = species.system.catchRate ?? 45;
  const bonus = ballBonus(ballName, {
    targetTypes: species.system.types,
    targetLevel: level,
    userLevel: trainer?.system?.level ?? level,
    baseSpe: species.system.baseStats?.spe,
    method: token?.method ?? "walk",
    turn: 1,
    status,
    ultraBeast: species.system.ultraBeast,
    evoItem: species.system.evolution?.item,
    caughtBefore: hasCaught(trainer, species.name)
  });
  const statusBonus = STATUS_BONUS[status] ?? 1;
  const res = computeCatch({ hpFraction, catchRate, ballBonus: bonus, statusBonus });

  const wobble = "●".repeat(res.shakes) + "○".repeat(Math.max(0, (res.caught ? 3 : res.shakes + 1) - res.shakes));
  const verdict = res.caught
    ? `<p class="pm-caught">Gotcha! <strong>${species.name}</strong> was caught!</p>`
    : `<p class="pm-broke">Oh no! The Pokémon broke free after ${res.shakes} shake${res.shakes === 1 ? "" : "s"}.</p>`;

  await ChatMessage.create({
    speaker: { alias: trainer?.name ?? "Trainer" },
    content: `
      <div class="pm-encounter-card">
        <h3>${ballName} → wild ${species.name} (Lv ${level})</h3>
        <p class="pm-wobble">${wobble}</p>
        <p><small>Catch chance ≈ ${res.guaranteed ? "100" : res.chancePct}% &nbsp;·&nbsp; ${bonus === Infinity ? "∞" : bonus}× ball${statusBonus !== 1 ? ` · ${statusBonus}× status` : ""}</small></p>
        ${verdict}
      </div>`
  });

  if (res.caught) await finalizeCapture({ trainer, species, level, shiny, token });
  return res;
}

/** Import the caught species, configure it, and add it to the trainer's party. */
async function finalizeCapture({ trainer, species, level, shiny, token }) {
  if (!game.user.isGM && !game.user.can("ACTOR_CREATE")) {
    ui.notifications?.info(`${species.name} was caught — ask your GM to add it to your party.`);
    return;
  }
  // Claim the spawned wild's own Actor if there is one (avoids orphaning it in
  // the directory); otherwise import a fresh Actor from the species.
  let created = token?.actorId ? game.actors.get(token.actorId) : null;
  if (created) {
    const upd = { "system.level": level, "system.shiny": !!shiny };
    if (trainer) upd["system.trainer"] = trainer.uuid;
    await created.update(upd);
  } else {
    const source = species.toObject();
    delete source._id;
    source.folder = null;
    source.system.level = level;
    source.system.shiny = !!shiny;
    source.system.hp = { value: null, max: 0 };
    if (trainer) source.system.trainer = trainer.uuid;
    created = await Actor.implementation.create(source);
  }
  if (!created) return;

  // Remove the wild token from the scene if this was a spawned encounter.
  if (token?.id && token.parent) await token.parent.deleteEmbeddedDocuments("Token", [token.id]);

  if (trainer) {
    const where = await addToParty(trainer, created);
    await markCaught(trainer, species.name);
    if (where === "storage") ui.notifications?.info(`${species.name} was caught and sent to the PC (party full).`);
  }
}

/** Throw at the user's current target (a wild Pokémon token). */
export async function throwAtTarget() {
  const target = [...(game.user.targets ?? [])][0];
  const actor = target?.actor;
  if (!actor || actor.type !== "pokemon") {
    return ui.notifications?.warn("Target a wild Pokémon first.");
  }
  const hp = actor.system.hp ?? {};
  const hpFraction = hp.max ? (hp.value ?? hp.max) / hp.max : 1;
  return attemptCatch({
    speciesName: actor.system.species?.name || actor.name,
    level: actor.system.level ?? 5,
    hpFraction,
    status: actor.system.status ?? "none",
    shiny: actor.system.shiny,
    token: target.document
  });
}

/** Wire up the chat-button listener, token-HUD button, and public API. */
export function registerCatchHooks() {
  // Delegated listener for the "Throw Poké Ball" button in encounter cards.
  document.addEventListener("click", (event) => {
    const btn = event.target?.closest?.(".pm-catch-btn");
    if (!btn) return;
    event.preventDefault();
    attemptCatch({
      speciesUuid: btn.dataset.speciesUuid,
      level: Number(btn.dataset.level) || 5,
      shiny: btn.dataset.shiny === "true"
    });
  });

  // A "catch" button on the Token HUD for wild (hostile) Pokémon tokens.
  Hooks.on("renderTokenHUD", (hud, html) => {
    try {
      const token = hud.object?.document;
      if (token?.actor?.type !== "pokemon") return;
      if (token.disposition > 0) return; // friendly/owned — not catchable
      const root = html instanceof HTMLElement ? html : html?.[0];
      const col = root?.querySelector(".col.left") ?? root;
      if (!col) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "control-icon pm-hud-catch";
      btn.innerHTML = "⚪";
      btn.title = "Throw Poké Ball";
      btn.addEventListener("click", () => {
        const hp = token.actor.system.hp ?? {};
        attemptCatch({
          speciesName: token.actor.system.species?.name || token.actor.name,
          level: token.actor.system.level ?? 5,
          hpFraction: hp.max ? (hp.value ?? hp.max) / hp.max : 1,
          status: token.actor.system.status ?? "none",
          shiny: token.actor.system.shiny,
          token
        });
      });
      col.appendChild(btn);
    } catch (err) {
      console.warn("Pokémon Masters | Could not add catch button to Token HUD", err);
    }
  });

  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    catch: { attempt: attemptCatch, compute: computeCatch, throwAtTarget }
  });
}
