import {
  isOffensiveUsername,
  isReservedUsername,
  normalizeUsername,
  usernameProblem,
  usernameStem,
} from './username-policy';

describe('username rules', () => {
  it('accepts 3–20 letters, numbers, _ and . (not at the ends)', () => {
    for (const ok of ['ada', 'Ada_Obi', 'ada.obi', '_ada_', 'a1b', 'x'.repeat(20), 'mbbs.2026']) {
      expect(usernameProblem(ok)).toBeNull();
    }
    for (const bad of ['ad', 'x'.repeat(21), 'ada obi', 'ada@uni', 'ada-obi', '.ada', 'ada.', 'adá', '']) {
      expect(usernameProblem(bad)).toBe('invalid');
    }
  });

  it('keeps reserved names (and anything starting with edmira) for EdMira', () => {
    for (const name of ['admin', 'ADMIN', 'Support', 'mod', 'null', 'edmira', 'edmira_help', 'EdMira.NG', '4dm1n', 'edm1ra']) {
      expect(isReservedUsername(name)).toBe(true);
    }
    expect(isReservedUsername('administrators_club')).toBe(false);
    expect(usernameProblem('admin')).toBe('reserved');
    expect(usernameProblem('admin', { allowReserved: true })).toBeNull();
  });

  it('blocks offensive names, including look-alike spellings, without catching ordinary words', () => {
    for (const bad of ['fuckboy', 'sh1t_head', 'b1tch', 'big.ass', 'ass', 'a.s.s', 'rapist99']) {
      expect(isOffensiveUsername(bad)).toBe(true);
    }
    for (const fine of ['classmate', 'shell', 'assessment', 'sussex', 'cockpit', 'skillful', 'hellen']) {
      expect(isOffensiveUsername(fine)).toBe(false);
    }
  });

  it('compares ignoring case and spaces at the ends', () => {
    expect(normalizeUsername('  Ada_OBI ')).toBe('ada_obi');
  });

  it('builds a valid automatic username from any text', () => {
    expect(usernameStem('Ada Obi!')).toBe('adaobi');
    expect(usernameStem('.x.')).toBe('xstaff');
    expect(usernameProblem(usernameStem('a-very-long.staff.email.name'), { allowReserved: true })).toBeNull();
  });
});
