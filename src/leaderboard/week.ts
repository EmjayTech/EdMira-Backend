/**
 * Leaderboard weeks run Monday 00:00 → Sunday 23:59 in Lagos (WAT, UTC+1,
 * no daylight saving). Weeks are identified by their Monday's date in Lagos,
 * e.g. "2026-11-16".
 */

const LAGOS_OFFSET_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Lagos calendar date of an instant: "2026-11-16". */
export const lagosDay = (at: Date): string => new Date(at.getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);

/** The Lagos Monday ("YYYY-MM-DD") of the week containing `at`. */
export function weekOf(at: Date): string {
  const lagos = new Date(at.getTime() + LAGOS_OFFSET_MS);
  const daysSinceMonday = (lagos.getUTCDay() + 6) % 7;
  return new Date(lagos.getTime() - daysSinceMonday * DAY_MS).toISOString().slice(0, 10);
}

/** The instants a week covers: [start, end). */
export function weekRange(week: string): { start: Date; end: Date } {
  const start = new Date(Date.parse(`${week}T00:00:00.000Z`) - LAGOS_OFFSET_MS);
  return { start, end: new Date(start.getTime() + 7 * DAY_MS) };
}

/** "YYYY-MM-DD" that is a Monday. */
export const isWeekId = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(`${value}T00:00:00Z`).getUTCDay() === 1;

/** The week before `week`. */
export const previousWeek = (week: string): string =>
  new Date(Date.parse(`${week}T00:00:00Z`) - 7 * DAY_MS).toISOString().slice(0, 10);

/**
 * Consecutive Lagos days with practice, ending today — or yesterday if the
 * student hasn't practised yet today (the streak isn't broken until tonight).
 */
export function streakDays(practiceDays: Iterable<string>, now = new Date()): number {
  const days = new Set(practiceDays);
  let cursor = now;
  if (!days.has(lagosDay(cursor))) cursor = new Date(cursor.getTime() - DAY_MS);
  let streak = 0;
  while (days.has(lagosDay(cursor))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  return streak;
}

/** The day `n` days after `day` ("YYYY-MM-DD"; n may be negative). */
export const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Whole days from `from` to `to` (both "YYYY-MM-DD"). */
export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** The Lagos Monday of the week a Lagos calendar day belongs to. */
export function weekOfDay(day: string): string {
  const daysSinceMonday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(day, -daysSinceMonday);
}

/** The hour (0–23) in Lagos at `at`. */
export const lagosHour = (at: Date): number => new Date(at.getTime() + LAGOS_OFFSET_MS).getUTCHours();
