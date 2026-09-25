import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccountStatus, StaffRole } from '../common/enum/staff-role.enum';
import { UsersRepository } from '../users/user.repository';
import { Permission, can } from './permissions';

export interface Staff {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
}

const PERMISSION_KEY = 'adminPermission';

/** Restrict an admin route to roles holding `permission` (permissions.ts). */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);

/** The staff member making the request (set by StaffGuard). */
export const CurrentStaff = createParamDecorator(
  (_: unknown, context: ExecutionContext): Staff => context.switchToHttp().getRequest().staff,
);

/**
 * Admin routes: the JWT must belong to an active staff account. The role is
 * read from the database on every request, so removing someone's role or
 * suspending them takes effect immediately — not when their token expires.
 */
@Injectable()
export class StaffGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly users: UsersRepository,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const userId = request.user?.userId;
    if (!userId) throw new UnauthorizedException();

    const user = await this.users.findById(userId);
    if (!user || user.status === AccountStatus.SUSPENDED) throw new UnauthorizedException();
    if (!user.role || !Object.values(StaffRole).includes(user.role)) {
      throw new ForbiddenException('This account does not have staff access.');
    }

    const permission = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (permission && !can(user.role, permission)) {
      throw new ForbiddenException("You don't have permission to do that.");
    }

    request.staff = {
      id: String(user._id),
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
      email: user.email,
      role: user.role,
    } satisfies Staff;
    return true;
  }
}
