import { Department } from '../common/enum/department.enum';
import { Institution } from '../common/enum/institution.enum';
import { Level, LevelType } from '../common/enum/level.enum';
import { ACADEMIC_OPTIONS } from './academic-options';

// Anything offered in the app's pickers must pass StudentProfileDto validation.
describe('ACADEMIC_OPTIONS', () => {
  const values = <T extends object>(e: T) => Object.values(e) as string[];

  it('only offers valid institutions', () => {
    ACADEMIC_OPTIONS.institutions.forEach(i => expect(values(Institution)).toContain(i.name));
  });

  it('only offers valid departments', () => {
    ACADEMIC_OPTIONS.departments.forEach(d => expect(values(Department)).toContain(d));
  });

  it('only offers valid programmes and levels', () => {
    ACADEMIC_OPTIONS.programmes.forEach(p => {
      expect(values(LevelType)).toContain(p.type);
      p.levels.forEach(l => expect(values(Level)).toContain(l));
    });
  });
});

describe('school short names', () => {
  it('has a short name for every school', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SCHOOL_SHORT_NAMES } = require('./school-short-names');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Institution } = require('../common/enum/institution.enum');
    for (const school of Object.values(Institution)) expect(SCHOOL_SHORT_NAMES[school as string]).toBeTruthy();
  });
});
