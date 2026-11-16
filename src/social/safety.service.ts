import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User, UserDocument } from '../users/model/user.model';
import { Connection, ConnectionDocument } from './schemas/connection.schema';
import { SecurityEvent, SecurityEventDocument, SecurityEventType } from './schemas/security-event.schema';
import { UserReport, UserReportDocument } from './schemas/user-report.schema';
import { FLAGS } from './social-policy';

/** Far future: "paused until an admin reviews it". */
const UNTIL_REVIEWED = new Date('9999-12-31T00:00:00Z');

/**
 * The security log (admin → Security events) and the auto-flags that put an
 * account in front of a moderator. Flags never ban anyone; they pause the
 * account's connection requests until an admin reviews it.
 */
@Injectable()
export class SafetyService {
  private readonly logger = new Logger(SafetyService.name);

  constructor(
    @InjectModel(SecurityEvent.name) private readonly events: Model<SecurityEventDocument>,
    @InjectModel(UserReport.name) private readonly reports: Model<UserReportDocument>,
    @InjectModel(Connection.name) private readonly connections: Model<ConnectionDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  /** Record a safety-relevant action. Never throws. */
  async log(type: SecurityEventType, actorId?: Types.ObjectId | string | null, targetId?: Types.ObjectId | string | null, meta?: Record<string, unknown>) {
    try {
      await this.events.create({
        type,
        actorId: actorId ? new Types.ObjectId(String(actorId)) : undefined,
        targetId: targetId ? new Types.ObjectId(String(targetId)) : undefined,
        meta,
      });
    } catch (error) {
      this.logger.warn(`Couldn't log ${type}: ${error?.message ?? error}`);
    }
  }

  /** Why this account should be reviewed (empty = fine). */
  async flagReasons(userId: Types.ObjectId | string): Promise<string[]> {
    const id = new Types.ObjectId(String(userId));
    const [reporters, sent, declined, hits] = await Promise.all([
      this.reports.distinct('reporterId', { reportedId: id }),
      this.connections.countDocuments({ requesterId: id }),
      this.connections.countDocuments({ requesterId: id, status: 'declined' }),
      this.events.countDocuments({
        actorId: id,
        type: { $in: ['search_rate_limited', 'request_rate_limited', 'referral_rate_limited', 'challenge_rate_limited'] },
        createdAt: { $gte: new Date(Date.now() - FLAGS.rateLimitWindowMs) },
      }),
    ]);
    const reasons: string[] = [];
    if (reporters.length >= FLAGS.distinctReporters) reasons.push(`reported by ${reporters.length} students`);
    if (sent >= FLAGS.declineMinRequests && declined / sent >= FLAGS.declineShare) {
      reasons.push(`${Math.round((declined / sent) * 100)}% of ${sent} requests declined`);
    }
    if (hits >= FLAGS.rateLimitHits) reasons.push(`hit rate limits ${hits} times in 24 h`);
    return reasons;
  }

  /** Flag (and pause requests) when a rule trips. Called after reports, declines and rate-limit hits. */
  async evaluate(userId: Types.ObjectId | string) {
    const reasons = await this.flagReasons(userId);
    if (!reasons.length) return;
    const user = await this.users.findById(userId).select('flag').exec();
    if (!user || user.flag) return; // already waiting for review
    user.set({ flag: { at: new Date(), reasons }, requestsPausedUntil: UNTIL_REVIEWED });
    await user.save();
    await this.log('auto_flagged', null, userId, { reasons });
  }
}
