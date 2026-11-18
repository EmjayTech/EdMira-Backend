import { candidateGroups, courseFitsGroup, parseGroup, pickQuestion } from './qotd-groups';

describe('Question of the Day groups', () => {
  it('tries level + department, then level, then everyone', () => {
    expect(candidateGroups('100 Level', 'Physiology').map(g => g.key)).toEqual(['ld:100 Level|Physiology', 'l:100 Level', 'all']);
    expect(candidateGroups(undefined, 'Physiology').map(g => g.key)).toEqual(['all']);
  });

  it('only accepts real levels and departments from admins', () => {
    expect(parseGroup('all')).toEqual({ key: 'all' });
    expect(parseGroup('l:100 Level')).toMatchObject({ level: '100 Level' });
    expect(parseGroup('l:999 Level')).toBeNull();
    expect(parseGroup('nonsense')).toBeNull();
  });

  it('matches courses by audience, ignoring school-only rules', () => {
    const g = { key: 'ld:100 Level|Physiology', level: '100 Level', department: 'Physiology' };
    expect(courseFitsGroup([], g)).toBe(true);
    expect(courseFitsGroup([{ level: '100 Level' }], g)).toBe(true);
    expect(courseFitsGroup([{ level: '100 Level', department: 'Physiology' }], g)).toBe(true);
    expect(courseFitsGroup([{ level: '100 Level', department: 'Nursing Science' }], g)).toBe(false);
    expect(courseFitsGroup([{ level: '100 Level', institution: 'University of Lagos' }], g)).toBe(false);
    expect(courseFitsGroup([{ level: '200 Level' }], g)).toBe(false);
  });

  it('picks the same question for the same day and group, every time', () => {
    const pool = Array.from({ length: 50 }, (_, i) => `q${i}`);
    const a = pickQuestion(pool, new Set(), '2026-11-20', 'all');
    expect(pickQuestion([...pool], new Set(), '2026-11-20', 'all')).toBe(a);
    const days = new Set(Array.from({ length: 10 }, (_, i) => pickQuestion(pool, new Set(), `2026-11-${10 + i}`, 'all')));
    expect(days.size).toBeGreaterThan(5);
  });

  it('avoids recent questions while it can', () => {
    const pool = ['a', 'b', 'c'];
    expect(pickQuestion(pool, new Set(['a', 'b']), '2026-11-20', 'all')).toBe('c');
    expect(pool).toContain(pickQuestion(pool, new Set(pool), '2026-11-20', 'all'));
    expect(pickQuestion([], new Set(), '2026-11-20', 'all')).toBeNull();
  });
});
