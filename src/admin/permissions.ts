import { StaffRole } from '../common/enum/staff-role.enum';

/**
 * Who can do what — identical to EdMira-Admin/src/data/permissions.ts.
 * The dashboard only hides buttons; THIS is the enforcement.
 */
export const PERMISSIONS = {
  /** Create/edit courses, topics and questions (as drafts). */
  editContent: [StaffRole.ADMIN, StaffRole.CREATOR],
  /** Send a draft topic/question to the review queue. */
  submitForReview: [StaffRole.ADMIN, StaffRole.CREATOR],
  /** Approve, reject or request changes. */
  review: [StaffRole.ADMIN, StaffRole.REVIEWER],
  /** Publish/archive courses and archive/restore any content. */
  manageLifecycle: [StaffRole.ADMIN],
  viewReports: [StaffRole.ADMIN, StaffRole.CREATOR, StaffRole.REVIEWER],
  handleReports: [StaffRole.ADMIN, StaffRole.REVIEWER],
  viewFeedback: [StaffRole.ADMIN],
  viewStudents: [StaffRole.ADMIN],
  viewAudit: [StaffRole.ADMIN],
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const can = (role: StaffRole | undefined, permission: Permission) =>
  !!role && (PERMISSIONS[permission] as readonly StaffRole[]).includes(role);
