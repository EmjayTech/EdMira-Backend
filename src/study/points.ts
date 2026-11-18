import { PointsConfig } from './points-config';

/**
 * ─── Applying the points rules (pure; no database) ─────────────────────────
 * StudyService gathers the history these functions need, inside the same
 * transaction that stores the quiz, and writes what they return.
 */

export type PointsSource = 'quiz_answers' | 'quiz_complete' | 'study_day' | 'qotd' | 'improvement' | 'referral' | 'adjustment';

export interface Award {
  sourceType: PointsSource;
  /** Before the daily cap. */
  requested: number;
  /** What the student actually gets. */
  points: number;
  meta?: Record<string, unknown>;
}

export interface QuizForScoring {
  total: number;
  answeredCount: number;
  startedAt: Date;
  submittedAt: Date;
  answers: { questionId: string; selectedIndex: number | null; correct: boolean }[];
  /** "Retry weak questions": the student just saw these answers, so it earns nothing. */
  retry?: boolean;
}

/** One student's history with one question, as of just before this quiz. */
export interface QuestionHistory {
  /** Times answered correctly before (any day). */
  correctBefore: number;
  /** Times answered (not skipped) earlier today. */
  triesToday: number;
}

export interface QuizContext {
  history: Map<string, QuestionHistory>;
  /** A completed (not too fast) quiz already earned today's study-day bonus. */
  studyDayAlreadyEarned: boolean;
  /** Points already awarded today (for the daily cap). */
  pointsToday: number;
  /** The topic's attempts / average before this quiz (null: first attempt). */
  topicBefore: { attempts: number; average: number } | null;
  /** The topic's average including this quiz. */
  topicAfterAverage: number;
  /** The improvement bonus for this topic was already given this week. */
  improvedThisWeek: boolean;
}

export interface QuizScore {
  tooFast: boolean;
  secondsPerQuestion: number | null;
  completed: boolean;
  /** Correct answers that counted (not too fast). */
  correctAnswers: number;
  newStudyDay: boolean;
  improved: boolean;
  awards: Award[];
  points: number;
  capped: boolean;
}

/** Seconds per answered question, or null when nothing was answered. */
export const secondsPerQuestion = (q: Pick<QuizForScoring, 'answeredCount' | 'startedAt' | 'submittedAt'>) =>
  q.answeredCount > 0 ? (q.submittedAt.getTime() - q.startedAt.getTime()) / 1000 / q.answeredCount : null;

/** Answered faster than anyone could read the questions: earns nothing. */
export const isTooFast = (q: Pick<QuizForScoring, 'answeredCount' | 'startedAt' | 'submittedAt'>, config: PointsConfig) => {
  const s = secondsPerQuestion(q);
  return s !== null && s < config.minSecondsPerQuestion;
};

/** At least 5 questions answered, or every question of a shorter quiz. */
export const isCompleted = (q: Pick<QuizForScoring, 'total' | 'answeredCount'>, config: PointsConfig) =>
  q.answeredCount > 0 && q.answeredCount >= Math.min(config.minAnsweredForCompletedQuiz, q.total);

/** Hands out `awards` in order until the daily cap is reached. */
export function applyCap(awards: Omit<Award, 'points'>[], pointsToday: number, config: PointsConfig): Award[] {
  let room = Math.max(0, config.dailyCap - pointsToday);
  return awards.map(a => {
    const points = Math.min(a.requested, room);
    room -= points;
    return { ...a, points };
  });
}

export function scoreQuiz(quiz: QuizForScoring, ctx: QuizContext, config: PointsConfig): QuizScore {
  const tooFast = isTooFast(quiz, config);
  const completed = isCompleted(quiz, config);
  const spq = secondsPerQuestion(quiz);
  const base = { tooFast, secondsPerQuestion: spq === null ? null : Math.round(spq * 10) / 10, completed };

  if (tooFast || quiz.retry) {
    return { ...base, correctAnswers: 0, newStudyDay: false, improved: false, awards: [], points: 0, capped: false };
  }

  let answerPoints = 0;
  let full = 0;
  let reduced = 0;
  let overLimit = 0;
  let correctAnswers = 0;
  for (const a of quiz.answers) {
    if (!a.correct) continue;
    correctAnswers += 1;
    const h = ctx.history.get(a.questionId) ?? { correctBefore: 0, triesToday: 0 };
    if (h.triesToday >= config.attemptsPerQuestionPerDay) overLimit += 1;
    else if (h.correctBefore >= config.repeatAfterCorrect) {
      reduced += 1;
      answerPoints += config.repeatCorrectAnswer;
    } else {
      full += 1;
      answerPoints += config.correctAnswer;
    }
  }

  const newStudyDay = completed && !ctx.studyDayAlreadyEarned;
  const improved =
    !!ctx.topicBefore &&
    ctx.topicBefore.average < config.focusThreshold &&
    ctx.topicAfterAverage >= config.focusThreshold &&
    !ctx.improvedThisWeek;

  const requested: Omit<Award, 'points'>[] = [];
  if (answerPoints > 0) requested.push({ sourceType: 'quiz_answers', requested: answerPoints, meta: { full, reduced, overLimit } });
  if (completed) requested.push({ sourceType: 'quiz_complete', requested: config.completedQuiz });
  if (newStudyDay) requested.push({ sourceType: 'study_day', requested: config.studyDay });
  if (improved) {
    requested.push({
      sourceType: 'improvement',
      requested: config.focusImproved,
      meta: { from: ctx.topicBefore!.average, to: ctx.topicAfterAverage },
    });
  }

  const awards = applyCap(requested, ctx.pointsToday, config);
  const points = awards.reduce((sum, a) => sum + a.points, 0);
  return {
    ...base,
    correctAnswers,
    newStudyDay,
    improved,
    awards,
    points,
    capped: awards.some(a => a.points < a.requested),
  };
}

export function scoreQotd(correct: boolean, pointsToday: number, config: PointsConfig): Award {
  return applyCap(
    [{ sourceType: 'qotd', requested: correct ? config.qotdCorrect : config.qotdWrong, meta: { correct } }],
    pointsToday,
    config,
  )[0];
}
