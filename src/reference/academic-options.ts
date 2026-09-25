import { Department } from '../common/enum/department.enum';
import { Institution } from '../common/enum/institution.enum';
import { Level, LevelType } from '../common/enum/level.enum';

/**
 * The option lists shown in the mobile app's sign-up and edit-profile pickers.
 *
 * Every value MUST exist in the matching enum, because StudentProfileDto
 * validates against the enums (reference.spec.ts checks this). To offer a
 * new option: add it to the enum, then list it here. The app picks it up
 * from GET /api/v1/reference/academic-options — no app release needed.
 */
export type InstitutionCategory = 'federal' | 'state' | 'private';

export const ACADEMIC_OPTIONS = {
  institutions: [
    ...[
      Institution.AHMADU_BELLO_UNIVERSITY,
      Institution.UNIVERSITY_OF_ABUJA,
      Institution.UNIVERSITY_OF_BENIN,
      Institution.UNIVERSITY_OF_CALABAR,
      Institution.UNIVERSITY_OF_IBADAN,
      Institution.UNIVERSITY_OF_ILORIN,
      Institution.UNIVERSITY_OF_JOS,
      Institution.UNIVERSITY_OF_LAGOS,
      Institution.UNIVERSITY_OF_NIGERIA_NSUKKA,
      Institution.UNIVERSITY_OF_MAIDUGURI,
      Institution.UNIVERSITY_OF_PORT_HARCOURT,
      Institution.USMANU_DANFODIYO_UNIVERSITY,
      Institution.NNAMDI_AZIKIWE_UNIVERSITY,
      Institution.OBAFEMI_AWOLOWO_UNIVERSITY,
      Institution.UNIVERSITY_OF_UYO,
    ].map(name => ({ name, category: 'federal' as InstitutionCategory })),
    ...[
      Institution.LAGOS_STATE_UNIVERSITY,
      Institution.ABIA_STATE_UNIVERSITY,
      Institution.AMBROSE_ALLI_UNIVERSITY,
      Institution.BENUE_STATE_UNIVERSITY,
    ].map(name => ({ name, category: 'state' as InstitutionCategory })),
  ],
  faculties: [
    'Faculty of Clinical Sciences',
    'Faculty of Basic Medical Sciences',
    'Faculty of Dental Sciences',
    'School of Nursing Science',
    'School of Allied Health Sciences',
    'Institute of Public Health',
    'Faculty of Pharmacy',
    'Faculty of Biomedical Sciences',
    'Others',
  ],
  departments: [
    Department.MBBS,
    Department.BDS,
    Department.ANATOMY,
    Department.BIOCHEMISTRY,
    Department.PHYSIOLOGY,
    Department.PHARMACOLOGY,
    Department.PHARMACY,
    Department.RADIOGRAPHY,
    Department.NURSING_SCIENCE,
    Department.PHYSIOTHERAPY,
    Department.PUBLIC_HEALTH,
    Department.BIOMEDICAL_ENGINEERING,
    Department.SCHOOL_OF_NURSING,
    Department.MEDICAL_LABORATORY_SCIENCE,
    Department.COMMUNITY_MEDICINE,
    Department.HAEMATOLOGY,
    Department.OTHERS,
  ],
  programmes: [
    {
      type: LevelType.UNDERGRADUATE,
      levels: [
        Level.LEVEL_100,
        Level.LEVEL_200,
        Level.LEVEL_300,
        Level.LEVEL_400,
        Level.LEVEL_500,
        Level.LEVEL_600,
      ],
    },
    {
      type: LevelType.POSTGRADUATE,
      levels: [Level.MSC, Level.MPHIL, Level.PHD, Level.HIGHER_DOCTORATE],
    },
  ],
};
