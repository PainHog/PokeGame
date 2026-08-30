/**
 * Pokémon Masters — lore-accurate Poké Ball catch modifiers.
 *
 * Each ball's bonus is computed from context (target types/level/speed, method,
 * turn, status, night/cave, etc.) using the mainline rules, rather than a flat
 * multiplier. Master Ball returns Infinity (guaranteed). Pure and testable.
 *
 * Context fields (all optional):
 *   targetTypes[], targetLevel, userLevel, baseSpe, method ("walk"/"surf"/"fishing"),
 *   turn, status ("none"/"asleep"/…), night, cave, caughtBefore, ultraBeast,
 *   sameSpecies, oppositeGender, evoItem
 */

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/** Lore-accurate multiplier for a ball given the encounter context. */
export function ballBonus(ballName, ctx = {}) {
  const name = String(ballName || "").toLowerCase().replace(/\s+/g, " ").trim();
  const t = ctx.targetTypes ?? [];
  const isWaterMethod = ctx.method === "surf" || ctx.method === "fishing";

  switch (name) {
    case "master ball": return Infinity;
    case "great ball": return 1.5;
    case "ultra ball": return 2;
    case "safari ball":
    case "sport ball": return 1.5;

    case "net ball": return (t.includes("Bug") || t.includes("Water")) ? 3.5 : 1;
    case "dive ball": return isWaterMethod ? 3.5 : 1;
    case "lure ball": return ctx.method === "fishing" ? 4 : 1;
    case "dusk ball": return (ctx.night || ctx.cave) ? 3 : 1;
    case "quick ball": return (ctx.turn ?? 1) <= 1 ? 5 : 1;
    case "timer ball": return clamp(1 + (ctx.turn ?? 1) * 0.3, 1, 4);
    case "nest ball": return clamp((41 - (ctx.targetLevel ?? 20)) / 10, 1, 4);
    case "repeat ball": return ctx.caughtBefore ? 3.5 : 1;
    case "dream ball": return ctx.status === "sleep" ? 4 : 1;
    case "fast ball": return (ctx.baseSpe ?? 0) >= 100 ? 4 : 1;
    case "moon ball": return /moon stone/i.test(ctx.evoItem ?? "") ? 4 : 1;
    case "love ball": return (ctx.sameSpecies && ctx.oppositeGender) ? 8 : 1;
    case "beast ball": return ctx.ultraBeast ? 5 : 0.1;

    case "level ball": {
      const u = ctx.userLevel ?? 1;
      const t2 = ctx.targetLevel ?? 1;
      if (u >= 4 * t2) return 8;
      if (u >= 2 * t2) return 4;
      if (u > t2) return 2;
      return 1;
    }

    // Friendship/utility balls catch normally.
    case "heal ball":
    case "friend ball":
    case "luxury ball":
    case "premier ball":
    case "cherish ball":
    case "poke ball":
    case "poké ball":
    default:
      return 1;
  }
}

/** One-line description of a ball's special rule, for tooltips/UX. */
export const BALL_RULES = {
  "net ball": "3.5× vs Bug or Water types",
  "dive ball": "3.5× when surfing or fishing",
  "lure ball": "4× while fishing",
  "dusk ball": "3× at night or in caves",
  "quick ball": "5× on the first turn",
  "timer ball": "better the longer the battle runs",
  "nest ball": "better against low-level Pokémon",
  "repeat ball": "3.5× vs species already caught",
  "dream ball": "4× vs sleeping Pokémon",
  "fast ball": "4× vs fast Pokémon (base Speed ≥ 100)",
  "level ball": "up to 8× when you far outlevel the target",
  "love ball": "8× vs same species, opposite gender",
  "beast ball": "5× vs Ultra Beasts (0.1× otherwise)",
  "moon ball": "4× vs Moon Stone evolvers"
};
