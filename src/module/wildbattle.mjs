/**
 * Pokémon Masters — on-map, turn-based WILD POKÉMON BATTLE.
 *
 * When a wild Pokémon appears in grass/caves, the trainer's LEAD Pokémon is sent
 * out opposite it and a battle window opens with FIGHT / CATCH / RUN. Damage is
 * resolved through the shared battle engine (battle.mjs), catches through the
 * catch flow (catch.mjs), and XP is granted by the `pmPokemonFainted` hook that
 * `useMove` already fires when the wild faints. Everything runs on the acting
 * client (the responsible client that chose the encounter), so no GM is required.
 *
 * The wild's counterattack is driven manually (autoRetaliate:false) rather than
 * relying on `useMove`'s built-in retaliation: in GM-less play the acting player
 * must OWN the freshly-created wild actor to apply damage to it, which makes it
 * `hasPlayerOwner` and would suppress the engine's `!hasPlayerOwner` auto-reply.
 * Manual replies fight back reliably whether a GM is present or not.
 */

import { placeToken, removeToken } from "./placement.mjs";
import { leadPokemon } from "./storage.mjs";
import { applyIndividuality } from "./individuality.mjs";

const FLAG = "pokemon-masters";

// Only one wild battle at a time. A second encounter while one is open is ignored
// (falls back to the announce/catch card).
let battleLock = false;
let activeApp = null;

const { ApplicationV2 } = foundry.applications.api;

/* -------------------------------------------- */
/*  Battle window                                */
/* -------------------------------------------- */

/**
 * The wild-battle window. Rendered as inline HTML (no Handlebars PART): we
 * override `_renderHTML` to return an HTML string and `_replaceHTML` to inject it
 * and wire the button listeners.
 */
export class WildBattleApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pm-wild-battle",
    classes: ["pokemon-masters", "pm-sheet", "pm-wild-battle-app"],
    position: { width: 520 },
    window: { title: "Wild Battle", icon: "fa-solid fa-khanda" }
  };

  constructor(state = {}, options = {}) {
    super(options);
    this.trainer = state.trainer;
    this.scene = state.scene;
    this.playerToken = state.playerToken;
    this.lead = state.lead;
    this.leadToken = state.leadToken;
    this.wildActor = state.wildActor;
    this.wildToken = state.wildToken;
    this.speciesActor = state.speciesActor;
    this.level = state.level;
    this.busy = false;          // in-flight lock (blocks double-clicks during resolution)
    this.cleaned = false;       // cleanup runs exactly once
    this.wildClaimed = false;   // set when a catch hands the wild actor to the trainer
    this.fightExpanded = false; // FIGHT sub-menu open?
    this.msg = "A wild Pokémon appeared!";
  }

  /* --- render ------------------------------------------------ */

  async _prepareContext() { return {}; }

  async _renderHTML() { return this.#buildHtml(); }

  _replaceHTML(result, content) {
    content.innerHTML = result;
    for (const el of content.querySelectorAll("[data-wb]")) {
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        const a = el.dataset.wb;
        if (a === "fight") this.#onFight();
        else if (a === "catch") this.#onCatch();
        else if (a === "run") this.#onRun();
        else if (a === "back") { this.fightExpanded = false; if (!this.cleaned) this.render(); }
      });
    }
    for (const el of content.querySelectorAll("[data-move-id]")) {
      el.addEventListener("click", (ev) => { ev.preventDefault(); this.#onPickMove(el.dataset.moveId); });
    }
  }

  #buildHtml() {
    return `<style>
      .pm-wild-battle-app .window-content { padding: 0; }
      .pm-wb { padding: 10px 12px 12px; font-size: 13px; }
      .pm-wb-field { display: flex; align-items: stretch; gap: 8px; }
      .pm-wb-panel { flex: 1 1 0; text-align: center; border: 1px solid var(--color-border-light-primary, #999); border-radius: 8px; padding: 8px; background: rgba(0,0,0,0.04); }
      .pm-wb-tag { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
      .pm-wb-sprite { display: block; margin: 4px auto; width: 84px; height: 84px; object-fit: contain; image-rendering: auto; }
      .pm-wb-name { font-weight: 700; }
      .pm-wb-lv { font-weight: 400; opacity: .8; }
      .pm-wb-types { font-size: 11px; opacity: .7; margin-bottom: 4px; min-height: 1em; }
      .pm-wb-hpbar { height: 9px; border-radius: 5px; background: rgba(0,0,0,0.25); overflow: hidden; }
      .pm-wb-hpfill { height: 100%; transition: width .3s ease; }
      .pm-wb-hptext { font-size: 11px; margin-top: 2px; }
      .pm-wb-status { text-transform: uppercase; font-size: 9px; font-weight: 700; padding: 1px 4px; border-radius: 4px; background: #7e57c2; color: #fff; margin-left: 3px; }
      .pm-wb-vs { align-self: center; font-weight: 700; opacity: .6; }
      .pm-wb-row, .pm-wb-moves { display: flex; gap: 8px; margin-top: 10px; }
      .pm-wb-moves { flex-wrap: wrap; }
      .pm-wb-btn { flex: 1 1 0; min-width: 120px; padding: 8px 6px; border-radius: 8px; cursor: pointer; font-weight: 700; border: 1px solid var(--color-border-dark, #444); }
      .pm-wb-move { display: flex; flex-direction: column; align-items: center; line-height: 1.2; }
      .pm-wb-move small { font-weight: 400; opacity: .7; }
      .pm-wb-back { flex: 0 0 auto; min-width: 0; }
      .pm-wb-msg { margin-top: 10px; min-height: 1.2em; font-style: italic; opacity: .85; }
      .pm-wild-battle-app .pm-wb-btn[disabled] { opacity: .5; cursor: default; }
    </style>
    <div class="pm-wb${this.busy ? " pm-wb-busy" : ""}">
      <div class="pm-wb-field">
        ${this.#panelHtml(this.lead, this.trainer?.name ?? "You")}
        <div class="pm-wb-vs">VS</div>
        ${this.#panelHtml(this.wildActor, "Wild")}
      </div>
      ${this.#actionsHtml()}
      <div class="pm-wb-msg">${this.msg ?? ""}</div>
    </div>`;
  }

  #panelHtml(actor, label) {
    if (!actor) return `<div class="pm-wb-panel"><div class="pm-wb-tag">${label}</div></div>`;
    const s = actor.system ?? {};
    const hp = s.hp ?? {};
    const max = hp.max || 1;
    const val = Math.max(0, hp.value ?? max);
    const pct = Math.max(0, Math.min(100, Math.round((val / max) * 100)));
    const color = pct > 50 ? "#4caf50" : pct > 20 ? "#ff9800" : "#f44336";
    const status = s.status && s.status !== "none" ? `<span class="pm-wb-status">${s.status}</span>` : "";
    const types = (s.types ?? []).join(" / ");
    return `<div class="pm-wb-panel">
      <div class="pm-wb-tag">${label}</div>
      <img class="pm-wb-sprite" src="${actor.img}" alt="${actor.name}">
      <div class="pm-wb-name">${actor.name} <span class="pm-wb-lv">Lv ${s.level ?? 5}</span></div>
      <div class="pm-wb-types">${types}</div>
      <div class="pm-wb-hpbar"><div class="pm-wb-hpfill" style="width:${pct}%;background:${color}"></div></div>
      <div class="pm-wb-hptext">${val} / ${max} HP ${status}</div>
    </div>`;
  }

  #actionsHtml() {
    const dis = this.busy ? " disabled" : "";
    if (this.fightExpanded) {
      const moves = this.lead?.items?.filter((i) => i.type === "move").slice(0, 4) ?? [];
      const buttons = moves.length
        ? moves.map((m) => {
            const t = m.system?.moveType ?? "Normal";
            const p = m.system?.power ? ` · ${m.system.power}` : "";
            return `<button type="button" class="pm-wb-btn pm-wb-move" data-move-id="${m.id}"${dis}>${m.name}<small>${t}${p}</small></button>`;
          }).join("")
        : `<button type="button" class="pm-wb-btn pm-wb-move" data-move-id="__struggle"${dis}>Struggle<small>Normal · 50</small></button>`;
      return `<div class="pm-wb-moves">${buttons}</div>
        <div class="pm-wb-row"><button type="button" class="pm-wb-btn pm-wb-back" data-wb="back"${dis}>◀ Back</button></div>`;
    }
    return `<div class="pm-wb-row">
      <button type="button" class="pm-wb-btn" data-wb="fight"${dis}>⚔ Fight</button>
      <button type="button" class="pm-wb-btn" data-wb="catch"${dis}>⚪ Catch</button>
      <button type="button" class="pm-wb-btn" data-wb="run"${dis}>🏃 Run</button>
    </div>`;
  }

  /* --- actions ----------------------------------------------- */

  #onFight() {
    if (this.busy || this.cleaned) return;
    this.fightExpanded = !this.fightExpanded;
    this.render();
  }

  async #onPickMove(id) {
    if (this.busy || this.cleaned) return;
    this.busy = true;
    this.fightExpanded = false;
    this.render();
    try {
      const battle = game.pokemonMasters?.battle;
      const move = (id === "__struggle") ? this.#struggle() : (this.lead.items.get(id) ?? this.#struggle());
      this.msg = `${this.lead.name} used ${move.name}!`;
      await battle.useMove(this.lead, move, { actor: this.wildActor, token: this.wildToken }, { autoRetaliate: false });
      if ((this.wildActor.system.hp?.value ?? 0) <= 0) return void (await this.#victory());
      await this.#wildTurn();
      if ((this.wildActor.system.hp?.value ?? 0) <= 0) return void (await this.#victory());
      if ((this.lead.system.hp?.value ?? 1) <= 0) return void (await this.#recallAndSendNext());
    } catch (err) {
      console.warn("Pokémon Masters | wild battle FIGHT failed", err);
    } finally {
      this.busy = false;
      if (!this.cleaned) this.render();
    }
  }

  async #onCatch() {
    if (this.busy || this.cleaned) return;
    this.busy = true;
    this.render();
    try {
      const res = await game.pokemonMasters?.catch?.attempt({
        trainer: this.trainer,
        speciesUuid: this.speciesActor?.uuid,
        level: this.wildActor.system.level,
        hpFraction: this.#wildHpFraction(),
        status: this.wildActor.system.status ?? "none",
        token: this.wildToken
      });
      if (res?.caught) {
        // finalizeCapture already claimed the wild actor into the party/storage
        // and deleted its token — never delete that actor in cleanup.
        this.wildClaimed = true;
        this.wildToken = null;
        await removeToken(this.scene, this.lead).catch(() => {}); // recall the lead
        return void (await this.#end());
      }
      // Broke free → the wild gets a free turn.
      await this.#wildTurn();
      if ((this.wildActor.system.hp?.value ?? 0) <= 0) return void (await this.#victory());
      if ((this.lead.system.hp?.value ?? 1) <= 0) return void (await this.#recallAndSendNext());
    } catch (err) {
      console.warn("Pokémon Masters | wild battle CATCH failed", err);
    } finally {
      this.busy = false;
      if (!this.cleaned) this.render();
    }
  }

  async #onRun() {
    if (this.busy || this.cleaned) return;
    this.busy = true;
    this.render();
    try {
      const leadSpe = this.lead.system.stats?.spe ?? 1;
      const wildSpe = this.wildActor.system.stats?.spe ?? 1;
      const odds = leadSpe >= wildSpe ? 0.9 : 0.5;
      if (Math.random() < odds) {
        await ChatMessage.create({ speaker: { alias: "Wild Battle" }, content: `<div class="pm-battle-card"><p>Got away safely!</p></div>` }).catch(() => {});
        return void (await this.#end());
      }
      this.msg = "Couldn't get away!";
      await ChatMessage.create({ speaker: { alias: "Wild Battle" }, content: `<div class="pm-battle-card"><p>${this.trainer.name} couldn't get away!</p></div>` }).catch(() => {});
      await this.#wildTurn();
      if ((this.wildActor.system.hp?.value ?? 0) <= 0) return void (await this.#victory());
      if ((this.lead.system.hp?.value ?? 1) <= 0) return void (await this.#recallAndSendNext());
    } catch (err) {
      console.warn("Pokémon Masters | wild battle RUN failed", err);
    } finally {
      this.busy = false;
      if (!this.cleaned) this.render();
    }
  }

  /* --- battle helpers ---------------------------------------- */

  /** The wild's turn: pick its best move and strike the lead, then status chip. */
  async #wildTurn() {
    const battle = game.pokemonMasters?.battle;
    const npc = game.pokemonMasters?.npc;
    if (battle && npc && (this.wildActor.system.hp?.value ?? 0) > 0 && (this.lead.system.hp?.value ?? 0) > 0) {
      try {
        const move = npc.chooseBestMove(npc.combatantFromActor(this.wildActor), npc.combatantFromActor(this.lead));
        if (move) await battle.useMove(this.wildActor, move, { actor: this.lead, token: this.leadToken }, { autoRetaliate: false });
      } catch (err) {
        console.warn("Pokémon Masters | wild counterattack failed", err);
      }
    }
    // End-of-turn burn/poison/toxic chip on both survivors (parity with the engine).
    if (battle?.applyEndOfTurn) {
      try { if ((this.lead.system.hp?.value ?? 0) > 0) await battle.applyEndOfTurn(this.lead); } catch (err) { /* soft */ }
      try { if ((this.wildActor.system.hp?.value ?? 0) > 0) await battle.applyEndOfTurn(this.wildActor); } catch (err) { /* soft */ }
    }
  }

  /** The wild fainted — announce, then end the battle. XP was granted by the
   *  `pmPokemonFainted` hook `useMove` fired when the lead landed the KO. */
  async #victory() {
    await ChatMessage.create({
      speaker: { alias: "Wild Battle" },
      content: `<div class="pm-battle-card"><p class="pm-caught">The wild ${this.wildActor.name} fainted! ${this.lead.name} won the battle.</p></div>`
    }).catch(() => {});
    await this.#end();
  }

  /** Recall the fainted lead and send out the next usable party member, or end. */
  async #recallAndSendNext() {
    await removeToken(this.scene, this.lead).catch(() => {});
    const next = await leadPokemon(this.trainer);
    if (!next) {
      await ChatMessage.create({
        speaker: { alias: "Wild Battle" },
        content: `<div class="pm-battle-card"><p>${this.trainer.name} is out of usable Pokémon!</p></div>`
      }).catch(() => {});
      ui.notifications?.info("You're out of usable Pokémon!");
      return void (await this.#end());
    }
    this.lead = next;
    const pos = this.#leadPos();
    this.leadToken = (await placeToken(this.scene, next, { x: pos.x, y: pos.y, linked: true, overrides: { disposition: 1 } })) ?? this.leadToken;
    this.msg = `${this.trainer.name} sent out ${next.name}!`;
    await ChatMessage.create({
      speaker: { alias: this.trainer.name },
      content: `<div class="pm-battle-card"><p>Go, <strong>${next.name}</strong>!</p></div>`
    }).catch(() => {});
    // The caller's `finally` re-renders with the new lead.
  }

  /** Struggle fallback when a Pokémon somehow knows no moves. */
  #struggle() {
    return { name: "Struggle", system: { moveType: "Normal", category: "Physical", power: 50, accuracy: 100 } };
  }

  #wildHpFraction() {
    const hp = this.wildActor.system.hp ?? {};
    const max = hp.max || 1;
    return (hp.value ?? max) / max;
  }

  #gs() { return this.scene?.grid?.size || 100; }
  #leadPos() { const gs = this.#gs(); return { x: (this.playerToken?.x ?? 0) - gs, y: this.playerToken?.y ?? 0 }; }

  /* --- teardown ---------------------------------------------- */

  /** End the battle: clean up, then close the window. */
  async #end() {
    await this.#cleanup();
    this.close();
  }

  /**
   * Remove both temporary battle tokens and, unless it was caught, the temporary
   * wild actor — so nothing is orphaned. Idempotent; releases the battle lock.
   */
  async #cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;
    try { if (this.lead) await removeToken(this.scene, this.lead); } catch (err) { /* soft */ }
    try {
      if (this.wildToken?.id && this.scene?.tokens?.get(this.wildToken.id)) {
        await this.scene.deleteEmbeddedDocuments("Token", [this.wildToken.id]);
      }
    } catch (err) { /* soft */ }
    try {
      // Only delete the throwaway wild actor if it wasn't caught (still ownerless).
      if (this.wildActor && !this.wildClaimed && !this.wildActor.system?.trainer && game.actors.get(this.wildActor.id)) {
        await this.wildActor.delete();
      }
    } catch (err) { /* soft */ }
    battleLock = false;
    if (activeApp === this) activeApp = null;
  }

  async _onClose(options) {
    await this.#cleanup();
    return super._onClose?.(options);
  }
}

/* -------------------------------------------- */
/*  Entry point                                  */
/* -------------------------------------------- */

/**
 * Begin an on-map wild battle: send out the trainer's lead opposite a freshly
 * spawned wild Pokémon and open the battle window. Falls back to `announce`
 * (the catch card) when the trainer has no usable Pokémon, a battle is already
 * open, or this client can't create the wild actor. Returns true iff a battle
 * actually opened.
 *
 * @param {TokenDocument} playerToken  the acting trainer's token
 * @param {Actor} speciesActor         the compendium species document
 * @param {number} level               the wild's level
 * @param {{announce?: () => any}} [opts]  fallback that posts the catch card
 */
export async function startWildBattle(playerToken, speciesActor, level, { announce } = {}) {
  const fallback = async () => { try { await announce?.(); } catch (err) { /* soft */ } };
  try {
    const trainer = playerToken?.actor;
    // Only a real player Trainer battles — never a placed NPC (Nurse Joy, …).
    if (!trainer || trainer.type !== "trainer" || trainer.getFlag?.(FLAG, "isNpc")) return (await fallback(), false);
    if (battleLock) return (await fallback(), false); // one wild battle at a time
    const scene = playerToken.parent;
    if (!scene || !speciesActor) return (await fallback(), false);

    const lead = await leadPokemon(trainer);
    if (!lead) return (await fallback(), false); // no usable Pokémon → just the catch card

    // Committed — claim the lock before any await that could let a second roll in.
    battleLock = true;

    // Undo everything placed so far and fall back to the catch card.
    const bail = async (wildActor, wildToken) => {
      try { if (wildToken?.id && scene.tokens?.get(wildToken.id)) await scene.deleteEmbeddedDocuments("Token", [wildToken.id]); } catch (err) { /* soft */ }
      try { await removeToken(scene, lead); } catch (err) { /* soft */ }
      try { if (wildActor && game.actors.get(wildActor.id)) await wildActor.delete(); } catch (err) { /* soft */ }
      battleLock = false;
      await fallback();
      return false;
    };

    // Create the wild actor exactly like regions.spawnWild, but owned by this
    // client so it can apply damage to it (required for GM-less play). The
    // `wildBattle` flag stops progression from awarding the throwaway wild XP (and
    // popping an evolve dialog) if it happens to KO the trainer's Pokémon.
    let wildActor = null;
    try {
      const source = speciesActor.toObject();
      delete source._id;
      source.folder = null;
      source.system.level = level;
      source.system.hp = { value: null, max: 0 };
      applyIndividuality(source.system);
      source.ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, [game.user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };
      source.flags = { ...(source.flags ?? {}), [FLAG]: { ...(source.flags?.[FLAG] ?? {}), wildBattle: true } };
      wildActor = await Actor.implementation.create(source);
    } catch (err) {
      console.warn("Pokémon Masters | could not create wild actor", err);
    }
    if (!wildActor) { battleLock = false; return (await fallback(), false); }

    // Place both battle tokens (linked, so token.actor === the actors we damage).
    const gs = scene.grid?.size || 100;
    let wildToken = null, leadToken = null;
    try {
      wildToken = await placeToken(scene, wildActor, { x: playerToken.x + 2 * gs, y: playerToken.y, linked: true, overrides: { disposition: -1 } });
      leadToken = await placeToken(scene, lead, { x: playerToken.x - gs, y: playerToken.y, linked: true, overrides: { disposition: 1 } });
    } catch (err) {
      console.warn("Pokémon Masters | could not place battle tokens", err);
    }
    if (!wildToken) return bail(wildActor, wildToken); // placement failed

    await ChatMessage.create({
      speaker: { alias: "Wild Battle" },
      content: `<div class="pm-encounter-card"><h3>A wild ${wildActor.name} appeared!</h3><p>${trainer.name} sent out <strong>${lead.name}</strong>!</p></div>`
    }).catch(() => {});

    try {
      const app = new WildBattleApp({ trainer, scene, playerToken, lead, leadToken, wildActor, wildToken, speciesActor, level });
      activeApp = app;
      await app.render(true);
    } catch (err) {
      console.warn("Pokémon Masters | could not open the wild battle window", err);
      activeApp = null;
      return bail(wildActor, wildToken);
    }
    return true;
  } catch (err) {
    console.warn("Pokémon Masters | startWildBattle failed", err);
    battleLock = false;
    await fallback();
    return false;
  }
}

export function registerWildBattle() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    wildBattle: { start: startWildBattle, current: () => activeApp }
  });
}
