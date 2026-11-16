import { Institution } from '../common/enum/institution.enum';

/**
 * Short school names shown publicly (leaderboards, share cards) — what
 * students call their school. Add one whenever an Institution is added
 * (reference.spec.ts checks every school has one).
 */
export const SCHOOL_SHORT_NAMES: Record<Institution, string> = {
  [Institution.AHMADU_BELLO_UNIVERSITY]: 'ABU',
  [Institution.UNIVERSITY_OF_ABUJA]: 'UniAbuja',
  [Institution.UNIVERSITY_OF_BENIN]: 'UNIBEN',
  [Institution.UNIVERSITY_OF_CALABAR]: 'UNICAL',
  [Institution.UNIVERSITY_OF_IBADAN]: 'UI',
  [Institution.UNIVERSITY_OF_ILORIN]: 'UNILORIN',
  [Institution.UNIVERSITY_OF_JOS]: 'UNIJOS',
  [Institution.UNIVERSITY_OF_LAGOS]: 'UNILAG',
  [Institution.UNIVERSITY_OF_NIGERIA_NSUKKA]: 'UNN',
  [Institution.UNIVERSITY_OF_MAIDUGURI]: 'UNIMAID',
  [Institution.UNIVERSITY_OF_PORT_HARCOURT]: 'UNIPORT',
  [Institution.USMANU_DANFODIYO_UNIVERSITY]: 'UDUS',
  [Institution.NNAMDI_AZIKIWE_UNIVERSITY]: 'UNIZIK',
  [Institution.LAGOS_STATE_UNIVERSITY]: 'LASU',
  [Institution.OBAFEMI_AWOLOWO_UNIVERSITY]: 'OAU',
  [Institution.UNIVERSITY_OF_UYO]: 'UNIUYO',
  [Institution.ABIA_STATE_UNIVERSITY]: 'ABSU',
  [Institution.AMBROSE_ALLI_UNIVERSITY]: 'AAU',
  [Institution.BENUE_STATE_UNIVERSITY]: 'BSU',
};

/** Short name for any stored school value ('' if unknown). */
export const schoolShortName = (institution?: string | null): string =>
  (institution && SCHOOL_SHORT_NAMES[institution as Institution]) || '';
