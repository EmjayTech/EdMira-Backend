import { PUBLIC_LAUNCH, badgesFor, longestRun } from './badges';

const base = { longestStreak: 0, topicsMastered: 0, weeklyTop3: false, challengeWins: 0 };

describe('badges', () => {
  it('gives Founding Tester to accounts created before the public launch (14 Dec 2026, Lagos)', () => {
    expect(PUBLIC_LAUNCH.toISOString()).toBe('2026-12-13T23:00:00.000Z');
    expect(badgesFor({ ...base, createdAt: new Date('2026-12-13T22:59:59Z') })).toEqual(['founding_tester']);
    expect(badgesFor({ ...base, createdAt: new Date('2026-12-13T23:00:00Z') })).toEqual([]);
  });

  it('awards activity badges at their thresholds, most special first', () => {
    expect(badgesFor({ ...base, longestStreak: 6, topicsMastered: 9, challengeWins: 4 })).toEqual([]);
    expect(badgesFor({ longestStreak: 30, topicsMastered: 10, weeklyTop3: true, challengeWins: 5 })).toEqual([
      'weekly_top3',
      'streak_30',
      'mastered_10',
      'challenge_wins_5',
      'streak_7',
    ]);
  });

  it('lets admins give manual badges and take any away', () => {
    expect(badgesFor({ ...base, granted: ['campus_ambassador', 'nonsense'] })).toEqual(['campus_ambassador']);
    expect(badgesFor({ ...base, createdAt: new Date('2026-01-01'), revoked: ['founding_tester'] })).toEqual([]);
  });

  it('measures the longest run of consecutive days', () => {
    expect(longestRun(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-05', '2026-11-02'])).toBe(3);
    expect(longestRun([])).toBe(0);
  });
});
