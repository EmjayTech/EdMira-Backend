import { createHmac } from 'crypto';

/**
 * A keyed hash (never the raw value): lets us see that several accounts share
 * a network or an app install without keeping the address or id itself.
 */
export const keyedHash = (value: string) =>
  createHmac('sha256', process.env.IP_HASH_SECRET || process.env.JWT_SECRET || 'edmira').update(value).digest('hex').slice(0, 24);
