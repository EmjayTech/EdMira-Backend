import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AnalyticsService } from '../analytics/analytics.service';
import { schoolShortName } from '../reference/school-short-names';
import { User, UserDocument } from '../users/model/user.model';
import { ConnectionsService } from './connections.service';
import { PeopleService, privacyOf, publicStudent } from './people.service';
import { SafetyService } from './safety.service';
import { REFERRALS } from './social-policy';

/**
 * Invite links (edmira.org/join/<username>) and "Invited by" at sign-up.
 * An invite credits the inviter and creates a connection request from them
 * to the new student — never an automatic connection.
 */
@Injectable()
export class ReferralsService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly people: PeopleService,
    private readonly connections: ConnectionsService,
    private readonly safety: SafetyService,
    private readonly analytics: AnalyticsService,
  ) {}

  /**
   * Called once the new account exists (email verified). Silently does
   * nothing for unknown, inactive or staff inviters, self-referrals (same
   * email or phone) and inviters over the daily cap.
   */
  async attribute(newUser: UserDocument, code?: string | null) {
    const username = (code ?? '').trim().replace(/^@/, '');
    if (!username) return;
    const inviter = await this.users.findOne({ usernameLower: username.toLowerCase() }).exec();
    if (!inviter || inviter.role || String(inviter._id) === String(newUser._id)) return;
    if (!this.people.isActive(inviter as never)) return;
    if (inviter.email?.toLowerCase() === newUser.email?.toLowerCase()) return;
    if (inviter.phone?.number && inviter.phone.number === newUser.phone?.number) return;

    const today = await this.users.countDocuments({ referredBy: inviter._id, referredAt: { $gte: new Date(Date.now() - 86_400_000) } });
    if (today >= REFERRALS.perInviterPerDay) {
      await this.safety.log('referral_rate_limited', inviter._id, newUser._id, { today });
      await this.safety.evaluate(inviter._id);
      return;
    }

    await this.users.updateOne({ _id: newUser._id }, { $set: { referredBy: inviter._id, referredAt: new Date() } }).exec();
    await this.connections.requestFromLink(inviter._id, newUser._id as Types.ObjectId);
    await this.safety.log('referral_signup', inviter._id, newUser._id);
    this.analytics.track('referral_signup', newUser._id as Types.ObjectId);
  }

  /** "You've invited X classmates". */
  count(userId: string) {
    return this.users.countDocuments({ referredBy: new Types.ObjectId(userId) }).exec();
  }

  /**
   * What the public invite page shows: just the username — plus school and
   * level if the student lets everyone find them. 404 otherwise.
   */
  async publicInvite(username: string) {
    const inviter = await this.people.byUsername(username);
    if (!inviter || inviter.role || !this.people.isActive(inviter)) throw new NotFoundException({ statusCode: 404, message: 'Not found' });
    const open = privacyOf(inviter).findability === 'everyone';
    const card = publicStudent(inviter);
    return { username: card.username, initials: card.initials, school: open ? card.school : '', level: open ? card.level : '' };
  }

  // ── Admin ────────────────────────────────────────────────────────────────

  /** Referrals per inviter and per school (of the inviter), optionally between two dates. */
  async adminReport(from?: Date, to?: Date) {
    const when: Record<string, Date> = {};
    if (from) when.$gte = from;
    if (to) when.$lt = to;
    const match = { referredBy: { $exists: true }, ...(from || to ? { referredAt: when } : {}) };
    const rows = await this.users.aggregate<{ _id: Types.ObjectId; count: number; last: Date }>([
      { $match: match },
      { $group: { _id: '$referredBy', count: { $sum: 1 }, last: { $max: '$referredAt' } } },
      { $sort: { count: -1 } },
      { $limit: 500 },
    ]);
    const inviters = await this.users
      .find({ _id: { $in: rows.map(r => r._id) } })
      .select('username firstName lastName email studentProfile')
      .lean()
      .exec();
    const byId = new Map(inviters.map(u => [String(u._id), u]));
    const students = rows.map(r => {
      const u = byId.get(String(r._id));
      return {
        id: String(r._id),
        username: u?.username ?? '',
        name: [u?.firstName, u?.lastName].filter(Boolean).join(' '),
        email: u?.email ?? '',
        institution: u?.studentProfile?.institution ?? '',
        school: schoolShortName(u?.studentProfile?.institution),
        count: r.count,
        lastAt: r.last?.toISOString() ?? null,
      };
    });
    const bySchool = new Map<string, { school: string; institution: string; count: number; inviters: number }>();
    for (const s of students) {
      const key = s.institution || '—';
      const entry = bySchool.get(key) ?? { school: s.school || key, institution: key, count: 0, inviters: 0 };
      entry.count += s.count;
      entry.inviters += 1;
      bySchool.set(key, entry);
    }
    return {
      total: students.reduce((n, s) => n + s.count, 0),
      students,
      schools: [...bySchool.values()].sort((a, b) => b.count - a.count),
    };
  }
}
