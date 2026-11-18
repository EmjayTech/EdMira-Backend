import { computeStreak } from './streak';

// 2026-11-16 is a Monday.
describe('streaks (Lagos calendar days)', () => {
  it('counts consecutive study days ending today', () => {
    expect(computeStreak(['2026-11-18', '2026-11-19', '2026-11-20'], '2026-11-20')).toMatchObject({ current: 3, longest: 3 });
  });

  it("still shows yesterday's streak in the morning before studying", () => {
    expect(computeStreak(['2026-11-18', '2026-11-19'], '2026-11-20')).toMatchObject({ current: 2, savedByFreeze: false });
  });

  it('is 0 with no study days', () => {
    expect(computeStreak([], '2026-11-20')).toMatchObject({ current: 0, longest: 0, freezeAvailable: true });
  });

  it('uses the weekly freeze to cover one missed day', () => {
    const s = computeStreak(['2026-11-16', '2026-11-17', '2026-11-19'], '2026-11-19');
    expect(s).toMatchObject({ current: 3, frozenDays: ['2026-11-18'], freezeAvailable: false });
  });

  it('saves the streak this morning when yesterday was missed (and says so)', () => {
    const s = computeStreak(['2026-11-17', '2026-11-18'], '2026-11-20');
    expect(s).toMatchObject({ current: 2, savedByFreeze: true, frozenDays: ['2026-11-19'], freezeAvailable: false });
  });

  it('breaks after two missed days in a row', () => {
    expect(computeStreak(['2026-11-16', '2026-11-17'], '2026-11-20').current).toBe(0);
    expect(computeStreak(['2026-11-16', '2026-11-19'], '2026-11-19').current).toBe(1);
  });

  it('allows only one freeze per calendar week', () => {
    // Missed Tue 17 and Thu 19 (same week): the second gap breaks it.
    expect(computeStreak(['2026-11-16', '2026-11-18', '2026-11-20'], '2026-11-20').current).toBe(1);
    // Missed Sat 21 and Tue 24 (different weeks): both covered.
    const s = computeStreak(['2026-11-20', '2026-11-22', '2026-11-23', '2026-11-25'], '2026-11-25');
    expect(s).toMatchObject({ current: 4, frozenDays: ['2026-11-21', '2026-11-24'] });
  });

  it('has a fresh freeze again on Monday', () => {
    const s = computeStreak(['2026-11-19', '2026-11-21', '2026-11-22', '2026-11-23'], '2026-11-23');
    expect(s).toMatchObject({ current: 4, freezeAvailable: true });
  });

  it('keeps the longest streak after a break', () => {
    const s = computeStreak(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-19'], '2026-11-19');
    expect(s).toMatchObject({ current: 1, longest: 4 });
  });

  it('ignores duplicates and days after today', () => {
    expect(computeStreak(['2026-11-19', '2026-11-19', '2026-11-21'], '2026-11-19').current).toBe(1);
  });
});
