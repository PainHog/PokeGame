/**
 * Pokémon Masters — the Pokédex browser.
 *
 * A searchable window over the whole species compendium: filter by name / type,
 * see which are Caught / Seen / Undiscovered for the acting trainer, and click
 * any entry to look up its shared data (types, base stats, abilities, a
 * learnset preview). Backs the "living Pokédex" the trainer sheet summarises.
 */

import { PM } from "./config.mjs";
import { resolveTrainer } from "./catch.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class PokedexApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "pm-pokedex",
    classes: ["pokemon-masters", "pm-sheet", "pm-pokedex-app"],
    position: { width: 780, height: 660 },
    window: { title: "Pokédex", icon: "fa-solid fa-book", resizable: true },
    actions: {
      setMode: PokedexApp.#onSetMode,
      pick: PokedexApp.#onPick
    }
  };

  static PARTS = { body: { template: "systems/pokemon-masters/templates/pokedex.hbs" } };

  constructor(trainer, options = {}) {
    super(options);
    this.trainer = trainer ?? null;
    this.query = "";
    this.mode = "all";        // all | caught | seen | undiscovered
    this.selectedNum = null;  // dex number of the opened entry
  }

  /** Cheap index of every species with the fields the list & detail need. */
  async #index() {
    const pack = game.packs.get("pokemon-masters.species");
    if (!pack) return [];
    if (!this._idx) {
      this._idx = await pack.getIndex({
        fields: ["img", "system.species.num", "system.types", "system.baseStats", "system.rarity", "system.abilities", "system.hiddenAbility"]
      });
    }
    return [...this._idx];
  }

  async _prepareContext() {
    const trainer = this.trainer ?? resolveTrainer();
    const caught = new Set(trainer?.system?.pokedex?.caught ?? []);
    const seen = new Set(trainer?.system?.pokedex?.seen ?? []);
    const q = this.query.trim().toLowerCase();

    const rows = (await this.#index())
      .map((e) => {
        const sys = e.system ?? {};
        const status = caught.has(e.name) ? "caught" : seen.has(e.name) ? "seen" : "undiscovered";
        return { id: e._id, name: e.name, img: e.img, num: sys.species?.num ?? 0, types: sys.types ?? [], status };
      })
      .filter((r) => this.mode === "all" || r.status === this.mode)
      .filter((r) => !q || r.name.toLowerCase().includes(q) || String(r.num) === q || r.types.some((t) => t.toLowerCase() === q))
      .sort((a, b) => (a.num - b.num) || a.name.localeCompare(b.name));

    // Detail panel: the opened entry (undiscovered ones stay silhouetted).
    let detail = null;
    const sel = rows.find((r) => r.num === this.selectedNum) ?? rows[0];
    if (sel) {
      const full = (await this.#index()).find((e) => e._id === sel.id);
      const sys = full?.system ?? {};
      const abilities = [...new Set([...Object.values(sys.abilities ?? {}), sys.hiddenAbility].filter(Boolean))];
      detail = {
        ...sel,
        discovered: sel.status !== "undiscovered",
        baseStats: sys.baseStats ?? {},
        bst: Object.values(sys.baseStats ?? {}).reduce((a, b) => a + b, 0),
        abilities,
        rarity: PM.rarities?.[sys.rarity] ?? sys.rarity ?? ""
      };
    }

    return {
      rows, detail, query: this.query, mode: this.mode,
      counts: { caught: caught.size, seen: seen.size, total: 1025 },
      trainerName: trainer?.name ?? "No trainer"
    };
  }

  /** Wire the live search box (ApplicationV2 gives us the rendered root). */
  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    const box = root?.querySelector('input[name="pm-dex-search"]');
    if (box && !box._pmBound) {
      box._pmBound = true;
      box.addEventListener("input", (ev) => { this.query = ev.target.value; this._debouncedRender(); });
    }
  }

  _debouncedRender() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.render({ parts: ["body"] }), 150);
  }

  static #onSetMode(event, target) {
    this.mode = target.dataset.mode ?? "all";
    this.render({ parts: ["body"] });
  }

  static #onPick(event, target) {
    this.selectedNum = Number(target.dataset.num) || null;
    this.render({ parts: ["body"] });
  }
}

/** Open the Pokédex browser for a trainer (defaults to the acting trainer). */
export function openPokedex(trainer) {
  new PokedexApp(trainer ?? resolveTrainer()).render(true);
}

export function registerPokedexApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    pokedex: { open: openPokedex }
  });
}
