import { createHash } from 'crypto';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { InjectModel } from '@nestjs/mongoose';
import { Cache } from 'cache-manager';
import { FilterQuery, Model, Types } from 'mongoose';
import { AccountStatus } from '../common/enum/staff-role.enum';
import { QuizAttempt, QuizAttemptDocument } from '../quiz/quiz-attempt.schema';
import { schoolShortName } from '../reference/school-short-names';
import { SettingsService } from '../settings/settings.service';
import { Block, BlockDocument } from '../social/schemas/block.schema';
import { Connection, ConnectionDocument } from '../social/schemas/connection.schema';
import { StudyService } from '../study/study.service';
import { User, UserDocument } from '../users/model/user.model';
import { LeaderboardWeek, LeaderboardWeekDocument } from './leaderboard-week.schema';
import { addDays, previousWeek, weekOf, weekRange } from './week';
import { AvatarView, avatarView } from '../avatars/avatar-view';

/** Tabs of the original leaderboard API (GET /leaderboards), kept for older app builds. */
export const LEADERBOARD_SCOPES = ['course', 'level', 'school', 'all'] as const;
export type LeaderboardScope = (typeof LEADERBOARD_SCOPES)[number];

/** Tabs of GET /leaderboard. "course" = classmates: same school, programme and level. */
export const BOARD_SCOPES = ['school', 'course', 'level', 'department', 'all', 'friends'] as const;
export type BoardScope = (typeof BOARD_SCOPES)[number];
export const BOARD_PERIODS = ['this_week', 'last_week'] as const;
export type BoardPeriod = (typeof BOARD_PERIODS)[number];

/** How many students the original API lists. */
export const TOP_N = 20;
export const MAX_PAGE = 100;
/** Ranks we nudge students towards: "12 points to the top 30". */
const TIERS = [1, 3, 10, 20, 30, 50, 100];
/** A topic is mastered once the best score on it reaches this. */
export const MASTERY_SCORE = 80;
const PAGE_CACHE_MS = 60_000;
const HIDDEN_CACHE_MS = 30_000;

/** Ranking order: points, then study days, then correct answers, then whoever got there first. */
export const SORT = { points: -1, activeDays: -1, correct: -1, reachedAt: 1, _id: 1 } as const;

/** What everyone else may see about a student (original API) — never names, emails or phones. */
export interface PublicEntry {
  rank: number;
  /** null for a student you've blocked (or who blocked you). */
  username: string | null;
  anonymous: boolean;
  school: string;
  level: string;
  points: number;
  isMe: boolean;
}

type Academics = { institution?: string; department?: string; level?: string };
type RankRow = Pick<LeaderboardWeek, 'points' | 'activeDays' | 'correct' | 'reachedAt'> & { _id: Types.ObjectId };
interface CachedRow {
  studentId: string;
  points: number;
  activeDays: number;
  institution?: string;
  level?: string;
  username: string | null;
}

/** Two letters from the username (never the real name). */
export const initialsOf = (username?: string | null) =>
  (username ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';

@Injectable()
export class LeaderboardService implements OnModuleInit {
  /** Goes up whenever anyone earns points, so cached pages never hide a fresh score for long. */
  private version = 0;
  private hidden?: { at: number; ids: Types.ObjectId[] };

  constructor(
    @InjectModel(LeaderboardWeek.name) private readonly weeks: Model<LeaderboardWeekDocument>,
    @InjectModel(QuizAttempt.name) private readonly attempts: Model<QuizAttemptDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Block.name) private readonly blocks: Model<BlockDocument>,
    @InjectModel(Connection.name) private readonly connections: Model<ConnectionDocument>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly study: StudyService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit() {
    this.study.onPointsAdded(() => {
      this.version += 1;
    });
  }

  // ── Keeping totals up to date ──────────────────────────────────────────────
  // Points are added as they're earned by StudyService (points ledger, same
  // transaction as the quiz). This service only reads them.

  /** After Edit profile: move this week's row to the new school / programme / level. */
  async syncAcademics(studentId: string | Types.ObjectId) {
    const user = await this.users.findById(studentId).select('studentProfile').lean().exec();
    if (!user) return;
    await this.weeks
      .updateOne({ week: weekOf(new Date()), studentId: new Types.ObjectId(String(studentId)) }, { $set: academicsOf(user) })
      .exec();
    this.version += 1;
  }

  /** Recount a week's totals from the points ledger (`yarn leaderboard rebuild`, nightly job). */
  rebuildWeek(week: string) {
    return this.study.reconcileWeek(week);
  }

  /** Call when someone's visibility changes (privacy toggle, admin exclusion, suspension). */
  forgetHidden() {
    this.hidden = undefined;
    this.version += 1;
  }

  /** Profile pictures for a page of board rows (one query per page). */
  private async avatarsOf(studentIds: string[]): Promise<Map<string, AvatarView>> {
    const ids = [...new Set(studentIds)].filter(id => Types.ObjectId.isValid(id));
    if (!ids.length) return new Map();
    const users = await this.users.find({ _id: { $in: ids }, avatar: { $exists: true } }).select('avatar').lean().exec();
    return new Map(users.map(u => [String(u._id), avatarView(u)]));
  }

  /**
   * Students left out of everyone else's boards: "Show me on leaderboards"
   * off, excluded by an admin, suspended or banned. They still see their own
   * rank privately.
   */
  async hiddenIds(): Promise<Types.ObjectId[]> {
    if (this.hidden && Date.now() - this.hidden.at < HIDDEN_CACHE_MS) return this.hidden.ids;
    const rows = await this.users
      .find({
        $or: [
          { 'privacy.showOnLeaderboard': false },
          { leaderboardExclusion: { $exists: true, $ne: null } },
          { status: { $in: [AccountStatus.SUSPENDED, AccountStatus.BANNED] } },
        ],
      })
      .select('_id')
      .lean()
      .exec();
    this.hidden = { at: Date.now(), ids: rows.map(r => r._id as Types.ObjectId) };
    return this.hidden.ids;
  }

  // ── GET /leaderboard (the redesigned board) ────────────────────────────────

  async board(
    userId: string,
    scope: BoardScope,
    period: BoardPeriod = 'this_week',
    { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {},
  ) {
    const current = weekOf(new Date());
    const week = period === 'last_week' ? previousWeek(current) : current;
    const me = new Types.ObjectId(userId);
    const base = {
      week_start: week,
      week_end: addDays(week, 6),
      scope,
      period,
      resets_at: weekRange(current).end.toISOString(),
    };
    const filter = await this.scopeFilter(scope, userId);
    if (!filter) {
      return { ...base, entries: [], me: emptyMe(), total_ranked: 0, next_cursor: null, missing_profile: true };
    }

    const hidden = await this.hiddenIds();
    const query: FilterQuery<LeaderboardWeek> = { week, points: { $gt: 0 }, ...filter, studentId: { $nin: hidden, ...(filter.studentId ?? {}) } };
    const size = Math.min(Math.max(1, limit), MAX_PAGE);
    const start = Math.max(0, offset);

    const [{ rows, total }, blocked, mine, myUser] = await Promise.all([
      this.cachedPage(query, start, size),
      this.blockedIds(me),
      this.weeks.findOne({ week, studentId: me, ...omitStudent(filter) }).lean().exec(),
      this.users.findById(me).select('privacy leaderboardExclusion status').lean().exec(),
    ]);

    const avatars = await this.avatarsOf(rows.map(r => r.studentId));
    const entries = rows.map((r, i) => {
      const isMe = r.studentId === userId;
      const anonymous = !isMe && blocked.has(r.studentId);
      const avatar = anonymous ? { preset: null, url: null } : avatars.get(r.studentId) ?? { preset: null, url: null };
      const rank = start + i + 1;
      return {
        rank,
        username: anonymous ? null : r.username,
        initials: anonymous ? '?' : initialsOf(r.username),
        avatar_url: avatar.url,
        avatar_preset: avatar.preset,
        anonymous,
        school_short: schoolShortName(r.institution),
        level: r.level ?? '',
        points: r.points,
        study_days: r.activeDays,
        is_me: isMe,
        is_winner: period === 'last_week' && rank === 1,
      };
    });

    const amHidden =
      myUser?.privacy?.showOnLeaderboard === false ||
      !!myUser?.leaderboardExclusion ||
      (myUser?.status && myUser.status !== AccountStatus.ACTIVE);
    let meBlock = emptyMe();
    if (mine && mine.points > 0) {
      // Hidden students are ranked privately among everyone visible ("You'd be #12").
      const rank = await this.rankOf(query, mine as RankRow);
      const above = rank > 1 ? await this.weeks.findOne(query).sort(SORT).skip(rank - 2).select('studentId points').lean().exec() : null;
      const aboveUser = above && !blocked.has(String(above.studentId))
        ? await this.users.findById(above.studentId).select('username').lean().exec()
        : null;
      meBlock = {
        rank,
        points: mine.points,
        study_days: mine.activeDays,
        points_to_next_rank: above ? Math.max(1, above.points - mine.points + 1) : null,
        next_rank_username: aboveUser?.username ?? null,
        percentile: total ? Math.max(1, Math.ceil((rank / (total + (amHidden ? 1 : 0))) * 100)) : null,
        hidden: !!amHidden,
      };
    } else {
      meBlock = { ...meBlock, hidden: !!amHidden };
    }

    return {
      ...base,
      entries,
      me: meBlock,
      total_ranked: total,
      next_cursor: start + size < total ? String(start + size) : null,
      missing_profile: false,
    };
  }

  /**
   * School against school: average points per active student (≥ 1 study
   * day that week), only schools with enough active students (5 by default).
   */
  async schoolsBoard(userId: string | null, period: BoardPeriod = 'this_week', week?: string) {
    const current = weekOf(new Date());
    const w = week ?? (period === 'last_week' ? previousWeek(current) : current);
    const { minActiveStudents } = await this.settings.leaderboard();
    const hidden = await this.hiddenIds();
    const rows = await this.weeks.aggregate<{ _id: string; total: number; active: number }>([
      { $match: { week: w, activeDays: { $gte: 1 }, institution: { $type: 'string' }, studentId: { $nin: hidden } } },
      { $group: { _id: '$institution', total: { $sum: '$points' }, active: { $sum: 1 } } },
      { $match: { active: { $gte: minActiveStudents } } },
    ]);
    const mine = userId ? (await this.users.findById(userId).select('studentProfile').lean().exec())?.studentProfile?.institution : undefined;
    const schools = rows
      .map(r => ({ name: r._id, total: r.total, active: r.active, avg: Math.round((r.total / r.active) * 10) / 10 }))
      .sort((a, b) => b.avg - a.avg || b.total - a.total || a.name.localeCompare(b.name))
      .map((r, i) => ({
        rank: i + 1,
        school_short: schoolShortName(r.name) || r.name,
        school_name: r.name,
        avg_points: r.avg,
        total_points: r.total,
        active_students: r.active,
        is_my_school: !!mine && mine === r.name,
      }));
    return { week_start: w, week_end: addDays(w, 6), period, min_active_students: minActiveStudents, schools };
  }

  /** The student's own rank (in their school, else All of EdMira) and points for the last `count` weeks. */
  async history(userId: string, count = 8) {
    const me = new Types.ObjectId(userId);
    const hidden = await this.hiddenIds();
    const result = [];
    let week = weekOf(new Date());
    for (let i = 0; i < Math.min(Math.max(1, count), 26); i++, week = previousWeek(week)) {
      const row = await this.weeks.findOne({ week, studentId: me }).lean().exec();
      if (!row || row.points <= 0) {
        result.push({ week_start: week, rank: null, points: 0, scope: null });
        continue;
      }
      const scope = row.institution ? 'school' : 'all';
      const query: FilterQuery<LeaderboardWeek> = {
        week,
        points: { $gt: 0 },
        studentId: { $nin: hidden },
        ...(row.institution ? { institution: row.institution } : {}),
      };
      result.push({ week_start: week, rank: await this.rankOf(query, row as RankRow), points: row.points, scope });
    }
    return { weeks: result };
  }

  // ── Original API (GET /leaderboards, /leaderboards/schools), for older app builds ──

  async legacyBoard(userId: string, scope: LeaderboardScope, week = weekOf(new Date())) {
    const filter = await this.scopeFilter(scope, userId);
    if (!filter) {
      return { week, scope, entries: [], me: { rank: null, points: 0, nextTier: null }, totalStudents: 0, missingProfile: true };
    }
    const hidden = await this.hiddenIds();
    const query: FilterQuery<LeaderboardWeek> = { week, points: { $gt: 0 }, ...filter, studentId: { $nin: hidden } };
    const me = new Types.ObjectId(userId);
    const [{ rows, total }, blocked, mine] = await Promise.all([
      this.cachedPage(query, 0, TOP_N),
      this.blockedIds(me),
      this.weeks.findOne({ week, studentId: me, ...filter }).lean().exec(),
    ]);
    const entries: PublicEntry[] = rows.map((r, i) => {
      const isMe = r.studentId === userId;
      const anonymous = !isMe && blocked.has(r.studentId);
      return {
        rank: i + 1,
        username: anonymous ? null : r.username,
        anonymous,
        school: schoolShortName(r.institution),
        level: r.level ?? '',
        points: r.points,
        isMe,
      };
    });
    const rank = mine && mine.points > 0 ? await this.rankOf(query, mine as RankRow) : null;
    return {
      week,
      scope,
      entries,
      me: { rank, points: mine?.points ?? 0, nextTier: rank ? await this.nextTier(query, rank, mine!.points) : null },
      totalStudents: total,
    };
  }

  /** School against school, in the original shape (`students` = active students). */
  async schools(week = weekOf(new Date())) {
    const board = await this.schoolsBoard(null, 'this_week', week);
    return {
      week,
      schools: board.schools.map(s => ({
        rank: s.rank,
        school: s.school_short,
        name: s.school_name,
        totalPoints: s.total_points,
        students: s.active_students,
        averagePoints: Math.round(s.avg_points),
      })),
    };
  }

  /** The numbers share cards and the Progress screen show, computed on the server. */
  async summary(userId: string) {
    const id = new Types.ObjectId(userId);
    const [streak, mastered, thisWeek] = await Promise.all([
      this.study.streakFor(userId),
      this.attempts.aggregate<{ count: number }>([
        // "Retry weak questions" runs only hold the missed questions: not a mastery score.
        { $match: { studentId: id, retry: { $ne: true } } },
        { $group: { _id: '$topicId', best: { $max: '$score' } } },
        { $match: { best: { $gte: MASTERY_SCORE } } },
        { $count: 'count' },
      ]),
      this.legacyBoard(userId, 'all'),
    ]);
    return {
      streakDays: streak.current,
      topicsMastered: mastered[0]?.count ?? 0,
      week: thisWeek.week,
      weekPoints: thisWeek.me.points,
      weekRank: thisWeek.me.rank,
      weekStudents: thisWeek.totalStudents,
    };
  }

  /**
   * Home's leaderboard line: the student's rank in their school this week (All
   * of EdMira if no school), and the points to the next place. null if unranked.
   */
  async teaser(userId: string, week = weekOf(new Date())) {
    const me = await this.users.findById(userId).select('studentProfile').lean().exec();
    const academics = academicsOf(me);
    const scope = academics.institution ? 'school' : 'all';
    const hidden = await this.hiddenIds();
    const query: FilterQuery<LeaderboardWeek> = {
      week,
      points: { $gt: 0 },
      studentId: { $nin: hidden },
      ...(academics.institution ? { institution: academics.institution } : {}),
    };
    const mine = await this.weeks.findOne({ week, studentId: new Types.ObjectId(userId) }).lean().exec();
    if (!mine || mine.points <= 0) return null;
    const [rank, totalRanked] = await Promise.all([this.rankOf(query, mine as RankRow), this.weeks.countDocuments(query).exec()]);
    const above = rank > 1 ? await this.weeks.findOne(query).sort(SORT).skip(rank - 2).select('points').lean().exec() : null;
    return {
      scope,
      school: scope === 'school' ? schoolShortName(academics.institution) : null,
      rank,
      totalRanked,
      pointsThisWeek: mine.points,
      pointsToNextRank: above ? Math.max(1, above.points - mine.points + 1) : null,
    };
  }

  // ── What admins see (names included, for prizes) ───────────────────────────

  async adminBoard(week: string, filter: Academics & { q?: string }, limit = 50) {
    const query: FilterQuery<LeaderboardWeek> = { week };
    for (const key of ['institution', 'department', 'level'] as const) if (filter[key]) query[key] = filter[key];
    if (filter.q?.trim()) {
      const pattern = new RegExp(`^${filter.q.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      const matches = await this.users.find({ usernameLower: pattern }).select('_id').limit(200).lean().exec();
      query.studentId = { $in: matches.map(m => m._id) };
    }
    const rows = await this.weeks.find(query).sort(SORT).limit(limit).lean().exec();
    const owners = await this.users
      .find({ _id: { $in: rows.map(r => r.studentId) } })
      .select('username firstName lastName email privacy status leaderboardExclusion')
      .lean()
      .exec();
    const byId = new Map(owners.map(o => [String(o._id), o]));
    return {
      week,
      totalStudents: await this.weeks.countDocuments(query).exec(),
      entries: rows.map((r, i) => {
        const o = byId.get(String(r.studentId));
        return {
          rank: i + 1,
          studentId: String(r.studentId),
          username: o?.username ?? '',
          name: [o?.firstName, o?.lastName].filter(Boolean).join(' '),
          email: o?.email ?? '',
          showsOnLeaderboards: o?.privacy?.showOnLeaderboard !== false,
          suspended: o?.status === AccountStatus.SUSPENDED || o?.status === AccountStatus.BANNED,
          excluded: !!o?.leaderboardExclusion,
          exclusionReason: o?.leaderboardExclusion?.reason ?? null,
          school: schoolShortName(r.institution),
          institution: r.institution ?? '',
          department: r.department ?? '',
          level: r.level ?? '',
          points: r.points,
          correct: r.correct,
          quizzes: r.quizzes,
          improvements: r.improvements,
          activeDays: r.activeDays,
        };
      }),
    };
  }

  /** Top 3 of All of EdMira for each of the last `count` weeks (this week first), visible students only. */
  async winners(count = 8) {
    const hidden = new Set((await this.hiddenIds()).map(String));
    const result = [];
    let week = weekOf(new Date());
    for (let i = 0; i < count; i++, week = previousWeek(week)) {
      const board = await this.adminBoard(week, {}, 20);
      result.push({
        week,
        totalStudents: board.totalStudents,
        winners: board.entries.filter(e => !hidden.has(e.studentId)).slice(0, 3).map((e, j) => ({ ...e, rank: j + 1 })),
      });
    }
    return result;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Rows a tab covers; null when the profile lacks what the tab needs (e.g. no school yet). */
  async scopeFilter(scope: BoardScope | LeaderboardScope, userId: string): Promise<FilterQuery<LeaderboardWeek> | null> {
    const user = await this.users.findById(userId).select('studentProfile').lean().exec();
    const me = academicsOf(user);
    switch (scope) {
      case 'all':
        return {};
      case 'level':
        return me.level ? { level: me.level } : null;
      case 'school':
        return me.institution ? { institution: me.institution } : null;
      case 'department':
        return me.department ? { department: me.department } : null;
      case 'course':
        return me.institution && me.department && me.level
          ? { institution: me.institution, department: me.department, level: me.level }
          : null;
      case 'friends': {
        const id = new Types.ObjectId(userId);
        const rows = await this.connections
          .find({ status: 'accepted', $or: [{ requesterId: id }, { recipientId: id }] })
          .select('requesterId recipientId')
          .lean()
          .exec();
        const blocked = await this.blockedIds(id);
        const friends = rows
          .map(r => (String(r.requesterId) === userId ? r.recipientId : r.requesterId))
          .filter(f => !blocked.has(String(f)));
        return { studentId: { $in: [id, ...friends] } };
      }
    }
  }

  private async blockedIds(me: Types.ObjectId) {
    const rows = await this.blocks.find({ $or: [{ blockerId: me }, { blockedId: me }] }).lean().exec();
    return new Set(rows.map(b => String(String(b.blockerId) === String(me) ? b.blockedId : b.blockerId)));
  }

  /** One page of a board (with usernames), cached for a minute or until anyone earns points. */
  private async cachedPage(query: FilterQuery<LeaderboardWeek>, offset: number, limit: number) {
    const key = `lb:${this.version}:${createHash('sha1').update(JSON.stringify(query)).digest('hex')}:${offset}:${limit}`;
    const hit = await this.cache.get<{ rows: CachedRow[]; total: number }>(key).catch(() => undefined);
    if (hit) return hit;
    const [docs, total] = await Promise.all([
      this.weeks.find(query).sort(SORT).skip(offset).limit(limit).lean().exec(),
      this.weeks.countDocuments(query).exec(),
    ]);
    const owners = await this.users.find({ _id: { $in: docs.map(d => d.studentId) } }).select('username').lean().exec();
    const names = new Map(owners.map(o => [String(o._id), o.username ?? null]));
    const page = {
      rows: docs
        .filter(d => names.has(String(d.studentId)))
        .map(d => ({
          studentId: String(d.studentId),
          points: d.points,
          activeDays: d.activeDays ?? 0,
          institution: d.institution,
          level: d.level,
          username: names.get(String(d.studentId)) ?? null,
        })),
      total,
    };
    await this.cache.set(key, page, PAGE_CACHE_MS).catch(() => undefined);
    return page;
  }

  /** 1 + how many are ahead, using the full ranking order. */
  async rankOf(query: FilterQuery<LeaderboardWeek>, row: RankRow) {
    const days = row.activeDays ?? 0;
    const correct = row.correct ?? 0;
    const ahead = await this.weeks
      .countDocuments({
        ...query,
        $or: [
          { points: { $gt: row.points } },
          { points: row.points, activeDays: { $gt: days } },
          { points: row.points, activeDays: days, correct: { $gt: correct } },
          { points: row.points, activeDays: days, correct, reachedAt: { $lt: row.reachedAt } },
          { points: row.points, activeDays: days, correct, reachedAt: row.reachedAt, _id: { $lt: row._id } },
        ],
      })
      .exec();
    return ahead + 1;
  }

  /** "12 points to the top 30": the next tier above `rank`, and the points it takes. */
  private async nextTier(query: FilterQuery<LeaderboardWeek>, rank: number, points: number) {
    const tier = [...TIERS].reverse().find(t => t < rank);
    if (!tier) return null;
    const holder = await this.weeks.findOne(query).sort(SORT).skip(tier - 1).select('points').lean().exec();
    return holder ? { rank: tier, pointsNeeded: Math.max(1, holder.points - points + 1) } : null;
  }
}

const academicsOf = (user: { studentProfile?: Academics } | null): Academics => {
  const p = user?.studentProfile;
  return { institution: p?.institution || undefined, department: p?.department || undefined, level: p?.level || undefined };
};

/** The student's own row lookup must not use the friends $in (they're always in it anyway). */
const omitStudent = (filter: FilterQuery<LeaderboardWeek>) => {
  const { studentId: _ignored, ...rest } = filter;
  return rest;
};

const emptyMe = () => ({
  rank: null as number | null,
  points: 0,
  study_days: 0,
  points_to_next_rank: null as number | null,
  next_rank_username: null as string | null,
  percentile: null as number | null,
  hidden: false,
});
