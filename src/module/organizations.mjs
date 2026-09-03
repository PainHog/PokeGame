/**
 * Pokémon Masters — organizations, factions & reputation.
 *
 * Players can join organizations (the League, Ranger Union, Team Rocket, …) and
 * earn reputation through org-appropriate deeds. Enough reputation promotes the
 * member up that org's rank ladder, so standing grows over a campaign.
 */

import { PM } from "./config.mjs";
import { resolveTrainer } from "./catch.mjs";

/** Title for a given rank index within an org (clamped to the ladder). */
export function rankTitle(orgKey, idx) {
  const org = PM.organizations[orgKey];
  if (!org) return "Member";
  return org.ranks[Math.max(0, Math.min(idx, org.ranks.length - 1))];
}

/** Reputation needed to advance *from* the given rank to the next. */
export function nextRankThreshold(rank) {
  return PM.reputationPerRank * (rank + 1);
}

export async function joinOrg(trainer, orgKey) {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Select or assign your Trainer first.");
  const org = PM.organizations[orgKey];
  if (!org) return ui.notifications?.warn(`Unknown organization: ${orgKey}`);

  const affiliations = [...(trainer.system.affiliations ?? [])];
  if (affiliations.some((a) => a.org === orgKey)) {
    return ui.notifications?.info(`${trainer.name} is already in ${org.label}.`);
  }
  affiliations.push({ org: orgKey, rank: 0, reputation: 0 });
  await trainer.update({ "system.affiliations": affiliations });
  await ChatMessage.create({
    speaker: { alias: org.label },
    content: `<div class="pm-encounter-card"><h3>${trainer.name} joined ${org.label}!</h3><p>Starting rank: <strong>${rankTitle(orgKey, 0)}</strong></p></div>`
  });
}

/** Grant reputation, auto-promoting through as many ranks as it earns. */
export async function addReputation(trainer, orgKey, amount) {
  if (!trainer || !amount) return;
  const org = PM.organizations[orgKey];
  if (!org) return;

  const affiliations = (trainer.system.affiliations ?? []).map((a) => ({ ...a }));
  const aff = affiliations.find((a) => a.org === orgKey);
  if (!aff) return ui.notifications?.warn(`${trainer.name} is not in ${org.label}.`);

  aff.reputation += amount;
  const promotions = [];
  while (aff.rank < org.ranks.length - 1 && aff.reputation >= nextRankThreshold(aff.rank)) {
    aff.reputation -= nextRankThreshold(aff.rank);
    aff.rank += 1;
    promotions.push(rankTitle(orgKey, aff.rank));
  }
  await trainer.update({ "system.affiliations": affiliations });

  let msg = `<p>${trainer.name} earned <strong>${amount}</strong> reputation with ${org.label}.`;
  if (promotions.length) msg += ` Promoted to <strong>${promotions.at(-1)}</strong>!`;
  msg += "</p>";
  await ChatMessage.create({ speaker: { alias: org.label }, content: msg });
}

export async function leaveOrg(trainer, orgKey) {
  if (!trainer) return;
  const affiliations = (trainer.system.affiliations ?? []).filter((a) => a.org !== orgKey);
  await trainer.update({ "system.affiliations": affiliations });
}

/** Pick an org via dialog and join it. */
export async function joinOrgDialog(trainer) {
  trainer ??= resolveTrainer();
  if (!trainer) return ui.notifications?.warn("Select or assign your Trainer first.");
  const DialogV2 = foundry.applications?.api?.DialogV2;
  const keys = Object.keys(PM.organizations);
  let key = keys[0];
  if (DialogV2) {
    const opts = keys.map((k) => `<option value="${k}">${PM.organizations[k].label} (${PM.organizations[k].align})</option>`).join("");
    key = await DialogV2.prompt({
      window: { title: "Join an organization" },
      content: `<p>Which organization?</p><select name="org" style="width:100%">${opts}</select>`,
      ok: { label: "Join", callback: (event, button) => button.form.elements.org.value }
    });
  }
  if (key) return joinOrg(trainer, key);
}

export function registerOrgApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    orgs: { join: joinOrg, joinDialog: joinOrgDialog, addReputation, leave: leaveOrg, rankTitle, nextRankThreshold }
  });
}
