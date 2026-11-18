/**
 * ─── Find classmates & connections: the rules in one place ──────────────────
 *
 * Safety first: everything here is enforced on the server, and anything a
 * student can't do gets a neutral answer that never reveals whether an
 * account exists, blocked you or declined you.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const SEARCH = {
  minChars: 3,
  maxResults: 10,
  perMinute: 30,
  perDay: 300,
} as const;

export const REQUESTS = {
  perDay: 20,
  /** Accounts younger than 24 hours. */
  perDayNewAccount: 5,
  newAccountMs: DAY_MS,
  maxPendingOutgoing: 50,
  expireAfterMs: 14 * DAY_MS,
  /** After a decline, the same sender can't re-request that person for this long. */
  declineCooldownMs: 30 * DAY_MS,
} as const;

/** Auto-flags for admin review (never an automatic ban). */
export const FLAGS = {
  distinctReporters: 5,
  declineShare: 0.7,
  declineMinRequests: 20,
  rateLimitHits: 3,
  rateLimitWindowMs: DAY_MS,
} as const;

/** Invite links (edmira.org/join/<username>) and the "Invited by" box at sign-up. */
export const REFERRALS = {
  /** More new sign-ups than this in 24 h for one inviter aren't credited (and are logged). */
  perInviterPerDay: 20,
  /**
   * Hold the inviter's rewards for admin review when, within 24 h, this many
   * of their sign-ups came from one app install (a phone) or one network.
   * Networks are shared on campus Wi-Fi, so that bar is higher.
   */
  holdSameInstall: 2,
  holdSameNetwork: 5,
} as const;

/** Challenge a friend. */
export const CHALLENGES = {
  maxQuestions: 10,
  minQuestions: 3,
  expireAfterMs: 48 * 60 * 60 * 1000,
  perDay: 10,
  maxOpen: 20,
} as const;

/** Preset notes — no free text in requests (removes the main harassment channel). */
export const REQUEST_NOTES = ['classmates', 'study_together', 'quiz_challenge'] as const;
export type RequestNote = (typeof REQUEST_NOTES)[number];

export const REPORT_CATEGORIES = ['harassment', 'spam', 'impersonation', 'inappropriate_username', 'inappropriate_photo', 'underage', 'other'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const DEFAULT_PRIVACY = {
  showOnLeaderboard: true,
  findability: 'everyone',
  requestsFrom: 'everyone',
  shareProgress: true,
  shareScores: false,
  muteRequestNotifications: false,
  muteLeaderboardNotifications: false,
  publicProfile: false,
  showRealName: false,
} as const;

/** Study groups. */
export const GROUPS = {
  maxMembers: 30,
  maxOwned: 5,
  invitesPerDay: 20,
  nameMin: 3,
  nameMax: 40,
  /** Recent activity window shown in a group. */
  activityDays: 7,
} as const;

// ── The connection state machine ─────────────────────────────────────────────
//
//   pending ──accept (recipient)──► accepted ──remove (either)──► removed
//      ├──decline (recipient)──► declined
//      ├──cancel (requester)───► cancelled
//      ├──(14 days)────────────► expired
//      └──block (either)───────► blocked      accepted ──block──► blocked

export const CONNECTION_STATUSES = ['pending', 'accepted', 'declined', 'cancelled', 'expired', 'removed', 'blocked'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];
export type ConnectionAction = 'accept' | 'decline' | 'cancel' | 'remove';
export type Role = 'requester' | 'recipient';

const RULES: Record<ConnectionAction, { from: ConnectionStatus; by: Role[]; to: ConnectionStatus }> = {
  accept: { from: 'pending', by: ['recipient'], to: 'accepted' },
  decline: { from: 'pending', by: ['recipient'], to: 'declined' },
  cancel: { from: 'pending', by: ['requester'], to: 'cancelled' },
  remove: { from: 'accepted', by: ['requester', 'recipient'], to: 'removed' },
};

/** The new status, or null when `role` may not take `action` on a connection in `status`. */
export function transition(status: ConnectionStatus, action: ConnectionAction, role: Role): ConnectionStatus | null {
  const rule = RULES[action];
  return rule && rule.from === status && rule.by.includes(role) ? rule.to : null;
}

/** Pending and accepted connections are "live": at most one per pair. */
export const isLive = (status: ConnectionStatus) => status === 'pending' || status === 'accepted';

/** Same key for (a, b) and (b, a). */
export const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);
