/**
 * Pokémon Masters — system entry point.
 *
 * Registered as the system's `esmodule` in system.json. Runs during Foundry's
 * `init` hook to wire up data models, document classes, sheets, and the
 * Region (tile) behaviors that drive automated play.
 */

import { PM } from "./module/config.mjs";
import { TrainerData, PokemonData, MoveData, AbilityData, GearData } from "./module/data-models.mjs";
import { PokemonMastersActor, PokemonMastersItem } from "./module/documents.mjs";
import { TrainerSheet, PokemonSheet, PMItemSheet } from "./module/sheets.mjs";
import { WildTileBehaviorType, SafeZoneBehaviorType, ZoneTransitBehaviorType, VenueBehaviorType, registerTravelSocket } from "./module/regions.mjs";
import { registerEventsApi } from "./module/events.mjs";
import { LegendaryBehaviorType, registerLegendaryApi } from "./module/legendaries.mjs";
import { registerServicesApi } from "./module/services.mjs";
import { AmbushBehaviorType, registerFactionApi } from "./module/factions.mjs";
import { FieldMoveGateBehaviorType, registerTmApi } from "./module/tms.mjs";
import { registerTravelApi } from "./module/travel.mjs";
import { registerTradeApi } from "./module/trade.mjs";
import { registerShopApi } from "./module/shop.mjs";
import { registerWorldHooks } from "./module/world.mjs";
import { registerCatchHooks } from "./module/catch.mjs";
import { registerBattleApi } from "./module/battle.mjs";
import { registerProgressionHooks } from "./module/progression.mjs";
import { registerStarterApi } from "./module/starters.mjs";
import { registerStorageApi } from "./module/storage.mjs";
import { registerOrgApi } from "./module/organizations.mjs";
import { registerNpcApi } from "./module/npc.mjs";
import { registerDexApi } from "./module/dex.mjs";
import { registerItemsApi } from "./module/items.mjs";
import { registerSystemSettings } from "./module/permissions.mjs";
import { registerSpriteSystem } from "./module/sprites.mjs";
import { registerGymApi } from "./module/gyms.mjs";
import { registerBreedingApi } from "./module/breeding.mjs";

Hooks.once("init", () => {
  console.log("Pokémon Masters | Initializing system");

  CONFIG.PM = PM;

  registerSystemSettings();
  registerSpriteSystem();

  // Small Handlebars helpers used by the sheet templates.
  Handlebars.registerHelper("pmLower", (s) => String(s ?? "").toLowerCase());
  Handlebars.registerHelper("pmEq", (a, b) => a === b);

  // Document classes.
  CONFIG.Actor.documentClass = PokemonMastersActor;
  CONFIG.Item.documentClass = PokemonMastersItem;

  // System data models (system.json > documentTypes must declare each subtype).
  Object.assign(CONFIG.Actor.dataModels, {
    trainer: TrainerData,
    pokemon: PokemonData
  });
  Object.assign(CONFIG.Item.dataModels, {
    move: MoveData,
    ability: AbilityData,
    gear: GearData
  });

  // Region (tile) behaviors — namespaced as `<system-id>.<type>`.
  Object.assign(CONFIG.RegionBehavior.dataModels, {
    "pokemon-masters.wildTile": WildTileBehaviorType,
    "pokemon-masters.safeZone": SafeZoneBehaviorType,
    "pokemon-masters.zoneTransit": ZoneTransitBehaviorType,
    "pokemon-masters.venue": VenueBehaviorType,
    "pokemon-masters.legendary": LegendaryBehaviorType,
    "pokemon-masters.ambush": AmbushBehaviorType,
    "pokemon-masters.fieldGate": FieldMoveGateBehaviorType
  });
  Object.assign(CONFIG.RegionBehavior.typeIcons, {
    "pokemon-masters.wildTile": "fa-solid fa-paw",
    "pokemon-masters.safeZone": "fa-solid fa-house-medical",
    "pokemon-masters.zoneTransit": "fa-solid fa-door-open",
    "pokemon-masters.venue": "fa-solid fa-ticket",
    "pokemon-masters.legendary": "fa-solid fa-star",
    "pokemon-masters.ambush": "fa-solid fa-user-ninja",
    "pokemon-masters.fieldGate": "fa-solid fa-water"
  });

  // Token resource bars.
  CONFIG.Actor.trackableAttributes = {
    pokemon: { bar: ["hp"], value: ["level", "stats.atk", "stats.def", "stats.spe"] },
    trainer: { bar: [], value: ["level", "money"] }
  };

  // Sheets.
  const Actors = foundry.documents.collections.Actors;
  const Items = foundry.documents.collections.Items;

  Actors.registerSheet("pokemon-masters", TrainerSheet, {
    types: ["trainer"], makeDefault: true, label: "Pokémon Masters — Trainer"
  });
  Actors.registerSheet("pokemon-masters", PokemonSheet, {
    types: ["pokemon"], makeDefault: true, label: "Pokémon Masters — Pokémon"
  });
  Items.registerSheet("pokemon-masters", PMItemSheet, {
    types: ["move", "ability", "gear"], makeDefault: true, label: "Pokémon Masters — Item"
  });

  // Scene region tagging + other world hooks.
  registerWorldHooks();
});

Hooks.once("ready", () => {
  registerCatchHooks();
  registerBattleApi();
  registerProgressionHooks();
  registerStarterApi();
  registerStorageApi();
  registerOrgApi();
  registerNpcApi();
  registerDexApi();
  registerItemsApi();
  registerGymApi();
  registerBreedingApi();
  registerFactionApi();
  registerTmApi();
  registerTravelSocket();
  registerTravelApi();
  registerTradeApi();
  registerShopApi();
  registerEventsApi();
  registerLegendaryApi();
  registerServicesApi();
  console.log("Pokémon Masters | Ready");
});
