import { addDays, daysBetween, weekOfDay } from '../leaderboard/week';

/**
 * ─── Streaks (pure; every streak number comes from here) ───────────────────
 *
 * A streak is a run of consecutive study days (Lagos calendar days). It counts
 * up to today, or up to yesterday if the student hasn't studied yet today, so
 * it doesn't drop to 0 in the morning.
 *
 * Streak freeze: one per calendar week (Mon–Sun) automatically covers a single
 * missed day between two study days, so one bad day doesn't wipe a long
 * streak. A frozen day keeps the streak alive but doesn't add to it. Two missed
 * days in a row always end it.
 *
 * Because this is deterministic, the incremental update after each quiz and
 * the nightly recount always agree.
 */
export interface StreakInfo {
  current: number;
  longest: number;
  /** Days covered by a freeze in the current streak (oldest first). */
  frozenDays: string[];
  /** No freeze used yet this week (in the current streak). */
  freezeAvailable: boolean;
  /** Yesterday was missed and a freeze saved the streak. */
  savedByFreeze: boolean;
  lastStudyDay: string | null;
}

export function computeStreak(studyDays: Iterable<string>, today: string): StreakInfo {
  const days = [...new Set(studyDays)].filter(d => d <= today).sort();
  let run = 0;
  let longest = 0;
  let freezes: string[] = [];
  let previous: string | null = null;

  const freezeUsedInWeekOf = (day: string) => freezes.some(f => weekOfDay(f) === weekOfDay(day));

  for (const day of days) {
    if (previous === null) run = 1;
    else {
      const gap = daysBetween(previous, day);
      const missed = addDays(previous, 1);
      if (gap === 1) run += 1;
      else if (gap === 2 && !freezeUsedInWeekOf(missed)) {
        freezes.push(missed);
        run += 1;
      } else {
        run = 1;
        freezes = [];
      }
    }
    longest = Math.max(longest, run);
    previous = day;
  }

  const empty = { current: 0, longest, frozenDays: [], freezeAvailable: true, savedByFreeze: false, lastStudyDay: previous };
  if (previous === null) return empty;

  const yesterday = addDays(today, -1);
  const gapToToday = daysBetween(previous, today);
  let savedByFreeze = false;
  if (gapToToday === 2) {
    // Studied the day before yesterday, missed yesterday: a freeze can cover it.
    if (freezeUsedInWeekOf(yesterday)) return empty;
    freezes = [...freezes, yesterday];
    savedByFreeze = true;
  } else if (gapToToday > 2) {
    return empty;
  }

  return {
    current: run,
    longest,
    frozenDays: freezes,
    freezeAvailable: !freezeUsedInWeekOf(today),
    savedByFreeze,
    lastStudyDay: previous,
  };
}
