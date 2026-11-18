import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { InjectModel } from '@nestjs/mongoose';
import { Cache } from 'cache-manager';
import { FilterQuery, Model, Types } from 'mongoose';
import { AccountStatus } from '../common/enum/staff-role.enum';
import { suspendedKey } from '../common/guards/jwt-auth.guard';
import { User, UserDocument } from '../users/model/user.model';
import { UsernameService } from '../users/username.service';
import { AvatarService } from '../avatars/avatar.service';
import { avatarView } from '../avatars/avatar-view';
import { NotificationsService } from './notifications.service';
import { SafetyService } from './safety.service';
import { ReferralsService } from './referrals.service';
import { SecurityEvent, SecurityEventDocument } from './schemas/security-event.schema';
import { ModerationAction, UserReport, UserReportDocument } from './schemas/user-report.schema';

/** Long enough for any live access token (15 min) to run out; refresh is refused after that. */
const TOKEN_CUTOFF_MS = 20 * 60 * 1000;

type Staff = { id: string; name: string };
type Named = { _id: Types.ObjectId; avatar?: User['avatar']; username?: string; firstName?: string; lastName?: string; email?: string; status?: string; warnings?: number; flag?: { at: Date; reasons: string[] } };

/** Admin → Moderation: the report queue, actions, flags and the security log. */
@Injectable()
export class ModerationService {
  constructor(
    @InjectModel(UserReport.name) private readonly reports: Model<UserReportDocument>,
    @InjectModel(SecurityEvent.name) private readonly events: Model<SecurityEventDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly usernames: UsernameService,
    private readonly notifications: NotificationsService,
    private readonly safety: SafetyService,
    private readonly referrals: ReferralsService,
    private readonly avatars: AvatarService,
  ) {}

  private async usersById(ids: unknown[]) {
    const rows = await this.users
      .find({ _id: { $in: ids } })
      .select('username firstName lastName email status warnings flag suspendedUntil avatar')
      .lean<Named[]>()
      .exec();
    return new Map(rows.map(u => [String(u._id), u]));
  }

  private person(u?: Named) {
    return u
      ? {
          id: String(u._id),
          username: u.username ?? '',
          name: [u.firstName, u.lastName].filter(Boolean).join(' '),
          email: u.email ?? '',
          status: u.status ?? 'active',
          warnings: u.warnings ?? 0,
          flag: u.flag ? { at: u.flag.at.toISOString(), reasons: u.flag.reasons } : null,
          /** Current profile picture, so moderators can see what was reported. */
          avatar: avatarView(u),
        }
      : null;
  }

  async listReports(status: 'open' | 'resolved' = 'open') {
    const rows = await this.reports.find({ status }).sort({ createdAt: -1 }).limit(200).lean().exec();
    const people = await this.usersById(rows.flatMap(r => [r.reporterId, r.reportedId]));
    const openAgainst = await this.reports.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { status: 'open' } },
      { $group: { _id: '$reportedId', count: { $sum: 1 } } },
    ]);
    const openCount = new Map(openAgainst.map(o => [String(o._id), o.count]));
    return rows.map(r => ({
      id: String(r._id),
      category: r.category,
      note: r.note ?? '',
      evidence: r.evidence ?? {},
      createdAt: r.createdAt?.toISOString(),
      status: r.status,
      action: r.action ?? null,
      actionNote: r.actionNote ?? '',
      handledByName: r.handledByName ?? '',
      handledAt: r.handledAt?.toISOString() ?? null,
      reporter: this.person(people.get(String(r.reporterId))),
      reported: this.person(people.get(String(r.reportedId))),
      openReportsAgainst: openCount.get(String(r.reportedId)) ?? 0,
    }));
  }

  /**
   * Act on a report: dismiss · warn · rename (new username) · remove_photo · suspend (days)
   * · ban. Resolves the report and returns a one-line summary for the audit log.
   */
  async act(staff: Staff, reportId: string, input: { action: ModerationAction; days?: number; username?: string; note?: string }) {
    const report = await this.reports.findById(reportId).exec();
    if (!report) throw new NotFoundException('That report no longer exists.');
    if (report.status === 'resolved') throw new BadRequestException('This report has already been handled.');
    const target = await this.users.findById(report.reportedId).exec();
    if (!target) throw new NotFoundException('That student no longer exists.');
    const before = target.username;

    let summary: string;
    switch (input.action) {
      case 'dismiss':
        summary = `Dismissed a ${report.category} report about @${before}`;
        break;
      case 'warn':
        target.warnings = (target.warnings ?? 0) + 1;
        await target.save();
        await this.notifications.notify(target._id, 'account_warning');
        summary = `Warned @${before} (${target.warnings} warning${target.warnings === 1 ? '' : 's'})`;
        break;
      case 'rename': {
        if (!input.username?.trim()) throw new BadRequestException('Enter the new username.');
        const updated = await this.usernames.change(target, input.username, { staffName: staff.name });
        summary = `Changed username @${before} → @${updated?.username}`;
        break;
      }
      case 'remove_photo': {
        // Back to initials; presets are ours, so only an uploaded photo can be removed.
        const removed = await this.avatars.removeForModeration(String(target._id));
        if (!removed) throw new BadRequestException('This student has no uploaded photo now.');
        await this.notifications.notify(target._id, 'avatar_removed');
        summary = `Removed the profile photo of @${before}`;
        break;
      }
      case 'suspend': {
        const days = Math.round(input.days ?? 0);
        if (!(days >= 1 && days <= 365)) throw new BadRequestException('Suspend for 1–365 days.');
        target.set({ status: AccountStatus.SUSPENDED, suspendedUntil: new Date(Date.now() + days * 86_400_000), refreshToken: null });
        await target.save();
        await this.cache.set(suspendedKey(String(target._id)), '1', TOKEN_CUTOFF_MS);
        summary = `Suspended @${before} for ${days} day${days === 1 ? '' : 's'}`;
        break;
      }
      case 'ban':
        target.set({ status: AccountStatus.BANNED, refreshToken: null, suspendedUntil: undefined });
        await target.save();
        await this.cache.set(suspendedKey(String(target._id)), '1', TOKEN_CUTOFF_MS);
        summary = `Banned @${before}`;
        // A banned account never earns its inviter a referral reward.
        await this.referrals.reverse(target._id as never, 'Invited account banned', staff.name).catch(() => undefined);
        break;
    }
    report.set({ status: 'resolved', action: input.action, actionNote: input.note?.trim() || undefined, handledByName: staff.name, handledAt: new Date() });
    await report.save();
    await this.safety.log('moderation_action', staff.id, target._id, { action: input.action, reportId, days: input.days });
    return { summary, studentId: String(target._id) };
  }

  /** Auto-flagged accounts waiting for review. */
  async flagged() {
    const rows = await this.users
      .find({ flag: { $exists: true } })
      .select('username firstName lastName email status warnings flag')
      .sort({ 'flag.at': -1 })
      .lean<Named[]>()
      .exec();
    return rows.map(u => this.person(u));
  }

  /** Reviewed: lift the flag and the pause on connection requests. */
  async clearFlag(userId: string) {
    const user = await this.users.findById(userId).exec();
    if (!user) throw new NotFoundException('That student no longer exists.');
    user.set({ flag: undefined, requestsPausedUntil: undefined });
    await user.save();
    return { username: user.username };
  }

  /** The security log, newest first; `username` matches who did it or who it was done to. */
  async securityEvents(filter: { type?: string; username?: string }) {
    const query: FilterQuery<SecurityEvent> = {};
    if (filter.type) query.type = filter.type;
    if (filter.username) {
      const user = await this.users.findOne({ usernameLower: filter.username.trim().toLowerCase().replace(/^@/, '') }).select('_id').lean().exec();
      if (!user) return [];
      query.$or = [{ actorId: user._id }, { targetId: user._id }];
    }
    const rows = await this.events.find(query).sort({ createdAt: -1 }).limit(200).lean().exec();
    const people = await this.usersById(rows.flatMap(r => [r.actorId, r.targetId]).filter(Boolean));
    const name = (id?: Types.ObjectId) => (id ? people.get(String(id))?.username ?? '(deleted)' : null);
    return rows.map(r => ({
      id: String(r._id),
      type: r.type,
      actor: name(r.actorId),
      target: name(r.targetId),
      meta: r.meta ?? {},
      createdAt: r.createdAt?.toISOString(),
    }));
  }
}
