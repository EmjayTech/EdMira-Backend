import { SCORING, ScoredAttempt, scoreWeek } from './scoring';
import { isWeekId, lagosDay, previousWeek, streakDays, weekOf, weekRange } from './week';

// Wednesday 18 Nov 2026, 10:00 in Lagos (09:00 UTC).
const WED = Date.parse('2026-11-18T09:00:00Z');
const DAY = 86_400_000;

let n = 0;
/** A 10-question quiz on `topic`, taking 2 minutes, `correct` of them right. */
const quiz = (topic: string, correct: string[], opts: Partial<ScoredAttempt> & { at?: number } = {}): ScoredAttempt => {
  const submittedAt = new Date(opts.at ?? WED + n++ * 60_000);
  return {
    topicId: topic,
    startedAt: new Date(submittedAt.getTime() - 120_000),
    submittedAt,
    total: 10,
    answeredCount: 10,
    score: correct.length * 10,
    correctQuestionIds: correct,
    ...opts,
  };
};
const qs = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i}`);

describe('weekly score', () => {
  it('adds correct answers, completed quizzes and the active day', () => {
    const score = scoreWeek([quiz('t1', qs('a', 7))], new Map());
    expect(score).toEqual({ points: 7 + 2 + 2, correct: 7, quizzes: 1, improvements: 0, activeDays: 1 });
  });

  it('counts each question once a week, so retaking the same quiz earns little', () => {
    const same = qs('a', 8);
    const score = scoreWeek([quiz('t1', same), quiz('t1', same), quiz('t1', same)], new Map());
    expect(score.correct).toBe(8);
    expect(score.points).toBe(8 + 3 * SCORING.completedQuiz + SCORING.activeDay);
  });

  it('caps completion points at 5 quizzes a day', () => {
    const score = scoreWeek(Array.from({ length: 8 }, (_, i) => quiz(`t${i}`, [])), new Map());
    expect(score.quizzes).toBe(5);
  });

  it('only counts a quiz as completed when 80% of its questions are answered', () => {
    expect(scoreWeek([quiz('t1', [], { answeredCount: 7 })], new Map()).quizzes).toBe(0);
    expect(scoreWeek([quiz('t1', [], { answeredCount: 8 })], new Map()).quizzes).toBe(1);
  });

  it('gives nothing for a quiz tapped through faster than 3 s a question', () => {
    const at = WED;
    const fast = quiz('t1', qs('a', 10), { at, startedAt: new Date(at - 20_000) });
    expect(scoreWeek([fast], new Map())).toEqual({ points: 0, correct: 0, quizzes: 0, improvements: 0, activeDays: 0 });
  });

  it('rewards beating a previous best by 10+ points, once per topic, never on a first attempt', () => {
    const first = scoreWeek([quiz('t1', qs('a', 9))], new Map());
    expect(first.improvements).toBe(0);

    const before = new Map([['t1', 50]]);
    const better = scoreWeek([quiz('t1', qs('a', 6)), quiz('t1', qs('b', 8)), quiz('t1', qs('c', 10))], before);
    expect(better.improvements).toBe(1);

    expect(scoreWeek([quiz('t1', qs('a', 5))], new Map([['t1', 50]])).improvements).toBe(0);
    // Improving on an earlier attempt from the same week counts too.
    expect(scoreWeek([quiz('t2', qs('a', 4)), quiz('t2', qs('b', 6))], new Map()).improvements).toBe(1);
  });

  it('adds 2 per practice day and 5 extra for all 7', () => {
    const monday = Date.parse('2026-11-16T08:00:00Z');
    const week = Array.from({ length: 7 }, (_, d) => quiz(`t${d}`, [], { at: monday + d * DAY }));
    const score = scoreWeek(week, new Map());
    expect(score.activeDays).toBe(7);
    expect(score.points).toBe(7 * SCORING.completedQuiz + 7 * SCORING.activeDay + SCORING.fullWeekBonus);
  });

  it('matches the worked example in the plan (66 points)', () => {
    const before = new Map([['imp1', 40], ['imp2', 40]]);
    const attempts = [
      quiz('imp1', qs('a', 10), { at: WED }),
      quiz('imp2', qs('b', 10), { at: WED + 60_000 }),
      quiz('x', qs('c', 10), { at: WED + DAY }),
      quiz('y', qs('d', 10), { at: WED + 2 * DAY }),
      quiz('z', [], { at: WED + 3 * DAY }),
      quiz('z', [], { at: WED + 3 * DAY + 60_000 }),
    ];
    expect(scoreWeek(attempts, before)).toMatchObject({ correct: 40, quizzes: 6, improvements: 2, activeDays: 4, points: 66 });
  });
});

describe('Lagos weeks', () => {
  it('starts on Monday 00:00 in Lagos (Sunday 23:00 UTC)', () => {
    expect(weekOf(new Date('2026-11-15T22:59:59Z'))).toBe('2026-11-09'); // Sunday 23:59 Lagos
    expect(weekOf(new Date('2026-11-15T23:00:00Z'))).toBe('2026-11-16'); // Monday 00:00 Lagos
    expect(weekOf(new Date('2026-11-22T22:00:00Z'))).toBe('2026-11-16'); // Sunday 23:00 Lagos
    expect(weekRange('2026-11-16')).toEqual({
      start: new Date('2026-11-15T23:00:00Z'),
      end: new Date('2026-11-22T23:00:00Z'),
    });
  });

  it('uses Lagos dates for days', () => {
    expect(lagosDay(new Date('2026-11-18T23:30:00Z'))).toBe('2026-11-19');
  });

  it('validates week ids and steps back a week', () => {
    expect(isWeekId('2026-11-16')).toBe(true);
    expect(isWeekId('2026-11-17')).toBe(false);
    expect(isWeekId('nope')).toBe(false);
    expect(previousWeek('2026-11-16')).toBe('2026-11-09');
  });

  it('counts a streak until yesterday when today has no practice yet', () => {
    const now = new Date('2026-11-18T12:00:00Z');
    expect(streakDays(['2026-11-16', '2026-11-17'], now)).toBe(2);
    expect(streakDays(['2026-11-16', '2026-11-17', '2026-11-18'], now)).toBe(3);
    expect(streakDays(['2026-11-15', '2026-11-17'], now)).toBe(1);
    expect(streakDays([], now)).toBe(0);
  });
});
