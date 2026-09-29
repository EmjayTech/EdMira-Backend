/**
 * EdMira Pro — what's free, what's paid, and the Google Play products.
 *
 * Free students get notes, news and a few quizzes a day. Pro unlocks
 * unlimited quizzes, answer explanations, offline downloads and mock exams.
 */

/** Pro features, as named in PRO_REQUIRED errors so the app can explain. */
export enum ProFeature {
  UNLIMITED_QUIZZES = 'unlimitedQuizzes',
  EXPLANATIONS = 'explanations',
  OFFLINE_DOWNLOADS = 'offlineDownloads',
  MOCK_EXAMS = 'mockExams',
}

/** Error code the app checks for to show the paywall. */
export const PRO_REQUIRED = 'PRO_REQUIRED';

/** Quizzes a free student may take per day (override with FREE_DAILY_QUIZ_LIMIT). */
export const DEFAULT_FREE_DAILY_QUIZ_LIMIT = 3;

/**
 * Days are counted in Nigerian time (WAT, UTC+1 all year), so the free
 * quizzes reset at midnight for students, not at 1am.
 */
export const DAY_OFFSET_MS = 60 * 60 * 1000;

/**
 * Google Play subscription product IDs that grant Pro. One product with
 * several base plans (e.g. weekly / monthly / semester) set up in Play Console.
 */
export const PRO_PRODUCT_IDS = ['edmira_pro'];

export const DEFAULT_PACKAGE_NAME = 'com.emjaytech.edmira';

/** Start of "today" in Nigerian time, as a UTC Date. */
export const startOfLagosDay = (now = new Date()) => {
  const local = new Date(now.getTime() + DAY_OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - DAY_OFFSET_MS);
};
