import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { InjectModel } from '@nestjs/mongoose';
import { Cache } from 'cache-manager';
import { Model, Types } from 'mongoose';
import { AnalyticsService } from '../analytics/analytics.service';
import { AccountStatus } from '../common/enum/staff-role.enum';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { lagosDay } from '../leaderboard/week';
import { QuizAttempt, QuizAttemptDocument } from '../quiz/quiz-attempt.schema';
import { schoolShortName } from '../reference/school-short-names';
import { User, UserDocument } from '../users/model/user.model';
import { normalizeUsername } from '../users/username-policy';
import { avatarView } from '../avatars/avatar-view';
import { SafetyService } from './safety.service';
import { BadgesService } from './badges.service';
import { Block, BlockDocument } from './schemas/block.schema';
import { Connection, ConnectionDocument } from './schemas/connection.schema';
import { DEFAULT_PRIVACY, SEARCH, pairKey } from './social-policy';

/** The account fields visibility decisions need. */
export type Person = Pick<User, 'username' | 'role' | 'status' | 'isVerified' | 'privacy' | 'studentProfile' | 'createdAt' | 'suspendedUntil' | 'avatar'> & {
  _id: Types.ObjectId;
};
const PERSON_FIELDS = 'username usernameLower role status isVerified privacy studentProfile createdAt suspendedUntil avatar';

/** What any student may see about another — never names, emails, phones or ids. */
export const publicStudent = (u: Pick<Person, 'username' | 'role' | 'studentProfile'> & Partial<Pick<Person, 'avatar'>>) => ({
  username: u.username,
  initials: (u.username ?? '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?',
  school: u.role ? '' : schoolShortName(u.studentProfile?.institution),
  level: u.role ? '' : u.studentProfile?.level ?? '',
  /** Staff accounts carry the "EdMira team" badge so students can spot impersonators. */
  badge: u.role ? ('edmira_team' as const) : null,
  /** Profile picture: preset id or photo URL; neither → initials. */
  avatar: avatarView(u),
});

export const privacyOf = (u: Pick<Person, 'privacy'>) => ({ ...DEFAULT_PRIVACY, ...(u.privacy ?? {}) });

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Who can see whom. Every student-to-student feature goes through here, so
 * the rules (privacy settings, blocks, suspensions, staff) live in one place.
 */
@Injectable()
export class PeopleService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Block.name) private readonly blocks: Model<BlockDocument>,
    @InjectModel(Connection.name) private readonly connections: Model<ConnectionDocument>,
    @InjectModel(QuizAttempt.name) private readonly attempts: Model<QuizAttemptDocument>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly safety: SafetyService,
    private readonly leaderboards: LeaderboardService,
    private readonly analytics: AnalyticsService,
    private readonly badges: BadgesService,
  ) {}

  // ── Building blocks ────────────────────────────────────────────────────────

  async me(userId: string): Promise<Person> {
    const me = await this.users.findById(userId).select(PERSON_FIELDS).lean<Person>().exec();
    if (!me) throw new NotFoundException();
    return me;
  }

  /** Any account with this username (any case), or null. */
  async byUsername(username: string): Promise<Person | null> {
    const lower = normalizeUsername(username ?? '');
    if (!lower) return null;
    return this.users.findOne({ usernameLower: lower }).select(PERSON_FIELDS).lean<Person>().exec();
  }

  /** Everyone `userId` blocked or is blocked by — hidden from each other everywhere. */
  async blockedEitherWay(userId: Types.ObjectId | string): Promise<Set<string>> {
    const id = new Types.ObjectId(String(userId));
    const rows = await this.blocks.find({ $or: [{ blockerId: id }, { blockedId: id }] }).lean().exec();
    return new Set(rows.map(b => String(String(b.blockerId) === String(id) ? b.blockedId : b.blockerId)));
  }

  isBlockedBetween(a: Types.ObjectId | string, b: Types.ObjectId | string) {
    const [x, y] = [new Types.ObjectId(String(a)), new Types.ObjectId(String(b))];
    return this.blocks.exists({ $or: [{ blockerId: x, blockedId: y }, { blockerId: y, blockedId: x }] }).then(Boolean);
  }

  /** Active, verified and not suspended or banned. */
  isActive(u: Person) {
    if (!u.isVerified) return false;
    if (u.status === AccountStatus.BANNED) return false;
    if (u.status === AccountStatus.SUSPENDED) return !!u.suspendedUntil && u.suspendedUntil <= new Date();
    return true;
  }

  /**
   * Can `viewer` see `target`? `exact` = they typed the whole username
   * (cards, requests); otherwise it's a prefix search.
   */
  async canSee(viewer: Person, target: Person | null, exact: boolean): Promise<boolean> {
    if (!target || String(target._id) === String(viewer._id) || !this.isActive(target)) return false;
    if (target.role) return exact; // staff: exact username only (with the EdMira team badge)
    const { findability } = privacyOf(target);
    if (findability === 'nobody' || (findability === 'exact' && !exact)) return false;
    return !(await this.isBlockedBetween(viewer._id, target._id));
  }

  /** The visible student with this exact username, or null — same answer for "doesn't exist" and "hidden". */
  async visible(viewer: Person, username: string): Promise<Person | null> {
    const target = await this.byUsername(username);
    return (await this.canSee(viewer, target, true)) ? target : null;
  }

  /** The live (pending / accepted) connection between two students, as `viewer` may see it. */
  async liveConnection(viewerId: Types.ObjectId | string, otherId: Types.ObjectId | string) {
    const row = await this.connections.findOne({ livePair: pairKey(String(viewerId), String(otherId)) }).lean().exec();
    if (!row) return null;
    const sentByViewer = String(row.requesterId) === String(viewerId);
    if (row.status === 'pending' && row.expiresAt <= new Date()) return null;
    if (row.shadow && !sentByViewer) return null; // the recipient never sees it
    return row;
  }

  areConnected = async (a: Types.ObjectId | string, b: Types.ObjectId | string) =>
    (await this.liveConnection(a, b))?.status === 'accepted';

  // ── Search ─────────────────────────────────────────────────────────────────

  /** Username search: 3+ characters, up to 10 results, respecting privacy settings and blocks. */
  async search(userId: string, q: string) {
    const query = normalizeUsername((q ?? '').replace(/^@/, ''));
    if (query.length < SEARCH.minChars) {
      throw new BadRequestException({ statusCode: 400, code: 'QUERY_TOO_SHORT', message: `Type at least ${SEARCH.minChars} characters.` });
    }
    const me = await this.me(userId);
    if (!this.isActive(me)) throw new NotFoundException();
    await this.countSearch(userId);

    const hidden = [...(await this.blockedEitherWay(me._id))].map(id => new Types.ObjectId(id));
    const candidates = await this.users
      .find({
        _id: { $nin: [me._id, ...hidden] },
        usernameLower: { $regex: `^${escapeRegex(query)}` },
        isVerified: true,
        status: { $nin: [AccountStatus.SUSPENDED, AccountStatus.BANNED] },
        'privacy.findability': { $ne: 'nobody' },
      })
      .select(PERSON_FIELDS)
      .sort({ usernameLower: 1 })
      .limit(SEARCH.maxResults * 3)
      .lean<(Person & { usernameLower: string })[]>()
      .exec();

    const results = [];
    for (const c of candidates) {
      const exact = c.usernameLower === query;
      if (c.role && !exact) continue;
      if (privacyOf(c).findability === 'exact' && !exact) continue;
      results.push({ ...publicStudent(c), connection: await this.connectionState(me._id, c._id) });
      if (results.length === SEARCH.maxResults) break;
    }
    this.analytics.track('user_search', me._id);
    return results;
  }

  /** 30 a minute and 300 a day per student; hitting a limit is logged and may flag the account. */
  private async countSearch(userId: string) {
    const minuteKey = `search_m:${userId}:${Math.floor(Date.now() / 60_000)}`;
    const dayKey = `search_d:${userId}:${lagosDay(new Date())}`;
    const [minute, day] = await Promise.all([this.cache.get<number>(minuteKey), this.cache.get<number>(dayKey)]);
    if ((minute ?? 0) >= SEARCH.perMinute || (day ?? 0) >= SEARCH.perDay) {
      await this.safety.log('search_rate_limited', userId, null, { perMinute: minute ?? 0, perDay: day ?? 0 });
      await this.safety.evaluate(userId);
      throw new HttpException(
        { statusCode: 429, code: 'SEARCH_LIMIT', message: "You've searched a lot — please wait a little and try again." },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await Promise.all([
      this.cache.set(minuteKey, (minute ?? 0) + 1, 61_000),
      this.cache.set(dayKey, (day ?? 0) + 1, 25 * 60 * 60 * 1000),
    ]);
  }

  // ── Student card ───────────────────────────────────────────────────────────

  /** How `viewer` relates to `other`: none / requested (sent) / incoming / connected. */
  async connectionState(viewerId: Types.ObjectId, otherId: Types.ObjectId) {
    const row = await this.liveConnection(viewerId, otherId);
    if (!row) return { status: 'none' as const };
    if (row.status === 'accepted') return { status: 'connected' as const, id: String(row._id) };
    const sent = String(row.requesterId) === String(viewerId);
    return { status: sent ? ('requested' as const) : ('incoming' as const), id: String(row._id), note: row.note ?? null };
  }

  /**
   * A student's card. 404 for anyone you can't see — whether they don't
   * exist, hide from search, blocked you or were suspended.
   */
  async card(userId: string, username: string) {
    const me = await this.me(userId);
    const target = await this.visible(me, username);
    if (!target) throw new NotFoundException({ statusCode: 404, message: 'Not found' });
    const connection = await this.connectionState(me._id, target._id);
    const privacy = privacyOf(target);
    const connected = connection.status === 'connected';
    const open = !target.role && privacy.publicProfile;
    return {
      ...publicStudent(target),
      canConnect: !target.role && !me.role,
      connection,
      /** Public profiles show to everyone; otherwise only connections see this. */
      publicProfile: open,
      realName: open && privacy.showRealName ? await this.realName(target._id) : null,
      badges: open || connected ? await this.badges.badgesOf(target._id) : [],
      progress: connected ? await this.sharedProgress(target) : open ? await this.publicProgress(target) : null,
    };
  }

  /** What a public profile shows to anyone: streak and topics mastered (never scores). */
  private async publicProgress(target: Person) {
    const summary = await this.leaderboards.summary(String(target._id));
    return { streakDays: summary.streakDays, topicsPractised: null, topicsMastered: summary.topicsMastered, averageScore: null };
  }

  private async realName(id: Types.ObjectId) {
    const u = await this.users.findById(id).select('firstName lastName').lean().exec();
    return [u?.firstName, u?.lastName].filter(Boolean).join(' ') || null;
  }

  /**
   * The public profile for the future edmira.org/u/<username> page (no
   * login): only for students who made their profile public. 404 otherwise.
   */
  async publicProfile(username: string) {
    const target = await this.byUsername(username);
    if (!target || target.role || !this.isActive(target) || !privacyOf(target).publicProfile) {
      throw new NotFoundException({ statusCode: 404, message: 'Not found' });
    }
    const { initials, username: name, school, level } = publicStudent(target);
    return {
      username: name,
      initials,
      school,
      level,
      realName: privacyOf(target).showRealName ? await this.realName(target._id) : null,
      badges: await this.badges.badgesOf(target._id),
      ...(await this.publicProgress(target)),
    };
  }

  /** My own profile as others see it (Profile → badges, preview). */
  async myProfile(userId: string) {
    const me = await this.me(userId);
    const privacy = privacyOf(me);
    return {
      ...publicStudent(me),
      publicProfile: privacy.publicProfile,
      realName: privacy.publicProfile && privacy.showRealName ? await this.realName(me._id) : null,
      badges: await this.badges.badgesOf(me._id),
      progress: await this.publicProgress(me),
    };
  }

  /** What a connection may see, per the target's settings (streak + topics on; exact scores off by default). */
  private async sharedProgress(target: Person) {
    const privacy = privacyOf(target);
    if (!privacy.shareProgress) return null;
    const id = target._id;
    const [summary, topics, average] = await Promise.all([
      this.leaderboards.summary(String(id)),
      this.attempts.distinct('topicId', { studentId: id }),
      privacy.shareScores
        ? this.attempts.aggregate<{ avg: number }>([{ $match: { studentId: id, retry: { $ne: true } } }, { $group: { _id: null, avg: { $avg: '$score' } } }])
        : Promise.resolve([]),
    ]);
    return {
      streakDays: summary.streakDays,
      topicsPractised: topics.length,
      topicsMastered: summary.topicsMastered,
      averageScore: privacy.shareScores && average[0] ? Math.round(average[0].avg) : null,
    };
  }
}
