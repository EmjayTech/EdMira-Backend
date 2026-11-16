import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

/** 5 failed logins for the same email/username from the same IP → wait 15 minutes. */
export const MAX_FAILED_LOGINS = 5;
export const LOGIN_LOCK_WINDOW_MS = 15 * 60 * 1000;

type Failures = { count: number; firstAt: number };

/**
 * Slows down password guessing. Counted per identifier + IP, whether or not
 * the account exists, so a lockout reveals nothing. Stored in the cache
 * (Redis when configured, otherwise this server's memory — fine for one
 * instance; with several instances configure Redis).
 */
@Injectable()
export class LoginAttemptsService {
  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  private key(identifier: string, ip: string) {
    return `login_fail:${identifier.trim().toLowerCase()}:${ip}`;
  }

  async assertNotLocked(identifier: string, ip: string) {
    const failures = await this.cache.get<Failures>(this.key(identifier, ip));
    if (!failures || failures.count < MAX_FAILED_LOGINS) return;
    const retryAfterMs = failures.firstAt + LOGIN_LOCK_WINDOW_MS - Date.now();
    if (retryAfterMs <= 0) return;
    const minutes = Math.ceil(retryAfterMs / 60_000);
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: 'LOGIN_LOCKED',
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        message: `Too many login attempts. Please wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  async recordFailure(identifier: string, ip: string) {
    const key = this.key(identifier, ip);
    const now = Date.now();
    const previous = await this.cache.get<Failures>(key);
    const fresh = !previous || now - previous.firstAt >= LOGIN_LOCK_WINDOW_MS;
    const next: Failures = fresh ? { count: 1, firstAt: now } : { count: previous.count + 1, firstAt: previous.firstAt };
    await this.cache.set(key, next, Math.max(next.firstAt + LOGIN_LOCK_WINDOW_MS - now, 1000));
  }

  async clear(identifier: string, ip: string) {
    await this.cache.del(this.key(identifier, ip));
  }
}
