/** Staff roles for the admin dashboard. Students have no role. */
export enum StaffRole {
  ADMIN = 'admin',
  CREATOR = 'creator',
  REVIEWER = 'reviewer',
}

export enum AccountStatus {
  ACTIVE = 'active',
  /** Can't log in — until `suspendedUntil` if set, otherwise until reactivated. */
  SUSPENDED = 'suspended',
  /** Closed by moderation; can't log in. */
  BANNED = 'banned',
}
