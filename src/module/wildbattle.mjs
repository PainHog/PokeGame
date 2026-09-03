/**
 * Pokémon Masters — on-map, turn-based BATTLE window (wild AND trainer).
 *
 * One inline-HTML ApplicationV2 drives both kinds of on-map fight:
 *   · mode "wild"    — a single wild Pokémon. CATCH is enabled; RUN flees on
 *                      Speed. Existing behaviour, unchanged.
 *   · mode "trainer" — a foe TEAM behind a foe trainer identity (name/portrait).
 *                      No CATCH; RUN is a Forfeit confirm; victory pays the
 *                      player trainer prize money. When a side's active faints
 *                      the next teammate is sent out, and the battle ends when
 *                      one whole team has fainted.
 *
 * The player side is always the trainer's LEAD (`leadPokemon` — first party
 * member with HP), re-resolved after every faint, so its HP persists after the
 * fight. The foe side is an ordered array of TEMPORARY battle actors created by
 * `makeBattleActor` (owned by the acting client, flagged `wildBattle` so the
 * progression hook never levels them and so they're always cleaned up). Damage
 * is resolved through the shared engine (battle.mjs); catches through catch.mjs;
 * the player's Pokémon earn XP from the `pmPokemonFainted` hook `useMove` fires
 * when a foe faints. Everything runs on the acting client — no GM required.
 *
 * Foe replies are driven manually (autoRetaliate:false): the acting client OWNs
 * the foe actors (so it can apply damage in GM-less play), which makes them
 * `hasPlayerOwner` and would suppress the engine's `!hasPlayerOwner` auto-reply.
 */

import { placeToken, removeToken } from "./placement.mjs";
import { leadPokemon, partyActors } from "./storage.mjs";
import { applyIndividuality } from "./individuality.mjs";
import { ITEM_EFFECTS } from "./items.mjs";

const FLAG = "pokemon-masters";

// Only one on-map battle (wild OR trainer) at a time. A second encounter while
// one is open is ignored (wild falls back to the announce/catch card).
let battleLock = false;
let activeApp = null;

const { ApplicationV2 } = foundry.applications.api;

/* -------------------------------------------- */
/*  Species lookup / foe materialization         */
/* -------------------------------------------- */

/** Find a species template Actor in the compendium by name (case-insensitive). */
async function findSpecies(name) {
  const pack = game.packs.get("pokemon-masters.species");
  if (!pack) return null;
  const key = String(name).toLowerCase();
  const entry = pack.index.find((e) => e.name.toLowerCase() === key);
  return entry ? pack.getDocument(entry._id) : null;
}

/**
 * Create a TEMPORARY battle Actor from a foe source, owned by the acting client
 * and flagged `wildBattle` (so progression never levels it and cleanup always
 * deletes it). Never mutates an NPC's stored party — always a throwaway copy.
 *
 *  · A Pokémon Actor (an NPC's real party member): cloned via `toObject()` so it
 *    keeps its move Items and rolled individuality; topped up to full HP; its
 *    stored trainer link dropped so it's a pure throwaway.
 *  · A spec `{ speciesName, level }` (generated/wandering foes): looked up in the
 *    species pack and built like a wild — fresh individuality, moves seeded by
 *    the `createActor` hook exactly as a wild spawn is.
 *
 * @param {Actor|{speciesName?:string, species?:string, name?:string, level?:number}} source
 * @param {{level?:number, ownerId?:string}} [opts]
 * @returns {Promise<Actor|null>}
 */
export async function makeBattleActor(source, { level = null, ownerId = game.user.id } = {}) {
  try {
    let data;
    const isActor = typeof source?.toObject === "function" && source?.documentName === "Actor";
    if (isActor) {
      // Clone an existing Pokémon actor (carries its move Items + individuality).
      data = source.toObject();
      delete data._id;
      data.folder = null;
      data.system = data.system ?? {};
      data.system.level = level ?? data.system.level ?? 5;
      data.system.hp = { value: null, max: 0 }; // prepareDerivedData tops it off to full
      delete data.system.trainer;               // a throwaway belongs to no one
    } else {
      // A spec — look up the species and build like a wild spawn.
      const speciesName = source?.speciesName ?? source?.species ?? source?.name;
      const species = await findSpecies(speciesName);
      if (!species) { console.warn("Pokémon Masters | makeBattleActor: unknown species", speciesName); return null; }
      data = species.toObject();
      delete data._id;
      data.folder = null;
      data.system.level = level ?? source?.level ?? 5;
      data.system.hp = { value: null, max: 0 };
      applyIndividuality(data.system);
    }
    data.flags = { ...(data.flags ?? {}), [FLAG]: { ...(data.flags?.[FLAG] ?? {}), wildBattle: true } };
    data.ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, [ownerId]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };
    return await Actor.implementation.create(data);
  } catch (err) {
    console.warn("Pokémon Masters | makeBattleActor failed", err);
    return null;
  }
}

/* -------------------------------------------- */
/*  Battle window                                */
/* -------------------------------------------- */

/**
 * The on-map battle window. Rendered as inline HTML (no Handlebars PART): we
 * override `_renderHTML` to return an HTML string and `_replaceHTML` to inject it
 * and wire the button listeners. Drives both wild and trainer modes.
 */
export class WildBattleApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pm-wild-battle",
    classes: ["pokemon-masters", "pm-sheet", "pm-wild-battle-app"],
    position: { width: 520 },
    window: { title: "Battle", icon: "fa-solid fa-khanda" }
  };

  constructor(state = {}, options = {}) {
    super(options);
    this.mode = state.mode ?? "wild";
    this.trainer = state.trainer;
    this.scene = state.scene;
    this.playerToken = state.playerToken;
    this.lead = state.lead;
    this.leadToken = state.leadToken;
    this.playerTeam = state.playerTeam ?? [];
    // Foe side: an ordered array of temporary battle actors + the current active.
    this.foeTeam = state.foeTeam ?? (state.foeActor ? [state.foeActor] : []);
    this.foeActor = state.foeActor ?? this.foeTeam[0] ?? null;
    this.foeToken = state.foeToken;
    // Wild-only: the species template (for catch odds).
    this.speciesActor = state.speciesActor;
    this.level = state.level;
    // Trainer-only: foe identity, reward, and outcome callbacks.
    this.foeTrainerName = state.foeTrainerName ?? "";
    this.foeTrainerImg = state.foeTrainerImg ?? "";
    this.prize = state.prize ?? 0;
    this.onWin = state.onWin;
    this.onLose = state.onLose;
    // Flags.
    this.busy = false;          // in-flight lock (blocks double-clicks during resolution)
    this.cleaned = false;       // cleanup runs exactly once
    this.foeClaimed = false;    // set when a catch hands the foe actor to the trainer (wild)
    this.resultFired = false;   // onWin/onLose fire exactly once (trainer)
    this.fightExpanded = false; // FIGHT sub-menu open?
    this.bagExpanded = false;   // BAG sub-menu open?
    this.msg = this.mode === "trainer"
      ? `${this.foeTrainerName || "A trainer"} wants to battle!`
      : "A wild Pokémon appeared!";
  }

  /** The window header — "Wild Battle" or the foe trainer's name. */
  get title() {
    return this.mode === "trainer" ? `Battle — ${this.foeTrainerName || "Trainer"}` : "Wild Battle";
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
        else if (a === "bag") this.#onBag();
        else if (a === "catch") this.#onCatch();
        else if (a === "run") this.#onRun();
        else if (a === "back") { this.fightExpanded = false; this.bagExpanded = false; if (!this.cleaned) this.render(); }
      });
    }
    for (const el of content.querySelectorAll("[data-move-id]")) {
      el.addEventListener("click", (ev) => { ev.preventDefault(); this.#onPickMove(el.dataset.moveId); });
    }
    for (const el of content.querySelectorAll("[data-item-id]")) {
      el.addEventListener("click", (ev) => { ev.preventDefault(); this.#onUseItem(el.dataset.itemId); });
    }
    for (const el of content.querySelectorAll("[data-ball]")) {
      el.addEventListener("click", (ev) => { ev.preventDefault(); this.#onCatch(el.dataset.ball); });
    }
  }

  #buildHtml() {
    return `<style>
      .pm-wild-battle-app .window-content { padding: 0; }
      .pm-wb { padding: 10px 12px 12px; font-size: 13px; }
      .pm-wb-trainers { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }
      .pm-wb-trainer { display: flex; align-items: center; gap: 6px; font-weight: 700; }
      .pm-wb-trainer.pm-wb-foe { justify-content: flex-end; text-align: right; }
      .pm-wb-tavatar { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; border: 1px solid var(--color-border-dark, #444); }
      .pm-wb-tname { font-size: 12px; }
      .pm-wb-pips { display: inline-flex; gap: 3px; }
      .pm-wb-pip { width: 8px; height: 8px; border-radius: 50%; background: rgba(0,0,0,0.2); border: 1px solid rgba(0,0,0,0.35); }
      .pm-wb-pip.on { background: #e53935; border-color: #b71c1c; }
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
      .pm-wb-empty { flex: 1 1 100%; text-align: center; opacity: .7; font-style: italic; padding: 6px; }
      .pm-wb-msg { margin-top: 10px; min-height: 1.2em; font-style: italic; opacity: .85; }
      .pm-wild-battle-app .pm-wb-btn[disabled] { opacity: .5; cursor: default; }
    </style>
    <div class="pm-wb${this.busy ? " pm-wb-busy" : ""}">
      ${this.#fieldHtml()}
      ${this.#actionsHtml()}
      <div class="pm-wb-msg">${this.msg ?? ""}</div>
    </div>`;
  }

  /** The battlefield: trainer identity row (trainer mode) + the two panels. */
  #fieldHtml() {
    if (this.mode === "trainer") {
      return `
      <div class="pm-wb-trainers">
        <div class="pm-wb-trainer">
          ${this.trainer?.img ? `<img class="pm-wb-tavatar" src="${this.trainer.img}" alt="">` : ""}
          <span class="pm-wb-tname">${this.trainer?.name ?? "You"}</span>
          ${this.#pipsHtml(this.playerTeam)}
        </div>
        <div class="pm-wb-trainer pm-wb-foe">
          ${this.#pipsHtml(this.foeTeam)}
          <span class="pm-wb-tname">${this.foeTrainerName || "Trainer"}</span>
          ${this.foeTrainerImg ? `<img class="pm-wb-tavatar" src="${this.foeTrainerImg}" alt="">` : ""}
        </div>
      </div>
      <div class="pm-wb-field">
        ${this.#panelHtml(this.lead, "Your Pokémon")}
        <div class="pm-wb-vs">VS</div>
        ${this.#panelHtml(this.foeActor, this.foeTrainerName || "Foe")}
      </div>`;
    }
    return `<div class="pm-wb-field">
        ${this.#panelHtml(this.lead, this.trainer?.name ?? "You")}
        <div class="pm-wb-vs">VS</div>
        ${this.#panelHtml(this.foeActor, "Wild")}
      </div>`;
  }

  /** Remaining-team dots for a side (filled = still has HP). */
  #pipsHtml(team) {
    const list = team ?? [];
    if (!list.length) return "";
    const remaining = list.filter((p) => (p?.system?.hp?.value ?? p?.system?.hp?.max ?? 1) > 0).length;
    let dots = "";
    for (let i = 0; i < list.length; i++) dots += `<span class="pm-wb-pip${i < remaining ? " on" : ""}"></span>`;
    return `<span class="pm-wb-pips" title="${remaining} / ${list.length} left">${dots}</span>`;
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
    if (this.bagExpanded) {
      const { heals, balls } = this.#usableItems();
      const btns = [];
      for (const it of heals) btns.push(`<button type="button" class="pm-wb-btn pm-wb-move" data-item-id="${it.id}"${dis}>${it.name}<small>×${it.system?.quantity ?? 1}</small></button>`);
      for (const b of balls) btns.push(`<button type="button" class="pm-wb-btn pm-wb-move" data-ball="${b.name}"${dis}>${b.name}<small>×${b.system?.quantity ?? 1}</small></button>`);
      const body = btns.length ? btns.join("") : `<div class="pm-wb-empty">No usable items in your bag.</div>`;
      return `<div class="pm-wb-moves">${body}</div>
        <div class="pm-wb-row"><button type="button" class="pm-wb-btn pm-wb-back" data-wb="back"${dis}>◀ Back</button></div>`;
    }
    const btns = [
      `<button type="button" class="pm-wb-btn" data-wb="fight"${dis}>⚔ Fight</button>`,
      `<button type="button" class="pm-wb-btn" data-wb="bag"${dis}>🎒 Bag</button>`
    ];
    if (this.mode === "wild") {
      btns.push(`<button type="button" class="pm-wb-btn" data-wb="catch"${dis}>⚪ Catch</button>`);
      btns.push(`<button type="button" class="pm-wb-btn" data-wb="run"${dis}>🏃 Run</button>`);
    } else {
      btns.push(`<button type="button" class="pm-wb-btn" data-wb="run"${dis}>🏳 Forfeit</button>`);
    }
    return `<div class="pm-wb-row">${btns.join("")}</div>`;
  }

  /** Trainer bag items usable in battle: healing/curing/reviving medicine +
   *  (wild only) Poké Balls. Only items with a real battle effect are listed. */
  #usableItems() {
    const items = this.trainer?.items ?? [];
    const heals = items.filter((i) => {
      if (i.type !== "gear" || (i.system?.quantity ?? 1) <= 0) return false;
      const eff = ITEM_EFFECTS[i.name.toLowerCase()];
      return !!eff && !!(eff.heal || eff.healFrac || eff.revive || eff.cure);
    });
    const balls = this.mode === "wild"
      ? items.filter((i) => i.type === "gear" && i.system?.category === "ball" && (i.system?.quantity ?? 1) > 0)
      : [];
    return { heals, balls };
  }

  /* --- actions ----------------------------------------------- */

  #onFight() {
    if (this.busy || this.cleaned) return;
    this.bagExpanded = false;
    this.fightExpanded = !this.fightExpanded;
    this.render();
  }

  #onBag() {
    if (this.busy || this.cleaned) return;
    this.fightExpanded = false;
    this.bagExpanded = !this.bagExpanded;
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
      await battle.useMove(this.lead, move, { actor: this.foeActor, token: this.foeToken }, { autoRetaliate: false });
      await this.#afterPlayerAction();
    } catch (err) {
      console.warn("Pokémon Masters | battle FIGHT failed", err);
    } finally {
      this.busy = false;
      if (!this.cleaned) this.render();
    }
  }

  /** Use a bag item on the player's active Pokémon — consumes the turn (the foe
   *  acts afterward). A no-effect item (full HP potion, revive on a healthy mon)
   *  costs no turn and returns to the bag. */
  async #onUseItem(itemId) {
    if (this.busy || this.cleaned) return;
    const gearItem = this.trainer?.items?.get(itemId);
    if (!gearItem) return;
    this.busy = true;
    this.render();
    try {
      const use = game.pokemonMasters?.items?.use;
      const res = await use?.(this.lead, gearItem.name, { gearItem });
      if (res == null) { this.bagExpanded = true; return; } // no effect → no turn spent
      this.bagExpanded = false;
      this.msg = `${this.lead.name} used ${gearItem.name}.`;
      await this.#afterPlayerAction();
    } catch (err) {
      console.warn("Pokémon Masters | battle BAG failed", err);
    } finally {
      this.busy = false;
      if (!this.cleaned) this.render();
    }
  }

  async #onCatch(ballName = null) {
    if (this.mode !== "wild" || this.busy || this.cleaned) return;
    this.busy = true;
    this.bagExpanded = false;
    this.render();
    try {
      const res = await game.pokemonMasters?.catch?.attempt({
        trainer: this.trainer,
        speciesUuid: this.speciesActor?.uuid,
        level: this.foeActor.system.level,
        hpFraction: this.#foeHpFraction(),
        status: this.foeActor.system.status ?? "none",
        token: this.foeToken,
        ballName: ballName || undefined
      });
      if (res?.caught) {
        // finalizeCapture already claimed the foe actor into the party/storage
        // and deleted its token — never delete that actor in cleanup.
        this.foeClaimed = true;
        this.foeToken = null;
        await removeToken(this.scene, this.lead).catch(() => {}); // recall the lead
        return void (await this.#end());
      }
      // Broke free → the wild gets a free turn.
      await this.#afterPlayerAction();
    } catch (err) {
      console.warn("Pokémon Masters | battle CATCH failed", err);
    } finally {
      this.busy = false;
      if (!this.cleaned) this.render();
    }
  }

  async #onRun() {
    if (this.busy || this.cleaned) return;
    if (this.mode === "trainer") return this.#onForfeit();
    this.busy = true;
    this.render();
    try {
      const leadSpe = this.lead.system.stats?.spe ?? 1;
      const foeSpe = this.foeActor.system.stats?.spe ?? 1;
      const odds = leadSpe >= foeSpe ? 0.9 : 0.5;
      if (Math.random() < odds) {
        await ChatMessage.create({ speaker: { alias: "Wild Battle" }, content: `<div class="pm-battle-card"><p>Got away safely!</p></div>` }).catch(() => {});
        return void (await this.#end());
      }
      this.msg = "Couldn't get away!";
      await ChatMessage.create({ speaker: { alias: "Wild Battle" }, content: `<div class="pm-battle-card"><p>${this.trainer.name} couldn't get away!</p></div>` }).catch(() => {});
      await this.#afterPlayerAction();
    } catch (err) {
      console.warn("Pokémon Masters | battle RUN failed", err);
    } finally {
      this.busy = false;
      if (!this.cleaned) this.render();
    }
  }

  /** Trainer mode: confirm a forfeit, which ends the battle as a loss. */
  async #onForfeit() {
    if (this.busy || this.cleaned) return;
    const D = foundry.applications?.api?.DialogV2;
    const ok = D ? await D.confirm({
      window: { title: "Forfeit?" },
      content: `<p>Give up the battle against <strong>${this.foeTrainerName || "the trainer"}</strong>? You'll lose.</p>`
    }).catch(() => false) : true;
    if (!ok || this.cleaned) return;
    await ChatMessage.create({
      speaker: { alias: "Trainer Battle" },
      content: `<div class="pm-battle-card"><p>${this.trainer.name} forfeited the battle against ${this.foeTrainerName || "the trainer"}.</p></div>`
    }).catch(() => {});
    this.#fireResult("lose");
    await this.#end();
  }

  /* --- battle flow ------------------------------------------- */

  /** Shared post-player-action sequence: the player has acted (attacked, healed,
   *  threw a ball that broke, or failed to flee). Resolve a foe KO from that
   *  action, then the foe's turn, then any end-of-exchange faints on either side. */
  async #afterPlayerAction() {
    // Foe KO'd by the player's own action → replace it (or win); the turn ends.
    if ((this.foeActor?.system.hp?.value ?? 0) <= 0) return void (await this.#onFoeFaint());
    await this.#foeTurn();
    // Both actives may be down after the foe's strike + end-of-turn chip.
    if ((this.foeActor?.system.hp?.value ?? 0) <= 0) {
      await this.#onFoeFaint();
      if (this.cleaned) return; // battle ended in victory
    }
    if ((this.lead?.system.hp?.value ?? 1) <= 0) await this.#onPlayerFaint();
  }

  /** The active foe's turn: pick its best move and strike the lead, then chip. */
  async #foeTurn() {
    const battle = game.pokemonMasters?.battle;
    const npc = game.pokemonMasters?.npc;
    if (battle && npc && (this.foeActor.system.hp?.value ?? 0) > 0 && (this.lead.system.hp?.value ?? 0) > 0) {
      try {
        const move = npc.chooseBestMove(npc.combatantFromActor(this.foeActor), npc.combatantFromActor(this.lead));
        if (move) await battle.useMove(this.foeActor, move, { actor: this.lead, token: this.leadToken }, { autoRetaliate: false });
      } catch (err) {
        console.warn("Pokémon Masters | foe counterattack failed", err);
      }
    }
    // End-of-turn burn/poison/toxic chip on both survivors (parity with the engine).
    if (battle?.applyEndOfTurn) {
      try { if ((this.lead.system.hp?.value ?? 0) > 0) await battle.applyEndOfTurn(this.lead); } catch (err) { /* soft */ }
      try { if ((this.foeActor.system.hp?.value ?? 0) > 0) await battle.applyEndOfTurn(this.foeActor); } catch (err) { /* soft */ }
    }
  }

  /** The active foe fainted: send out the foe trainer's next teammate, or win. */
  async #onFoeFaint() {
    const fainted = this.foeActor;
    // Remember where the foe stood, then clear its token.
    const gs = this.#gs();
    const pos = { x: this.foeToken?.x ?? (this.playerToken.x + 2 * gs), y: this.foeToken?.y ?? this.playerToken.y };
    try {
      if (this.foeToken?.id && this.scene?.tokens?.get(this.foeToken.id)) {
        await this.scene.deleteEmbeddedDocuments("Token", [this.foeToken.id]);
      }
    } catch (err) { /* soft */ }
    this.foeToken = null;

    // Another foe with HP? (trainer mode only ever has more than one.)
    const next = this.foeTeam.find((f) => f && f !== fainted && (f.system.hp?.value ?? 0) > 0);
    if (next) {
      this.foeActor = next;
      this.foeToken = (await placeToken(this.scene, next, { x: pos.x, y: pos.y, linked: true, overrides: { disposition: -1 } })) ?? this.foeToken;
      this.msg = `${this.foeTrainerName || "The foe"} sent out ${next.name}!`;
      await ChatMessage.create({
        speaker: { alias: this.foeTrainerName || "Trainer Battle" },
        content: `<div class="pm-battle-card"><p><strong>${this.foeTrainerName || "The foe"}</strong> sent out <strong>${next.name}</strong>!</p></div>`
      }).catch(() => {});
      return; // the caller's finally re-renders with the new foe
    }
    // No foe left standing → the player wins.
    await this.#victory();
  }

  /** The whole foe side is down. Trainer mode pays prize + fires onWin; both
   *  modes announce and end. XP was granted per-faint by the progression hook. */
  async #victory() {
    if (this.mode === "trainer") {
      try {
        const money = this.trainer.system?.money ?? 0;
        await this.trainer.update({ "system.money": money + (this.prize ?? 0) });
      } catch (err) { console.warn("Pokémon Masters | prize payout failed", err); }
      await ChatMessage.create({
        speaker: { alias: "Trainer Battle" },
        content: `<div class="pm-battle-card"><p class="pm-caught">${this.trainer.name} defeated ${this.foeTrainerName || "the challenger"}!${this.prize ? ` Prize money: ₽${this.prize}.` : ""}</p></div>`
      }).catch(() => {});
      this.#fireResult("win");
    } else {
      await ChatMessage.create({
        speaker: { alias: "Wild Battle" },
        content: `<div class="pm-battle-card"><p class="pm-caught">The wild ${this.foeActor.name} fainted! ${this.lead.name} won the battle.</p></div>`
      }).catch(() => {});
    }
    await this.#end();
  }

  /** Recall the fainted lead and send out the next usable party member, or lose. */
  async #onPlayerFaint() {
    await removeToken(this.scene, this.lead).catch(() => {});
    const next = await leadPokemon(this.trainer);
    if (!next) {
      await ChatMessage.create({
        speaker: { alias: this.mode === "trainer" ? "Trainer Battle" : "Wild Battle" },
        content: `<div class="pm-battle-card"><p>${this.trainer.name} is out of usable Pokémon!</p></div>`
      }).catch(() => {});
      ui.notifications?.info("You're out of usable Pokémon!");
      if (this.mode === "trainer") this.#fireResult("lose");
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

  /** Fire the trainer-mode outcome callback exactly once. */
  #fireResult(kind) {
    if (this.resultFired) return;
    this.resultFired = true;
    try { (kind === "win" ? this.onWin : this.onLose)?.(); }
    catch (err) { console.warn("Pokémon Masters | battle result callback failed", err); }
  }

  /** Struggle fallback when a Pokémon somehow knows no moves. */
  #struggle() {
    return { name: "Struggle", system: { moveType: "Normal", category: "Physical", power: 50, accuracy: 100 } };
  }

  #foeHpFraction() {
    const hp = this.foeActor.system.hp ?? {};
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
   * Remove the player's battle token and every foe token, and DELETE every
   * temporary foe actor that wasn't caught — so nothing is orphaned. Idempotent;
   * releases the battle lock and, in trainer mode, guarantees the outcome
   * callback fired (an abandoned window counts as a loss so locks always clear).
   */
  async #cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;
    try { if (this.lead) await removeToken(this.scene, this.lead); } catch (err) { /* soft */ }
    // Remove the current foe token and any stray foe tokens still on the scene.
    try {
      const foeIds = new Set(this.foeTeam.map((f) => f?.id).filter(Boolean));
      const ids = (this.scene?.tokens?.filter((t) => foeIds.has(t.actorId)).map((t) => t.id)) ?? [];
      if (this.foeToken?.id && !ids.includes(this.foeToken.id) && this.scene?.tokens?.get(this.foeToken.id)) ids.push(this.foeToken.id);
      if (ids.length) await this.scene.deleteEmbeddedDocuments("Token", ids);
    } catch (err) { /* soft */ }
    // Delete the throwaway foe actors (unless a wild was just caught).
    for (const foe of this.foeTeam) {
      try {
        if (!foe || !game.actors.get(foe.id)) continue;
        if (this.foeClaimed && foe === this.foeActor) continue; // caught → belongs to the trainer now
        if (foe.system?.trainer) continue;                      // safety: owned by someone
        await foe.delete();
      } catch (err) { /* soft */ }
    }
    if (this.mode === "trainer") this.#fireResult("lose"); // abandoned = loss; releases the caller's lock
    battleLock = false;
    if (activeApp === this) activeApp = null;
  }

  async _onClose(options) {
    await this.#cleanup();
    return super._onClose?.(options);
  }
}

/* -------------------------------------------- */
/*  Entry points                                 */
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
    if (battleLock) return (await fallback(), false); // one battle at a time
    const scene = playerToken.parent;
    if (!scene || !speciesActor) return (await fallback(), false);

    const lead = await leadPokemon(trainer);
    if (!lead) return (await fallback(), false); // no usable Pokémon → just the catch card

    // Committed — claim the lock before any await that could let a second roll in.
    battleLock = true;

    // Undo everything placed so far and fall back to the catch card.
    const bail = async (foeActor, foeToken) => {
      try { if (foeToken?.id && scene.tokens?.get(foeToken.id)) await scene.deleteEmbeddedDocuments("Token", [foeToken.id]); } catch (err) { /* soft */ }
      try { await removeToken(scene, lead); } catch (err) { /* soft */ }
      try { if (foeActor && game.actors.get(foeActor.id)) await foeActor.delete(); } catch (err) { /* soft */ }
      battleLock = false;
      await fallback();
      return false;
    };

    // Create the wild actor from the species (fresh individuality + seeded moves),
    // owned by this client so it can apply damage to it (required for GM-less
    // play). The `wildBattle` flag stops progression from awarding the throwaway
    // wild XP (and popping an evolve dialog) if it happens to KO the lead.
    const wildActor = await makeBattleActor({ speciesName: speciesActor.name, level }, { ownerId: game.user.id });
    if (!wildActor) { battleLock = false; return (await fallback(), false); }

    // Place both battle tokens (linked, so token.actor === the actors we damage).
    const gs = scene.grid?.size || 100;
    let foeToken = null, leadToken = null;
    try {
      foeToken = await placeToken(scene, wildActor, { x: playerToken.x + 2 * gs, y: playerToken.y, linked: true, overrides: { disposition: -1 } });
      leadToken = await placeToken(scene, lead, { x: playerToken.x - gs, y: playerToken.y, linked: true, overrides: { disposition: 1 } });
    } catch (err) {
      console.warn("Pokémon Masters | could not place battle tokens", err);
    }
    if (!foeToken) return bail(wildActor, foeToken); // placement failed

    await ChatMessage.create({
      speaker: { alias: "Wild Battle" },
      content: `<div class="pm-encounter-card"><h3>A wild ${wildActor.name} appeared!</h3><p>${trainer.name} sent out <strong>${lead.name}</strong>!</p></div>`
    }).catch(() => {});

    try {
      const playerTeam = await partyActors(trainer);
      const app = new WildBattleApp({
        mode: "wild", trainer, scene, playerToken, lead, leadToken, playerTeam,
        foeTeam: [wildActor], foeActor: wildActor, foeToken, speciesActor, level
      });
      activeApp = app;
      await app.render(true);
    } catch (err) {
      console.warn("Pokémon Masters | could not open the wild battle window", err);
      activeApp = null;
      return bail(wildActor, foeToken);
    }
    return true;
  } catch (err) {
    console.warn("Pokémon Masters | startWildBattle failed", err);
    battleLock = false;
    await fallback();
    return false;
  }
}

/**
 * Begin an on-map TRAINER battle: materialize the foe trainer's team into
 * temporary battle actors, send out the player's lead opposite the first foe,
 * and open the battle window in trainer mode. Shares the single-battle lock with
 * wild battles. On victory the player trainer is paid `prize` money and `onWin`
 * fires; on loss/forfeit/abandon `onLose` fires (XP is handled per-faint by the
 * progression hook). Returns true iff the window opened.
 *
 * @param {TokenDocument} playerToken  the player trainer's token
 * @param {object} opts
 * @param {string}  [opts.foeName]     the foe trainer's display name
 * @param {string}  [opts.foeImg]      the foe trainer's portrait
 * @param {Array<Actor|{speciesName:string, level?:number}>} opts.foeSources  the foe team (actors and/or specs)
 * @param {number}  [opts.prize]       prize money paid to the player on victory
 * @param {() => any} [opts.onWin]     fired when the player wins
 * @param {() => any} [opts.onLose]    fired on loss / forfeit / abandon
 */
export async function startTrainerBattle(playerToken, { foeName = "", foeImg = "", foeSources = [], prize = 0, onWin, onLose } = {}) {
  const fireLose = () => { try { onLose?.(); } catch (err) { console.warn("Pokémon Masters | trainer onLose failed", err); } };
  try {
    const trainer = playerToken?.actor;
    if (!trainer || trainer.type !== "trainer") { fireLose(); return false; }
    if (battleLock) { ui.notifications?.info("Finish the current battle first."); fireLose(); return false; }
    const scene = playerToken.parent;
    if (!scene) { fireLose(); return false; }
    if (!Array.isArray(foeSources) || !foeSources.length) { ui.notifications?.warn("The challenger has no Pokémon!"); fireLose(); return false; }

    const lead = await leadPokemon(trainer);
    if (!lead) { ui.notifications?.warn("You have no Pokémon able to battle!"); fireLose(); return false; }

    // Committed — claim the shared battle lock.
    battleLock = true;
    const ownerId = game.user.id;

    // Materialize the foe team into temporary battle actors (throwaway copies —
    // an NPC's stored party is never touched).
    const foeTeam = [];
    for (const src of foeSources) {
      const foe = await makeBattleActor(src, { ownerId });
      if (foe) foeTeam.push(foe);
    }
    if (!foeTeam.length) {
      battleLock = false;
      ui.notifications?.warn("Couldn't create the foe team.");
      fireLose();
      return false;
    }

    // Full bail: delete every foe actor + the placed tokens, release the lock.
    const bail = async (foeToken) => {
      try { if (foeToken?.id && scene.tokens?.get(foeToken.id)) await scene.deleteEmbeddedDocuments("Token", [foeToken.id]); } catch (err) { /* soft */ }
      try { await removeToken(scene, lead); } catch (err) { /* soft */ }
      for (const f of foeTeam) { try { if (game.actors.get(f.id)) await f.delete(); } catch (err) { /* soft */ } }
      battleLock = false;
      fireLose();
      return false;
    };

    // Place the first foe opposite the player and send out the player's lead.
    const gs = scene.grid?.size || 100;
    let foeToken = null, leadToken = null;
    try {
      foeToken = await placeToken(scene, foeTeam[0], { x: playerToken.x + 2 * gs, y: playerToken.y, linked: true, overrides: { disposition: -1 } });
      leadToken = await placeToken(scene, lead, { x: playerToken.x - gs, y: playerToken.y, linked: true, overrides: { disposition: 1 } });
    } catch (err) {
      console.warn("Pokémon Masters | could not place trainer-battle tokens", err);
    }
    if (!foeToken) return bail(foeToken);

    await ChatMessage.create({
      speaker: { alias: foeName || "Trainer Battle" },
      content: `<div class="pm-encounter-card"><h3>${foeName || "A trainer"} wants to battle!</h3><p>${trainer.name} sent out <strong>${lead.name}</strong>!</p></div>`
    }).catch(() => {});

    try {
      const playerTeam = await partyActors(trainer);
      const app = new WildBattleApp({
        mode: "trainer", trainer, scene, playerToken, lead, leadToken, playerTeam,
        foeTeam, foeActor: foeTeam[0], foeToken,
        foeTrainerName: foeName, foeTrainerImg: foeImg, prize, onWin, onLose
      });
      activeApp = app;
      await app.render(true);
    } catch (err) {
      console.warn("Pokémon Masters | could not open the trainer battle window", err);
      activeApp = null;
      return bail(foeToken);
    }
    return true;
  } catch (err) {
    console.warn("Pokémon Masters | startTrainerBattle failed", err);
    battleLock = false;
    fireLose();
    return false;
  }
}

export function registerWildBattle() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    wildBattle: { start: startWildBattle, startTrainer: startTrainerBattle, make: makeBattleActor, current: () => activeApp }
  });
}
