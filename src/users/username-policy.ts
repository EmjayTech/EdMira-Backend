/**
 * ─── Username rules (the one place to change them) ──────────────────────────
 *
 * A username is a student's public identity and a login name, so:
 *   - 3–20 characters: letters, numbers, "_" and "."; can't start or end with "."
 *     (no spaces and no "@" — anything with "@" is treated as an email at login)
 *   - unique ignoring case ("Ada" and "ada" are the same username)
 *   - not reserved for EdMira itself, and not offensive
 *
 * Accounts created before Nov 2026 may break these rules; they keep working
 * (login matches them by `usernameLower`) and the rules apply when a username
 * is chosen or changed. Mirror: EdMira-MobileApp/src/utils/validation.ts.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;

/** First and last character can't be "."; total length 3–20. */
export const USERNAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.]{1,18}[A-Za-z0-9_]$/;

export const USERNAME_RULE_MESSAGE =
  'Usernames are 3–20 characters: letters, numbers, _ and . (not at the start or end). No spaces or @.';

/** Days between username changes, and how long a released username stays reserved. */
export const USERNAME_CHANGE_COOLDOWN_DAYS = 30;
export const USERNAME_RESERVATION_DAYS = 30;

/** Kept for EdMira (and the staff "official" badge). Anything starting with "edmira" is reserved too. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'edmira',
  'support',
  'help',
  'official',
  'moderator',
  'mod',
  'staff',
  'team',
  'root',
  'system',
  'null',
  'undefined',
]);

/**
 * Offensive words, matched after undoing common look-alikes (4→a, 3→e, 1→i,
 * 0→o, 5→s, 7→t, $→s) and removing "_" and ".":
 *   - CONTAINS: blocked anywhere in the username (long, unambiguous words).
 *   - EXACT: blocked only as a whole part between "_"/"."/digits, because they
 *     appear inside ordinary words ("ass" in "class", "hell" in "shell").
 * Add Nigerian Pidgin, Hausa and Yoruba terms here as the team supplies them.
 */
export const OFFENSIVE_CONTAINS: readonly string[] = [
  'fuck', 'shit', 'bitch', 'cunt', 'nigger', 'nigga', 'faggot', 'whore', 'slut', 'rapist',
  'pussy', 'dickhead', 'asshole', 'bastard', 'motherfucker', 'retard', 'porn', 'nazi',
];
export const OFFENSIVE_EXACT: readonly string[] = [
  'ass', 'dick', 'cock', 'fag', 'hoe', 'rape', 'sex', 'tits', 'boobs', 'penis', 'vagina', 'anus', 'kill',
];

export type UsernameProblem = 'invalid' | 'reserved' | 'offensive';

/** Lower-case, trimmed form used for uniqueness and lookups. */
export const normalizeUsername = (raw: string) => raw.trim().toLowerCase();

const LOOK_ALIKES: Record<string, string> = { '4': 'a', '@': 'a', '3': 'e', '1': 'i', '!': 'i', '0': 'o', '5': 's', '$': 's', '7': 't' };
const unLeet = (s: string) => s.replace(/[4@31!05$7]/g, c => LOOK_ALIKES[c]);

export function isReservedUsername(raw: string): boolean {
  const lower = normalizeUsername(raw);
  const plain = unLeet(lower).replace(/[._]/g, '');
  return RESERVED_USERNAMES.has(lower) || RESERVED_USERNAMES.has(plain) || plain.startsWith('edmira');
}

export function isOffensiveUsername(raw: string): boolean {
  const lower = normalizeUsername(raw);
  const joined = unLeet(lower).replace(/[._]/g, '');
  if (OFFENSIVE_CONTAINS.some(word => joined.includes(word))) return true;
  // Whole parts only: split on separators and digits *before* undoing look-alikes.
  const parts = lower.split(/[._0-9]+/).filter(Boolean).map(unLeet);
  return parts.some(part => OFFENSIVE_EXACT.includes(part)) || OFFENSIVE_EXACT.includes(joined);
}

/**
 * The first rule a new username breaks, or null if it's fine (uniqueness is
 * checked separately, against the database). Staff accounts may use reserved names.
 */
export function usernameProblem(raw: string, opts: { allowReserved?: boolean } = {}): UsernameProblem | null {
  const value = raw.trim();
  if (!USERNAME_PATTERN.test(value)) return 'invalid';
  if (isOffensiveUsername(value)) return 'offensive';
  if (!opts.allowReserved && isReservedUsername(value)) return 'reserved';
  return null;
}

/** A valid starting point for an automatic username (e.g. from a staff email): "Ada Obi!" → "adaobi". */
export function usernameStem(base: string): string {
  let stem = normalizeUsername(base)
    .replace(/[^a-z0-9_.]/g, '')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, USERNAME_MAX - 3)
    .replace(/\.+$/, '');
  if (stem.length < 3) stem = `${stem}staff`.slice(0, USERNAME_MAX - 3);
  return stem;
}

/** Messages for the API (the app shows its own translated text per `reason`). */
export const USERNAME_PROBLEM_MESSAGE: Record<UsernameProblem | 'taken', string> = {
  invalid: USERNAME_RULE_MESSAGE,
  reserved: 'That username is reserved. Please choose another.',
  offensive: "That username isn't allowed. Please choose another.",
  taken: 'That username is already taken. Please choose another.',
};
