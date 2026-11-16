import { lagosDay } from './week';

/**
 * ─── Weekly leaderboard score (the one place the formula lives) ─────────────
 *
 * Rewards practice and improvement, not farming one easy quiz:
 *   +1  per question answered correctly — each question counts once a week
 *   +2  per completed quiz (≥ 80% of its questions answered), max 5 a day
 *   +3  per topic where you beat your previous best by ≥ 10 points
 *       (once per topic a week; a first attempt has nothing to beat)
 *   +2  per day you practised this week, +5 extra for all 7 days
 *    0  for a quiz finished faster than 3 seconds per question
 *
 * Changing a number here? Run `yarn leaderboard rebuild` to recount the week.
 */
export const SCORING = {
  correctAnswer: 1,
  completedQuiz: 2,
  completedQuizzesPerDay: 5,
  completionShare: 0.8,
  improvement: 3,
  improvementMinGain: 10,
  activeDay: 2,
  fullWeekBonus: 5,
  minSecondsPerQuestion: 3,
} as const;

/** What scoring needs from a quiz attempt. */
export interface ScoredAttempt {
  topicId: string;
  startedAt: Date;
  submittedAt: Date;
  total: number;
  answeredCount: number;
  score: number;
  /** Ids of the questions answered correctly. */
  correctQuestionIds: string[];
}

export interface WeekScore {
  points: number;
  correct: number;
  quizzes: number;
  improvements: number;
  activeDays: number;
}

/** Faster than 3 seconds a question: tapped through, not practised. */
export const isTooFast = (a: ScoredAttempt) =>
  a.total > 0 && (a.submittedAt.getTime() - a.startedAt.getTime()) / 1000 < SCORING.minSecondsPerQuestion * a.total;

/**
 * Score one student's week.
 * @param attempts   that week's attempts (any order)
 * @param bestBefore each topic's best score from before the week
 */
export function scoreWeek(attempts: ScoredAttempt[], bestBefore: Map<string, number>): WeekScore {
  const correct = new Set<string>();
  const completedPerDay = new Map<string, number>();
  const improved = new Set<string>();
  const activeDays = new Set<string>();
  const best = new Map(bestBefore);
  let quizzes = 0;

  for (const a of [...attempts].sort((x, y) => x.submittedAt.getTime() - y.submittedAt.getTime())) {
    if (isTooFast(a)) continue;
    const day = lagosDay(a.submittedAt);
    activeDays.add(day);
    a.correctQuestionIds.forEach(id => correct.add(id));

    if (a.total > 0 && a.answeredCount >= SCORING.completionShare * a.total) {
      const today = completedPerDay.get(day) ?? 0;
      if (today < SCORING.completedQuizzesPerDay) quizzes += 1;
      completedPerDay.set(day, today + 1);
    }

    const previous = best.get(a.topicId);
    if (previous !== undefined && a.score - previous >= SCORING.improvementMinGain) improved.add(a.topicId);
    best.set(a.topicId, Math.max(previous ?? 0, a.score));
  }

  const days = activeDays.size;
  const points =
    correct.size * SCORING.correctAnswer +
    quizzes * SCORING.completedQuiz +
    improved.size * SCORING.improvement +
    days * SCORING.activeDay +
    (days >= 7 ? SCORING.fullWeekBonus : 0);
  return { points, correct: correct.size, quizzes, improvements: improved.size, activeDays: days };
}
