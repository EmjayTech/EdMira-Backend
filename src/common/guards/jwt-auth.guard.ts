import { ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/** Cache flag that revokes a suspended user's live access tokens. */
export const suspendedKey = (userId: string) => `suspended_${userId}`;

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private reflector: Reflector,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Allow access without JWT for @Public() routes
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // Run Passport JWT validation first
    const isValid = await (super.canActivate(context) as Promise<boolean>);
    if (!isValid) return false;

    // Check if the access token has been blacklisted (logout revocation)
    const request = context.switchToHttp().getRequest();
    const token = request.get('Authorization')?.replace(/^Bearer\s+/i, '').trim();
    if (token) {
      const isBlacklisted = await this.cacheManager.get(`bl_${token}`);
      if (isBlacklisted) {
        throw new UnauthorizedException('Token has been revoked');
      }
    }

    // Set when an admin suspends the account (lasts as long as an access token).
    const userId = request.user?.userId;
    if (userId && (await this.cacheManager.get(suspendedKey(userId)))) {
      throw new UnauthorizedException('This account has been suspended.');
    }

    return true;
  }
}