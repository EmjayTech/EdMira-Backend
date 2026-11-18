import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { AnalyticsService } from '../analytics/analytics.service';
import { keyedHash } from '../common/keyed-hash';
import { lagosDay } from '../leaderboard/week';
import { QuizAttempt, QuizAttemptDocument } from '../quiz/quiz-attempt.schema';
import { schoolShortName } from '../reference/school-short-names';
import { SettingsService } from '../settings/settings.service';
import { IntegrityFlag, IntegrityFlagDocument } from '../study/schemas/integrity-flag.schema';
import { PointsEntry, PointsEntryDocument } from '../study/schemas/points-ledger.schema';
import { StudyService } from '../study/study.service';
import { inTransaction } from '../study/transactions';
import { User, UserDocument } from '../users/model/user.model';
import { ConnectionsService } from './connections.service';
import { NotificationsService } from './notifications.service';
import { PeopleService, privacyOf, publicStudent } from './people.service';
import { SafetyService } from './safety.service';
import { REFERRALS } from './social-policy';

/** Where a sign-up came from (hashed before it's stored). */
export interface SignupContext {
  ip?: string | null;
  installId?: string | null;
}

export type ReferralStatus = 'pending' | 'held' | 'rewarded' | 'rejected' | 'reversed';
export type ReferralAdminAction = 'approve' | 'reject' | 'reverse';

const DAY_MS = 86_400_000;
const statusOf = (u: { referral?: { status?: ReferralStatus } | null }): ReferralStatus => u.referral?.status ?? 'pending';

/**
 * Invite links / "Invited by" at sign-up, and the inviter's +10 reward.
 *
 * - At sign-up the new student is linked to the inviter (`referredBy`), gets
 *   a connection request from them (never an automatic connection), and the
 *   referral is "pending".
 * - Their first completed quiz gives the inviter +10 (StudyService
 *   .awardReferral, in the quiz's own transaction): once per invited student,
 *   ever. Only the first 5 a week count on the weekly leaderboard.
 * - Several sign-ups for one inviter from one phone or network in 24 h are
 *   "held" for an admin (Leaderboards → Flags; Referrals page) instead.
 * - Admins can reject a referral, or reverse a reward (a −10 adjustment) for a
 *   duplicate or banned account; banning an invited student reverses it.
 */
@Injectable()
export class ReferralsService implements OnModuleInit {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(PointsEntry.name) private readonly ledger: Model<PointsEntryDocument>,
    @InjectModel(IntegrityFlag.name) private readonly flags: Model<IntegrityFlagDocument>,
    @InjectModel(QuizAttempt.name) private readonly attempts: Model<QuizAttemptDocument>,
    private readonly people: PeopleService,
    private readonly connections: ConnectionsService,
    private readonly safety: SafetyService,
    private readonly analytics: AnalyticsService,
    private readonly study: StudyService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit() {
    // "🎉 @newuser joined with your code: +10 points!"
    this.study.onReferralRewarded(async reward => {
      await this.notifications.notify(reward.inviterId, 'referral_rewarded', reward.refereeId, undefined, { points: reward.points });
      await this.safety.log('referral_rewarded', reward.inviterId, reward.refereeId, { points: reward.points, leaderboard: reward.leaderboard });
      this.analytics.track('referral_rewarded', new Types.ObjectId(reward.inviterId));
    });
  }

  /**
   * Called once the new account exists (always email-verified). Stores the
   * hashed sign-up network / install for every sign-up, then links the
   * inviter. Silently does nothing for unknown, inactive or staff inviters,
   * self-referrals (same email, phone or install) and inviters over the
   * daily cap.
   */
  async attribute(newUser: UserDocument, code?: string | null, ctx: SignupContext = {}) {
    const network = ctx.ip ? keyedHash(ctx.ip) : undefined;
    const installId = ctx.installId?.trim();
    const install = installId ? keyedHash(`install:${installId}`) : undefined;
    if (network || install) {
      await this.users
        .updateOne({ _id: newUser._id }, { $set: { ...(network ? { signupNetwork: network } : {}), ...(install ? { signupInstall: install } : {}) } })
        .exec();
    }

    const username = (code ?? '').trim().replace(/^@/, '');
    if (!username) return;
    const inviter = await this.users.findOne({ usernameLower: username.toLowerCase() }).exec();
    if (!inviter || inviter.role || String(inviter._id) === String(newUser._id)) return;
    if (!this.people.isActive(inviter as never)) return;
    if (inviter.email?.toLowerCase() === newUser.email?.toLowerCase()) return;
    if (inviter.phone?.number && inviter.phone.number === newUser.phone?.number) return;
    if (install && inviter.signupInstall === install) {
      await this.safety.log('referral_self', inviter._id, newUser._id, { sameInstall: true });
      return;
    }

    const since = new Date(Date.now() - DAY_MS);
    const today = await this.users.countDocuments({ referredBy: inviter._id, referredAt: { $gte: since } });
    if (today >= REFERRALS.perInviterPerDay) {
      await this.safety.log('referral_rate_limited', inviter._id, newUser._id, { today });
      await this.safety.evaluate(inviter._id);
      return;
    }

    // Many of this inviter's sign-ups from one phone or network → hold them all for review.
    const recent = await this.users
      .find({ referredBy: inviter._id, referredAt: { $gte: since } })
      .select('_id signupNetwork signupInstall referral')
      .lean()
      .exec();
    const sameInstall = install ? recent.filter(r => r.signupInstall === install) : [];
    const sameNetwork = network ? recent.filter(r => r.signupNetwork === network) : [];
    const hold =
      (!!install && sameInstall.length + 1 >= REFERRALS.holdSameInstall) ||
      (!!network && sameNetwork.length + 1 >= REFERRALS.holdSameNetwork);

    const now = new Date();
    await this.users
      .updateOne(
        { _id: newUser._id },
        { $set: { referredBy: inviter._id, referredAt: now, referral: { status: hold ? 'held' : 'pending', at: now, ...(hold ? { reason: 'cluster' } : {}) } } },
      )
      .exec();
    if (hold) {
      const cluster = [...new Map([...sameInstall, ...sameNetwork].map(r => [String(r._id), r])).values()];
      const stillPending = cluster.filter(r => statusOf(r as never) === 'pending').map(r => r._id);
      if (stillPending.length) {
        await this.users.updateMany({ _id: { $in: stillPending } }, { $set: { referral: { status: 'held', at: now, reason: 'cluster' } } }).exec();
      }
      await this.flags
        .updateOne(
          { kind: 'referral_cluster', sourceId: `${inviter._id}:${lagosDay(now)}` },
          {
            $setOnInsert: { userId: inviter._id, status: 'open' },
            $set: {
              detail: {
                inviter: inviter.username ?? '',
                sameInstall: sameInstall.length + (install ? 1 : 0),
                sameNetwork: sameNetwork.length + (network ? 1 : 0),
                signups: recent.length + 1,
              },
            },
          },
          { upsert: true },
        )
        .exec();
      await this.safety.log('referral_held', inviter._id, newUser._id, { sameInstall: sameInstall.length, sameNetwork: sameNetwork.length });
    }

    await this.connections.requestFromLink(inviter._id, newUser._id as Types.ObjectId);
    await this.safety.log('referral_signup', inviter._id, newUser._id);
    this.analytics.track('referral_signup', newUser._id as Types.ObjectId);
  }

  /** "You've invited X classmates" (older app versions). */
  count(userId: string) {
    return this.users.countDocuments({ referredBy: new Types.ObjectId(userId) }).exec();
  }

  /**
   * The inviter's own numbers. Held referrals show as pending (the inviter
   * isn't told about reviews); rejected / reversed as "not counted".
   */
  async mine(userId: string) {
    const id = new Types.ObjectId(userId);
    const invited = await this.users
      .find({ referredBy: id })
      .sort({ referredAt: -1 })
      .select('username role studentProfile referral referredAt avatar')
      .lean()
      .exec();
    const [earned, lifetime, config] = await Promise.all([
      this.ledger.aggregate<{ total: number }>([
        { $match: { userId: id, $or: [{ sourceType: 'referral' }, { 'meta.kind': 'referral_reversal' }] } },
        { $group: { _id: null, total: { $sum: '$points' } } },
      ]),
      this.study.lifetimePoints(id),
      this.settings.points(),
    ]);
    const shown = (s: ReferralStatus) => (s === 'rewarded' ? 'rewarded' : s === 'pending' || s === 'held' ? 'pending' : 'not_counted');
    const rows = invited.map(u => ({ status: shown(statusOf(u as never)), user: u }));
    return {
      count: invited.length,
      joined: invited.length,
      pending: rows.filter(r => r.status === 'pending').length,
      rewarded: rows.filter(r => r.status === 'rewarded').length,
      pointsEarned: Math.max(0, earned[0]?.total ?? 0),
      lifetimePoints: lifetime,
      rewardPoints: config.referral,
      recent: rows.slice(0, 20).map(r => ({
        ...publicStudent(r.user as never),
        status: r.status,
        joinedAt: r.user.referredAt?.toISOString() ?? null,
      })),
    };
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

  // ── Rewards outside a quiz ─────────────────────────────────────────────────

  /** Completed, not too fast, not a retry: a quiz that earns the inviter's reward. */
  private async hasQualifyingQuiz(refereeId: Types.ObjectId) {
    const config = await this.settings.points();
    const attempts = await this.attempts
      .find({ studentId: refereeId, retry: { $ne: true } })
      .select('total answeredCount startedAt submittedAt')
      .lean()
      .exec();
    return attempts.some(a => {
      const completed = a.answeredCount > 0 && a.answeredCount >= Math.min(config.minAnsweredForCompletedQuiz, a.total);
      const seconds = (a.submittedAt.getTime() - a.startedAt.getTime()) / 1000 / Math.max(1, a.answeredCount);
      return completed && seconds >= config.minSecondsPerQuestion;
    });
  }

  /** Give the reward now if the invited student already completed a quiz (after approval / back-fill). */
  private async rewardIfQuizDone(refereeId: Types.ObjectId, opts: { lifetimeOnly?: boolean; reason?: string } = {}) {
    if (!(await this.hasQualifyingQuiz(refereeId))) return null;
    const reward = await inTransaction(this.connection, session => this.study.awardReferral(refereeId, new Date(), session, opts));
    if (reward && !opts.lifetimeOnly) await this.study.referralRewarded(reward);
    else if (reward) await this.study.invalidate(reward.inviterId);
    return reward;
  }

  /**
   * One-off after this feature ships: referrals from before it get their
   * reward if the invited student already completed a quiz — as lifetime
   * points only, so this week's leaderboard isn't reshuffled. Safe to re-run.
   */
  async backfill(log: (line: string) => void = () => undefined) {
    const referees = await this.users
      .find({ referredBy: { $exists: true }, referral: { $exists: false } })
      .select('_id')
      .lean()
      .exec();
    log(`Checking ${referees.length} referrals from before referral rewards…`);
    let rewarded = 0;
    for (const r of referees) {
      const reward = await this.rewardIfQuizDone(r._id as Types.ObjectId, { lifetimeOnly: true, reason: 'backfill' });
      if (reward) rewarded += 1;
      else {
        await this.users
          .updateOne({ _id: r._id, referral: { $exists: false } }, { $set: { referral: { status: 'pending', at: new Date() } } })
          .exec();
      }
    }
    return { checked: referees.length, rewarded };
  }

  // ── Admin ────────────────────────────────────────────────────────────────

  /**
   * Admin actions on one invited student's referral:
   *   approve — a held referral: pending again (rewarded now if their first quiz is done)
   *   reject  — a pending / held one never earns the reward
   *   reverse — take back a reward already given (duplicate or fake account)
   */
  async adminAction(refereeId: string, action: ReferralAdminAction, reason: string | undefined, staffName: string) {
    if (!Types.ObjectId.isValid(refereeId)) throw new NotFoundException('Student not found.');
    const id = new Types.ObjectId(refereeId);
    const referee = await this.users.findById(id).select('referredBy referral').lean().exec();
    if (!referee?.referredBy) throw new NotFoundException('That student wasn’t invited by anyone.');
    const status = statusOf(referee as never);
    const why = reason?.trim() || undefined;

    if (action === 'approve') {
      if (status !== 'held') throw new BadRequestException('Only held referrals can be approved.');
      await this.users
        .updateOne({ _id: id }, { $set: { referral: { status: 'pending', at: new Date(), by: staffName, ...(why ? { reason: why } : {}) } } })
        .exec();
      const reward = await this.rewardIfQuizDone(id);
      return { status: reward ? 'rewarded' : 'pending' };
    }
    if (!why) throw new BadRequestException('Please give a reason.');
    if (action === 'reject') {
      if (status !== 'pending' && status !== 'held') throw new BadRequestException('Only pending or held referrals can be rejected.');
      await this.users.updateOne({ _id: id }, { $set: { referral: { status: 'rejected', at: new Date(), reason: why, by: staffName } } }).exec();
      return { status: 'rejected' };
    }
    return this.reverse(id, why, staffName);
  }

  /**
   * Take back the inviter's reward for `refereeId` (an adjustment in the same
   * week, so a leaderboard reward comes off that week's board too). Pending
   * or held referrals are just rejected. Also used when an invited student is
   * banned. Safe to call twice.
   */
  async reverse(refereeId: Types.ObjectId | string, reason: string, staffName: string) {
    const id = new Types.ObjectId(String(refereeId));
    const referee = await this.users.findById(id).select('referredBy referral').lean().exec();
    if (!referee?.referredBy) return { status: 'none' };
    const status = statusOf(referee as never);
    if (status === 'pending' || status === 'held') {
      await this.users.updateOne({ _id: id }, { $set: { referral: { status: 'rejected', at: new Date(), reason, by: staffName } } }).exec();
      return { status: 'rejected' };
    }
    if (status !== 'rewarded') return { status };

    const reward = await this.ledger.findOne({ sourceType: 'referral', sourceId: String(id) }).lean().exec();
    if (reward && reward.points > 0) {
      await this.ledger
        .updateOne(
          { sourceType: 'adjustment', sourceId: `referral-reversal:${id}` },
          {
            $setOnInsert: {
              userId: reward.userId,
              occurredAt: new Date(),
              day: reward.day,
              week: reward.week,
              points: -reward.points,
              requested: -reward.points,
              ...(reward.leaderboard === false ? { leaderboard: false } : {}),
              meta: { kind: 'referral_reversal', reason, by: staffName, referee: String(id) },
            },
          },
          { upsert: true },
        )
        .exec();
      if (reward.leaderboard !== false) await this.study.reconcileWeek(reward.week);
      await this.study.invalidate(reward.userId);
    }
    await this.users.updateOne({ _id: id }, { $set: { referral: { status: 'reversed', at: new Date(), reason, by: staffName } } }).exec();
    await this.safety.log('referral_reversed', referee.referredBy, id, { reason });
    return { status: 'reversed' };
  }

  /** Everyone one student invited, with each referral's status (admin). */
  async adminStudent(inviterId: string) {
    if (!Types.ObjectId.isValid(inviterId)) throw new NotFoundException('Student not found.');
    const id = new Types.ObjectId(inviterId);
    const inviter = await this.users.findById(id).select('username firstName lastName signupNetwork signupInstall').lean().exec();
    if (!inviter) throw new NotFoundException('Student not found.');
    const invited = await this.users
      .find({ referredBy: id })
      .sort({ referredAt: -1 })
      .select('username firstName lastName email studentProfile referral referredAt signupNetwork signupInstall status')
      .lean()
      .exec();
    const ids = invited.map(u => u._id);
    const [rewards, quizzes] = await Promise.all([
      this.ledger
        .find({ sourceType: 'referral', sourceId: { $in: ids.map(String) } })
        .select('sourceId points leaderboard occurredAt')
        .lean()
        .exec(),
      this.attempts.aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { studentId: { $in: ids } } },
        { $group: { _id: '$studentId', n: { $sum: 1 } } },
      ]),
    ]);
    const byReferee = new Map(rewards.map(r => [r.sourceId, r]));
    const quizCount = new Map(quizzes.map(q => [String(q._id), q.n]));
    const tally = (key: 'signupNetwork' | 'signupInstall') => {
      const m = new Map<string, number>();
      for (const u of invited) if (u[key]) m.set(u[key]!, (m.get(u[key]!) ?? 0) + 1);
      return m;
    };
    const networks = tally('signupNetwork');
    const installs = tally('signupInstall');
    return {
      inviter: { id: inviterId, username: inviter.username ?? '', name: [inviter.firstName, inviter.lastName].filter(Boolean).join(' ') },
      referrals: invited.map(u => {
        const reward = byReferee.get(String(u._id));
        return {
          id: String(u._id),
          username: u.username ?? '',
          name: [u.firstName, u.lastName].filter(Boolean).join(' '),
          email: u.email ?? '',
          school: schoolShortName(u.studentProfile?.institution),
          joinedAt: u.referredAt?.toISOString() ?? null,
          status: statusOf(u as never),
          reason: u.referral?.reason ?? null,
          accountStatus: u.status,
          quizzes: quizCount.get(String(u._id)) ?? 0,
          points: reward?.points ?? 0,
          onLeaderboard: reward ? reward.leaderboard !== false : null,
          rewardedAt: reward?.occurredAt?.toISOString() ?? null,
          sharedNetwork: !!u.signupNetwork && ((networks.get(u.signupNetwork) ?? 0) > 1 || u.signupNetwork === inviter.signupNetwork),
          sharedInstall: !!u.signupInstall && ((installs.get(u.signupInstall) ?? 0) > 1 || u.signupInstall === inviter.signupInstall),
        };
      }),
    };
  }

  /** Referrals per inviter and per school (of the inviter), optionally between two dates. */
  async adminReport(from?: Date, to?: Date) {
    const when: Record<string, Date> = {};
    if (from) when.$gte = from;
    if (to) when.$lt = to;
    const match = { referredBy: { $exists: true }, ...(from || to ? { referredAt: when } : {}) };
    const statusIs = (s: string) => ({ $sum: { $cond: [{ $eq: [{ $ifNull: ['$referral.status', 'pending'] }, s] }, 1, 0] } });
    const rows = await this.users.aggregate<{ _id: Types.ObjectId; count: number; rewarded: number; pending: number; held: number; last: Date }>([
      { $match: match },
      {
        $group: {
          _id: '$referredBy',
          count: { $sum: 1 },
          rewarded: statusIs('rewarded'),
          pending: statusIs('pending'),
          held: statusIs('held'),
          last: { $max: '$referredAt' },
        },
      },
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
        rewarded: r.rewarded,
        pending: r.pending,
        held: r.held,
        lastAt: r.last?.toISOString() ?? null,
      };
    });
    const bySchool = new Map<string, { school: string; institution: string; count: number; rewarded: number; inviters: number }>();
    for (const s of students) {
      const key = s.institution || '—';
      const entry = bySchool.get(key) ?? { school: s.school || key, institution: key, count: 0, rewarded: 0, inviters: 0 };
      entry.count += s.count;
      entry.rewarded += s.rewarded;
      entry.inviters += 1;
      bySchool.set(key, entry);
    }
    return {
      total: students.reduce((n, s) => n + s.count, 0),
      rewarded: students.reduce((n, s) => n + s.rewarded, 0),
      held: students.reduce((n, s) => n + s.held, 0),
      students,
      schools: [...bySchool.values()].sort((a, b) => b.count - a.count),
    };
  }
}
