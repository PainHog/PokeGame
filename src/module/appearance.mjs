/**
 * Pokémon Masters — trainer appearance picker.
 *
 * Lets a player choose their trainer sprite and gender, like picking the
 * boy/girl protagonist at the start of a game. Opens a small gallery of the
 * bundled Gen-3 trainer avatars (see PM.playerAvatars) filtered by gender, and
 * applies the chosen sprite to both the actor image and its prototype token so
 * the map, sheet and any spawned token all match.
 *
 * Offered automatically the first time a trainer is set up (onboarding) and any
 * time from the trainer sheet's “Appearance” button.
 */

import { PM } from "./config.mjs";

const SCOPE = "pokemon-masters";

/** Build the avatar grid markup for a given gender ("male" | "female"). */
function galleryHtml(gender, selectedId) {
  const cards = PM.playerAvatars
    .filter((a) => a.gender === gender)
    .map((a) => {
      const sel = a.id === selectedId ? " pm-avatar--selected" : "";
      return `<label class="pm-avatar${sel}" title="${a.label}">
        <input type="radio" name="avatar" value="${a.id}"${a.id === selectedId ? " checked" : ""} hidden>
        <img src="${PM.avatarImg(a.id)}" alt="${a.label}" width="64" height="64" loading="lazy">
        <span>${a.label}</span>
      </label>`;
    })
    .join("");
  return `<div class="pm-avatar-grid">${cards}</div>`;
}

/** Full dialog content: gender toggle + avatar gallery, wired with a little JS. */
function dialogContent(actor) {
  const current = actor.getFlag(SCOPE, "avatar") ?? {};
  const gender = current.gender ?? actor.system?.gender ?? "male";
  const selectedId = current.id ?? null;
  return `
  <div class="pm-appearance">
    <div class="pm-gender-toggle">
      <label><input type="radio" name="gender" value="male"${gender === "male" ? " checked" : ""}> ♂ Boy</label>
      <label><input type="radio" name="gender" value="female"${gender === "female" ? " checked" : ""}> ♀ Girl</label>
    </div>
    <div class="pm-avatar-host">${galleryHtml(gender, selectedId)}</div>
  </div>`;
}

/**
 * Open the appearance picker for a trainer and apply the choice.
 * Returns the chosen avatar id, or null if cancelled.
 */
export async function chooseAvatar(actor) {
  if (!actor || actor.type !== "trainer") return null;
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2) return null;

  let picked = null;
  const result = await DialogV2.wait({
    window: { title: `Choose Your Look — ${actor.name}`, icon: "fa-solid fa-user" },
    position: { width: 460 },
    content: dialogContent(actor),
    buttons: [
      {
        action: "ok",
        label: "Confirm",
        default: true,
        callback: (event, button, dialog) => {
          const root = dialog?.element ?? button?.form ?? document;
          const sel = root.querySelector('input[name="avatar"]:checked');
          const g = root.querySelector('input[name="gender"]:checked');
          return { id: sel?.value ?? null, gender: g?.value ?? "male" };
        }
      },
      { action: "cancel", label: "Cancel", callback: () => null }
    ],
    render: (event, dialog) => {
      // Live gender toggle re-renders the gallery in place.
      const root = dialog?.element ?? dialog;
      const host = root.querySelector(".pm-avatar-host");
      root.querySelectorAll('input[name="gender"]').forEach((el) =>
        el.addEventListener("change", () => {
          const g = root.querySelector('input[name="gender"]:checked')?.value ?? "male";
          const cur = root.querySelector('input[name="avatar"]:checked')?.value ?? null;
          host.innerHTML = galleryHtml(g, cur);
        })
      );
      // Clicking a card highlights it.
      root.addEventListener("change", (ev) => {
        if (ev.target?.name !== "avatar") return;
        root.querySelectorAll(".pm-avatar").forEach((c) => c.classList.remove("pm-avatar--selected"));
        ev.target.closest(".pm-avatar")?.classList.add("pm-avatar--selected");
      });
    },
    rejectClose: false
  }).catch(() => null);

  if (!result || !result.id) return null;
  picked = result;

  await applyAvatar(actor, picked.id, picked.gender);
  return picked.id;
}

/** Set an actor's image + prototype token to the given avatar id. */
export async function applyAvatar(actor, id, gender) {
  if (!actor || !id) return;
  const img = PM.avatarImg(id);
  const update = {
    img,
    "prototypeToken.texture.src": img,
    [`flags.${SCOPE}.avatar`]: { id, gender: gender ?? actor.system?.gender ?? "male" },
  };
  if (gender && actor.system?.gender !== undefined) update["system.gender"] = gender;
  await actor.update(update);
  // Refresh any tokens already placed for this actor (placed tokens keep their
  // own texture snapshot, so the prototype change alone won't reach them).
  for (const scene of game.scenes ?? []) {
    const toks = (scene.tokens ?? []).filter((t) => t.actorId === actor.id && t.actorLink);
    for (const t of toks) await t.update({ "texture.src": img }).catch(() => {});
  }
}

/**
 * Offer the picker once, the first time a player sets up their trainer
 * (onboarding). Resolves immediately if they've already chosen a look.
 */
export async function offerAvatarOnce(actor) {
  if (!actor || actor.type !== "trainer") return;
  if (actor.getFlag(SCOPE, "avatar")?.id) return;
  await chooseAvatar(actor);
}

export function registerAppearanceApi() {
  game.pokemonMasters = Object.assign(game.pokemonMasters ?? {}, {
    appearance: { choose: chooseAvatar, apply: applyAvatar, offerOnce: offerAvatarOnce },
  });
}
