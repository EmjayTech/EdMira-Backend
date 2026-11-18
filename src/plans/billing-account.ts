import { createHmac } from 'crypto';

/**
 * The id the app sends with every store purchase (Play's obfuscatedAccountId,
 * max 64 chars). Not reversible to the user id; the server checks a purchase
 * carries the buyer's own id before granting Pro, so a purchase token can't be
 * replayed on another account.
 */
export const billingAccountId = (userId: string) =>
  createHmac('sha256', process.env.BILLING_ACCOUNT_SECRET || process.env.JWT_SECRET || 'edmira-billing').update(`account:${userId}`).digest('hex').slice(0, 40);
