import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { Model } from 'mongoose';
import { SALT_ROUNDS } from '../common/config/constants';
import { AccountStatus, StaffRole } from '../common/enum/staff-role.enum';
import { EmailService } from '../mailer/mailer.service';
import { User, UserDocument } from '../users/model/user.model';
import { AuditService } from './audit/audit.service';
import { AcceptInviteDto, TeamInviteDto } from './dto/admin.dto';
import type { Staff } from './staff.guard';

/** How long an invite link works. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IS_STAFF = { role: { $in: Object.values(StaffRole) } };

export const ROLE_LABEL: Record<StaffRole, string> = {
  [StaffRole.ADMIN]: 'Admin',
  [StaffRole.CREATOR]: 'Content Creator',
  [StaffRole.REVIEWER]: 'Medical Reviewer',
};

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fullName = (u: Pick<User, 'firstName' | 'lastName' | 'email'>) =>
  [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;

export type TeamMemberStatus = 'active' | 'invited' | 'suspended';

/** One row on the dashboard's Team page. */
export function teamMember(u: UserDocument) {
  const invited = !u.password && !!u.inviteTokenHash;
  const status: TeamMemberStatus =
    u.status === AccountStatus.SUSPENDED ? 'suspended' : invited ? 'invited' : 'active';
  return {
    id: String(u._id),
    name: fullName(u),
    email: u.email,
    role: u.role as StaffRole,
    status,
    invitedByName: u.invitedByName ?? null,
    joinedAt: (u.createdAt ?? new Date()).toISOString(),
    lastActiveAt: u.lastLogin ? u.lastLogin.toISOString() : null,
    inviteExpiresAt: invited && u.inviteExpiresAt ? u.inviteExpiresAt.toISOString() : null,
  };
}

/**
 * Staff accounts (admin → Team): invite by link, change roles, remove access.
 *
 * Invites create the account straight away with no password and a one-time
 * token (only its hash is stored). The invitee opens the link in the
 * dashboard, picks a password, and signs in as usual. The link is returned to
 * the admin and also emailed, so it still works while email delivery isn't set
 * up. `yarn staff` keeps working for scripted setups.
 */
@Injectable()
export class AdminTeamService {
  private readonly logger = new Logger(AdminTeamService.name);

  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditService,
    private readonly mail: EmailService,
    private readonly config: ConfigService,
  ) {}

  async list() {
    const members = await this.users.find(IS_STAFF).select('-password -refreshToken').sort({ createdAt: 1 }).exec();
    return members.map(teamMember);
  }

  async invite(staff: Staff, dto: TeamInviteDto, origin?: string) {
    const existing = await this.findByEmail(dto.email);
    if (existing && this.isStaff(existing)) {
      throw new ConflictException(`${dto.email} is already on the team.`);
    }

    // Someone who already uses the app: give their account staff access. They
    // sign in with the password they already have, so no link is needed.
    if (existing) {
      if (existing.status === AccountStatus.SUSPENDED) {
        throw new BadRequestException('That account is suspended. Reactivate it on the Students page first.');
      }
      existing.role = dto.role;
      existing.invitedByName = staff.name;
      await existing.save();
      await this.audit.log(
        staff,
        'staff',
        String(existing._id),
        'added',
        `Gave ${fullName(existing)} (${existing.email}) ${ROLE_LABEL[dto.role]} access`,
      );
      return { member: teamMember(existing), inviteUrl: null, invitePath: null, emailSent: false, existingAccount: true };
    }

    const token = randomBytes(32).toString('base64url');
    const created = await this.users.create({
      email: dto.email,
      firstName: dto.firstName,
      lastName: dto.lastName ?? '',
      username: dto.email.split('@')[0],
      role: dto.role,
      isVerified: true,
      invitedByName: staff.name,
      inviteTokenHash: hashToken(token),
      inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
    });
    await this.audit.log(
      staff,
      'staff',
      String(created._id),
      'invited',
      `Invited ${fullName(created)} (${created.email}) as ${ROLE_LABEL[dto.role]}`,
    );
    return { member: teamMember(created), ...(await this.deliver(staff, created, token, origin)), existingAccount: false };
  }

  /** A fresh link (the old one stops working) — for lost or expired invites. */
  async resendInvite(staff: Staff, id: string, origin?: string) {
    const member = await this.getMember(id);
    if (member.password) throw new BadRequestException(`${fullName(member)} has already set up their account.`);
    const token = randomBytes(32).toString('base64url');
    member.inviteTokenHash = hashToken(token);
    member.inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await member.save();
    await this.audit.log(staff, 'staff', id, 'reinvited', `Sent a new invite link to ${fullName(member)}`);
    return { member: teamMember(member), ...(await this.deliver(staff, member, token, origin)), existingAccount: false };
  }

  async setRole(staff: Staff, id: string, role: StaffRole) {
    if (id === staff.id) throw new BadRequestException("You can't change your own role. Ask another admin.");
    const member = await this.getMember(id);
    if (member.role === role) return teamMember(member);
    if (member.role === StaffRole.ADMIN) await this.assertAnotherAdmin(id);
    const from = ROLE_LABEL[member.role as StaffRole];
    member.role = role;
    await member.save();
    await this.audit.log(staff, 'staff', id, 'role_changed', `Changed ${fullName(member)} from ${from} to ${ROLE_LABEL[role]}`);
    return teamMember(member);
  }

  /**
   * Takes away dashboard access at once (StaffGuard reads the role on every
   * request). An invite nobody accepted is deleted; an account that was in
   * use keeps working in the app as a normal account.
   */
  async remove(staff: Staff, id: string) {
    if (id === staff.id) throw new BadRequestException("You can't remove yourself. Ask another admin.");
    const member = await this.getMember(id);
    if (member.role === StaffRole.ADMIN) await this.assertAnotherAdmin(id);
    const name = fullName(member);
    if (!member.password) {
      await member.deleteOne();
      await this.audit.log(staff, 'staff', id, 'invite_revoked', `Cancelled the invite for ${name} (${member.email})`);
    } else {
      member.role = undefined;
      member.refreshToken = null; // no more refreshes
      await member.save();
      await this.audit.log(staff, 'staff', id, 'removed', `Removed ${name} (${member.email}) from the team`);
    }
    return { id };
  }

  // ── Public: the invitee's side ──────────────────────────────────────────────

  /** What the "Accept invite" page shows before the password is set. */
  async lookupInvite(token: string) {
    const member = await this.findByToken(token);
    return {
      email: member.email,
      firstName: member.firstName ?? '',
      lastName: member.lastName ?? '',
      role: member.role as StaffRole,
      invitedByName: member.invitedByName ?? null,
    };
  }

  async acceptInvite(token: string, dto: AcceptInviteDto) {
    const member = await this.findByToken(token);
    member.set({
      firstName: dto.firstName,
      lastName: dto.lastName ?? '',
      password: await bcrypt.hash(dto.password, SALT_ROUNDS),
      inviteTokenHash: undefined,
      inviteExpiresAt: undefined,
      isVerified: true,
    });
    await member.save();
    return { email: member.email };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private isStaff(u: UserDocument) {
    return !!u.role && Object.values(StaffRole).includes(u.role);
  }

  private findByEmail(email: string) {
    return this.users.findOne({ email: new RegExp(`^${escapeRegex(email)}$`, 'i') }).exec();
  }

  private async getMember(id: string) {
    const member = await this.users.findOne({ _id: id, ...IS_STAFF }).exec();
    if (!member) throw new NotFoundException('That person is no longer on the team.');
    return member;
  }

  private async findByToken(token: string) {
    const member = token ? await this.users.findOne({ inviteTokenHash: hashToken(token), ...IS_STAFF }).exec() : null;
    if (!member || member.password) {
      throw new NotFoundException('This invite link is not valid. It may have been used already — try signing in.');
    }
    if (!member.inviteExpiresAt || member.inviteExpiresAt < new Date()) {
      throw new GoneException('This invite link has expired. Ask an EdMira admin to send a new one.');
    }
    return member;
  }

  /**
   * The team must always keep at least one admin who can sign in. With today's
   * rules (only admins manage the team, nobody changes themselves) the caller is
   * that admin; this guards against future permission changes.
   */
  private async assertAnotherAdmin(exceptId: string) {
    const others = await this.users
      .countDocuments({
        _id: { $ne: exceptId },
        role: StaffRole.ADMIN,
        status: { $ne: AccountStatus.SUSPENDED },
        password: { $exists: true, $ne: null },
      })
      .exec();
    if (others === 0) throw new BadRequestException('The team needs at least one admin. Make someone else an admin first.');
  }

  /**
   * Builds the link from ADMIN_URL (production) or the dashboard the admin is
   * using (the request's Origin), and emails it. Email failures don't fail the
   * invite — the admin can copy the link instead. `invitePath` lets the
   * dashboard build the link itself when neither is known.
   */
  private async deliver(staff: Staff, member: UserDocument, token: string, origin?: string) {
    const invitePath = `/accept-invite?token=${token}`;
    const base = (this.config.get<string>('ADMIN_URL') || origin || '').replace(/\/+$/, '');
    if (!base) return { inviteUrl: null, invitePath, emailSent: false };
    const inviteUrl = `${base}${invitePath}`;
    try {
      await this.mail.sendStaffInvite(
        member.email,
        member.firstName || member.email,
        staff.name,
        ROLE_LABEL[member.role as StaffRole],
        inviteUrl,
      );
      return { inviteUrl, invitePath, emailSent: true };
    } catch (error) {
      this.logger.warn(`Invite email to ${member.email} failed: ${(error as Error).message}`);
      return { inviteUrl, invitePath, emailSent: false };
    }
  }
}
