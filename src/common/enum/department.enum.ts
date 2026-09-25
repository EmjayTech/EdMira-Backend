export enum Department {
  // Core Medicine
  MEDICINE_AND_SURGERY = 'Medicine and Surgery',
  CLINICAL_MEDICINE = 'Clinical Medicine',
  BASIC_MEDICAL_SCIENCES = 'Basic Medical Sciences',

  // Allied Health
  NURSING = 'Nursing',
  PHARMACY = 'Pharmacy',
  MEDICAL_LABORATORY_SCIENCE = 'Medical Laboratory Science',
  RADIOGRAPHY = 'Radiography',
  PHYSIOTHERAPY = 'Physiotherapy',
  OPTOMETRY = 'Optometry',
  PUBLIC_HEALTH = 'Public Health',
  HEALTH_INFORMATION_MANAGEMENT = 'Health Information Management',

  // Dental
  DENTAL_SURGERY = 'Dental Surgery',
  DENTISTRY = 'Dentistry',
  DENTAL_TECHNOLOGY = 'Dental Technology',
  DENTAL_THERAPY = 'Dental Therapy',

  // Basic Medical Sciences
  ANATOMY = 'Anatomy',
  BIOCHEMISTRY = 'Biochemistry',
  PHYSIOLOGY = 'Physiology',
  MICROBIOLOGY = 'Microbiology',
  IMMUNOLOGY = 'Immunology',
  PHARMACOLOGY = 'Pharmacology',
  MEDICAL_GENETICS = 'Medical Genetics',

  // Others
  EPIDEMIOLOGY = 'Epidemiology',
  ENVIRONMENTAL_HEALTH = 'Environmental Health',

  // Options offered by the mobile app's sign-up picker
  // (see src/reference/academic-options.ts). Values above are kept for
  // existing accounts.
  MBBS = 'Medicine & Surgery (MBBS)',
  BDS = 'Dentistry (BDS)',
  NURSING_SCIENCE = 'Nursing Science',
  BIOMEDICAL_ENGINEERING = 'Biomedical engineering',
  SCHOOL_OF_NURSING = 'School/College of Nursing',
  COMMUNITY_MEDICINE = 'Community Medicine',
  HAEMATOLOGY = 'Haematology',
  OTHERS = 'Others',
}