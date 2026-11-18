import { DEFAULT_POINTS } from './points-config';
import { QuizContext, QuizForScoring, isCompleted, scoreQotd, scoreQuiz } from './points';

const at = (seconds: number) => ({ startedAt: new Date(0), submittedAt: new Date(seconds * 1000) });

/** `right` correct out of `total`, all answered, taking 20 s a question. */
const quiz = (total: number, right: number, secondsPerQuestion = 20): QuizForScoring => ({
  total,
  answeredCount: total,
  ...at(total * secondsPerQuestion),
  answers: Array.from({ length: total }, (_, i) => ({ questionId: `q${i}`, selectedIndex: 0, correct: i < right })),
});

const ctx = (overrides: Partial<QuizContext> = {}): QuizContext => ({
  history: new Map(),
  studyDayAlreadyEarned: false,
  pointsToday: 0,
  topicBefore: null,
  topicAfterAverage: 70,
  improvedThisWeek: false,
  ...overrides,
});

describe('points', () => {
  it('first quiz of the day: +10 a correct answer, +5 for finishing, +20 for the study day', () => {
    const s = scoreQuiz(quiz(10, 7), ctx(), DEFAULT_POINTS);
    expect(s.points).toBe(70 + 5 + 20);
    expect(s).toMatchObject({ completed: true, newStudyDay: true, correctAnswers: 7, capped: false });
    expect(s.awards.map(a => [a.sourceType, a.points])).toEqual([
      ['quiz_answers', 70],
      ['quiz_complete', 5],
      ['study_day', 20],
    ]);
  });

  it('gives the study-day bonus once a day', () => {
    expect(scoreQuiz(quiz(10, 7), ctx({ studyDayAlreadyEarned: true }), DEFAULT_POINTS).points).toBe(75);
  });

  it('gives +2 for a question already answered correctly twice', () => {
    const history = new Map([
      ['q0', { correctBefore: 2, triesToday: 0 }],
      ['q1', { correctBefore: 1, triesToday: 0 }],
    ]);
    const s = scoreQuiz(quiz(5, 2), ctx({ history, studyDayAlreadyEarned: true }), DEFAULT_POINTS);
    expect(s.points).toBe(2 + 10 + 5);
    expect(s.awards[0].meta).toEqual({ full: 1, reduced: 1, overLimit: 0 });
  });

  it('only counts the first 3 tries at a question each day', () => {
    const history = new Map([['q0', { correctBefore: 0, triesToday: 3 }]]);
    const s = scoreQuiz(quiz(5, 1), ctx({ history, studyDayAlreadyEarned: true }), DEFAULT_POINTS);
    expect(s.points).toBe(5);
    expect(s.awards.map(a => a.sourceType)).toEqual(['quiz_complete']);
  });

  it('a quiz is complete at 5 answered, or all of a shorter quiz', () => {
    expect(isCompleted({ total: 10, answeredCount: 5 }, DEFAULT_POINTS)).toBe(true);
    expect(isCompleted({ total: 10, answeredCount: 4 }, DEFAULT_POINTS)).toBe(false);
    expect(isCompleted({ total: 3, answeredCount: 3 }, DEFAULT_POINTS)).toBe(true);
    expect(isCompleted({ total: 3, answeredCount: 2 }, DEFAULT_POINTS)).toBe(false);
  });

  it('an unfinished quiz still earns its correct answers but no bonuses', () => {
    const q = { ...quiz(10, 3), answeredCount: 3 };
    const s = scoreQuiz(q, ctx(), DEFAULT_POINTS);
    expect(s).toMatchObject({ completed: false, newStudyDay: false, points: 30 });
  });

  it('a "Retry weak questions" run earns nothing (the answers were just shown)', () => {
    const s = scoreQuiz({ ...quiz(3, 3), retry: true }, ctx({ topicBefore: { attempts: 1, average: 40 } }), DEFAULT_POINTS);
    expect(s).toMatchObject({ points: 0, awards: [], newStudyDay: false, improved: false, correctAnswers: 0 });
  });

  it('a quiz faster than 2 seconds a question earns nothing', () => {
    const s = scoreQuiz(quiz(10, 10, 1.9), ctx(), DEFAULT_POINTS);
    expect(s).toMatchObject({ tooFast: true, points: 0, newStudyDay: false, awards: [] });
    expect(scoreQuiz(quiz(10, 10, 2), ctx(), DEFAULT_POINTS).tooFast).toBe(false);
  });

  it('caps the day at 400 points', () => {
    const s = scoreQuiz(quiz(40, 40), ctx({ pointsToday: 100 }), DEFAULT_POINTS);
    expect(s.points).toBe(300);
    expect(s.capped).toBe(true);
    expect(s.awards.find(a => a.sourceType === 'quiz_answers')).toMatchObject({ requested: 400, points: 300 });
    expect(s.awards.find(a => a.sourceType === 'study_day')).toMatchObject({ requested: 20, points: 0 });
    expect(scoreQuiz(quiz(10, 10), ctx({ pointsToday: 400 }), DEFAULT_POINTS).points).toBe(0);
  });

  it('+25 when a Focus Area topic reaches 60%, once a week', () => {
    const improving = ctx({ topicBefore: { attempts: 2, average: 45 }, topicAfterAverage: 62, studyDayAlreadyEarned: true });
    expect(scoreQuiz(quiz(10, 9), improving, DEFAULT_POINTS)).toMatchObject({ improved: true, points: 90 + 5 + 25 });
    expect(scoreQuiz(quiz(10, 9), { ...improving, improvedThisWeek: true }, DEFAULT_POINTS).improved).toBe(false);
    expect(scoreQuiz(quiz(10, 9), { ...improving, topicAfterAverage: 59 }, DEFAULT_POINTS).improved).toBe(false);
    // A first attempt has nothing to improve on.
    expect(scoreQuiz(quiz(10, 9), ctx({ topicAfterAverage: 90 }), DEFAULT_POINTS).improved).toBe(false);
  });

  it('QOTD: +15 right, +5 wrong, within the cap', () => {
    expect(scoreQotd(true, 0, DEFAULT_POINTS).points).toBe(15);
    expect(scoreQotd(false, 0, DEFAULT_POINTS).points).toBe(5);
    expect(scoreQotd(true, 390, DEFAULT_POINTS)).toMatchObject({ requested: 15, points: 10 });
  });
});
