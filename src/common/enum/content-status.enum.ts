/**
 * Lifecycle of courses, topics, questions and news (matches the admin
 * dashboard contract). Students only ever see `published`.
 */
export enum ContentStatus {
  DRAFT = 'draft',
  IN_REVIEW = 'in_review',
  PUBLISHED = 'published',
  ARCHIVED = 'archived',
}
