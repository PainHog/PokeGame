/**
 * Pokémon Masters — real named-character portraits (optional override layer).
 *
 * This map is EMPTY by default, so out of the box every named leader / Elite
 * Four / champion / professor uses the gender- and role-appropriate class sprite
 * chosen in config.mjs (npcSpriteMatch). That keeps the system fully
 * self-contained with only the sprites reachable from open GitHub decomps.
 *
 * Pokémon Showdown, however, hosts a real portrait for EVERY named character in
 * every generation (Cynthia, Leon, Nessa, Iono, …). That host is blocked inside
 * the build sandbox, but it is reachable from an ordinary machine. Running
 *
 *     npm run avatars
 *
 * anywhere Showdown is reachable downloads those portraits into assets/trainers/
 * and REWRITES this file to map each character to its real sprite. From then on
 * the world uses the real portraits — and, since the files are vendored into the
 * repo, the game stays self-contained (no run-time network calls).
 *
 * Keyed by the character's lowercase name; value is a file in assets/trainers/.
 * Auto-generated — do not edit by hand (npm run avatars overwrites it).
 */
export const NAMED_AVATARS = {};
