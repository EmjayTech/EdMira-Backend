/**
 * ─── Points (the one place the values live) ────────────────────────────────
 *
 * Points reward regular, honest practice and improvement, not one lucky quiz
 * or farming easy questions. Everything is calculated on the server; the app
 * never sends point values. See points.ts for how they're applied.
 *
 *   +10 per correct answer — +2 once you've answered that question correctly
 *       twice before; only your first 3 tries at a question each day count
 *   +5  per completed quiz (≥ 5 questions answered, or all of a shorter quiz)
 *   +20 for the first completed quiz of a day (a "study day")
 *   +15 for a correct Question of the Day, +5 for a wrong one
 *   +25 when a Focus Area topic (average < 60%) reaches 60% or more
 *       (at most once per topic a week)
 *   400 points a day at most (study points; referrals sit outside it)
 *   +10 when a classmate you invited completes their first quiz — at most 5
 *       of these a week count on the weekly leaderboard (all count lifetime)
 *    0  for a whole quiz answered faster than 2 seconds a question (logged)
 *
 * Changing a value? Run `yarn progress rebuild` to recount everyone.
 * Part C will let admins override these from the dashboard.
 */
export interface PointsConfig {
  correctAnswer: number;
  repeatCorrectAnswer: number;
  /** Correct this many times before → `repeatCorrectAnswer` instead. */
  repeatAfterCorrect: number;
  attemptsPerQuestionPerDay: number;
  completedQuiz: number;
  minAnsweredForCompletedQuiz: number;
  studyDay: number;
  qotdCorrect: number;
  qotdWrong: number;
  focusImproved: number;
  focusThreshold: number;
  dailyCap: number;
  minSecondsPerQuestion: number;
  /** Inviter's reward when the invited student completes a first quiz. */
  referral: number;
  /** Referral rewards a week that count on the weekly leaderboard. */
  referralLeaderboardPerWeek: number;
}

export const DEFAULT_POINTS: Readonly<PointsConfig> = Object.freeze({
  correctAnswer: 10,
  repeatCorrectAnswer: 2,
  repeatAfterCorrect: 2,
  attemptsPerQuestionPerDay: 3,
  completedQuiz: 5,
  minAnsweredForCompletedQuiz: 5,
  studyDay: 20,
  qotdCorrect: 15,
  qotdWrong: 5,
  focusImproved: 25,
  focusThreshold: 60,
  dailyCap: 400,
  minSecondsPerQuestion: 2,
  referral: 10,
  referralLeaderboardPerWeek: 5,
});

/** Default weekly goal (study days a week) and its allowed range. */
export const WEEKLY_GOAL = { default: 3, min: 1, max: 7 } as const;
