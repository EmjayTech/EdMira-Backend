/**
 * ─── Badges (shown on profiles and student cards) ────────────────────────────
 *
 * Automatic badges come from a student's activity; nothing to maintain.
 * Manual badges are given (or taken away) by admins in the dashboard.
 * Founding Tester is automatic for accounts created before the public launch,
 * and admins can also give or remove it.
 */

/** Public v1.0 launch: midnight 14 Dec 2026 in Lagos. Override with FOUNDING_TESTER_CUTOFF (ISO date). */
export const PUBLIC_LAUNCH = new Date(process.env.FOUNDING_TESTER_CUTOFF || '2026-12-14T00:00:00+01:00');

export const AUTO_BADGES = ['streak_7', 'streak_30', 'mastered_10', 'weekly_top3', 'challenge_wins_5'] as const;
export const MANUAL_BADGES = ['founding_tester', 'campus_ambassador'] as const;
export type Badge = (typeof AUTO_BADGES)[number] | (typeof MANUAL_BADGES)[number];
export type ManualBadge = (typeof MANUAL_BADGES)[number];

/** Display order (most special first). */
const ORDER: Badge[] = ['founding_tester', 'campus_ambassador', 'weekly_top3', 'streak_30', 'mastered_10', 'challenge_wins_5', 'streak_7'];

export interface BadgeStats {
  createdAt?: Date;
  /** Longest run of consecutive practice days, ever. */
  longestStreak: number;
  topicsMastered: number;
  /** Ever finished a week in the top 3 of All of EdMira. */
  weeklyTop3: boolean;
  challengeWins: number;
  /** Admin overrides. */
  granted?: string[];
  revoked?: string[];
}

export function badgesFor(s: BadgeStats): Badge[] {
  const earned = new Set<Badge>();
  if (s.createdAt && s.createdAt < PUBLIC_LAUNCH) earned.add('founding_tester');
  if (s.longestStreak >= 7) earned.add('streak_7');
  if (s.longestStreak >= 30) earned.add('streak_30');
  if (s.topicsMastered >= 10) earned.add('mastered_10');
  if (s.weeklyTop3) earned.add('weekly_top3');
  if (s.challengeWins >= 5) earned.add('challenge_wins_5');
  for (const b of s.granted ?? []) if ((MANUAL_BADGES as readonly string[]).includes(b)) earned.add(b as Badge);
  for (const b of s.revoked ?? []) earned.delete(b as Badge);
  return ORDER.filter(b => earned.has(b));
}

/** Longest run of consecutive days in a list of "YYYY-MM-DD" (any order, duplicates fine). */
export function longestRun(days: Iterable<string>): number {
  const sorted = [...new Set(days)].sort();
  let best = 0;
  let run = 0;
  let prev = 0;
  for (const d of sorted) {
    const t = Date.parse(`${d}T00:00:00Z`);
    run = prev && t - prev === 86_400_000 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  return best;
}
