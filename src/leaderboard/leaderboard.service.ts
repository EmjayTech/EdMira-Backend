import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { AccountStatus } from '../common/enum/staff-role.enum';
import { QuizAttempt, QuizAttemptDocument } from '../quiz/quiz-attempt.schema';
import { schoolShortName } from '../reference/school-short-names';
import { User, UserDocument } from '../users/model/user.model';
import { LeaderboardWeek, LeaderboardWeekDocument } from './leaderboard-week.schema';
import { ScoredAttempt, isTooFast, scoreWeek } from './scoring';
import { Block, BlockDocument } from '../social/schemas/block.schema';
import { lagosDay, previousWeek, streakDays, weekOf, weekRange } from './week';

export const LEADERBOARD_SCOPES = ['course', 'level', 'school', 'all'] as const;
export type LeaderboardScope = (typeof LEADERBOARD_SCOPES)[number];

/** How many students a leaderboard tab lists. */
export const TOP_N = 20;
/** Ranks we nudge students towards: "12 points to the top 30". */
const TIERS = [1, 3, 10, 20, 30, 50, 100];
/** A topic is mastered once the best score on it reaches this. */
export const MASTERY_SCORE = 80;

/** What everyone else may see about a student — never names, emails or phones. */
export interface PublicEntry {
  rank: number;
  /** null when the student turned "Show me on leaderboards" off. */
  username: string | null;
  anonymous: boolean;
  school: string;
  level: string;
  points: number;
  isMe: boolean;
}

type Academics = { institution?: string; department?: string; level?: string };

const SORT = { points: -1, reachedAt: 1, _id: 1 } as const;
const showsOnLeaderboards = (u?: Pick<User, 'privacy'> | null) => u?.privacy?.showOnLeaderboard !== false;

@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger(LeaderboardService.name);

  constructor(
    @InjectModel(LeaderboardWeek.name) private readonly weeks: Model<LeaderboardWeekDocument>,
    @InjectModel(QuizAttempt.name) private readonly attempts: Model<QuizAttemptDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Block.name) private readonly blocks: Model<BlockDocument>,
  ) {}

  // ── Keeping totals up to date ──────────────────────────────────────────────

  /**
   * Recount one student's week from their attempts. Called after every quiz
   * submission (never fails the submission) and by `yarn leaderboard rebuild`.
   */
  async recompute(studentId: string | Types.ObjectId, week = weekOf(new Date())) {
    const id = new Types.ObjectId(String(studentId));
    const user = await this.users.findById(id).select('role studentProfile').lean().exec();
    if (!user || user.role) return null; // staff don't compete

    const { start, end } = weekRange(week);
    const attempts = await this.attempts
      .find({ studentId: id, submittedAt: { $gte: start, $lt: end } })
      .select('topicId startedAt submittedAt total answeredCount score answers')
      .lean()
      .exec();

    const topicIds = [...new Set(attempts.map(a => String(a.topicId)))].map(t => new Types.ObjectId(t));
    const before = topicIds.length
      ? await this.attempts.aggregate<{ _id: Types.ObjectId; best: number }>([
          { $match: { studentId: id, topicId: { $in: topicIds }, submittedAt: { $lt: start } } },
          { $group: { _id: '$topicId', best: { $max: '$score' } } },
        ])
      : [];

    const score = scoreWeek(
      attempts.map<ScoredAttempt>(a => ({
        topicId: String(a.topicId),
        startedAt: a.startedAt,
        submittedAt: a.submittedAt,
        total: a.total,
        answeredCount: a.answeredCount,
        score: a.score,
        correctQuestionIds: (a.answers ?? []).filter(x => x.correct).map(x => String(x.questionId)),
      })),
      new Map(before.map(b => [String(b._id), b.best])),
    );

    const existing = await this.weeks.findOne({ week, studentId: id }).exec();
    if (!existing && score.points === 0) return null;
    const row = existing ?? new this.weeks({ week, studentId: id, reachedAt: new Date() });
    if (score.points > (existing?.points ?? 0)) row.reachedAt = new Date();
    row.set({ ...score, ...this.academicsOf(user) });
    return row.save();
  }

  /** Safe wrapper for the quiz submission path: a scoring problem must never lose an attempt. */
  async recomputeQuietly(studentId: string | Types.ObjectId) {
    try {
      await this.recompute(studentId);
    } catch (error) {
      this.logger.error(`Couldn't update the leaderboard for ${studentId}: ${error?.message ?? error}`);
    }
  }

  /** After Edit profile: move this week's row to the new school / programme / level. */
  async syncAcademics(studentId: string | Types.ObjectId) {
    const user = await this.users.findById(studentId).select('studentProfile').lean().exec();
    if (!user) return;
    await this.weeks
      .updateOne({ week: weekOf(new Date()), studentId: new Types.ObjectId(String(studentId)) }, { $set: this.academicsOf(user) })
      .exec();
  }

  /** Recount every student who practised in `week` (formula change, first deploy). */
  async rebuildWeek(week: string) {
    const { start, end } = weekRange(week);
    const ids: Types.ObjectId[] = await this.attempts.distinct('studentId', { submittedAt: { $gte: start, $lt: end } });
    for (const id of ids) await this.recompute(id, week);
    return { week, students: ids.length };
  }

  // ── What students see ──────────────────────────────────────────────────────

  /** One leaderboard tab: the top 20, plus where the student stands. */
  async board(userId: string, scope: LeaderboardScope, week = weekOf(new Date())) {
    const me = await this.users.findById(userId).select('studentProfile').lean().exec();
    const filter = this.scopeFilter(scope, this.academicsOf(me));
    if (!filter) {
      return { week, scope, entries: [], me: { rank: null, points: 0, nextTier: null }, totalStudents: 0, missingProfile: true };
    }
    const query = { week, ...filter };

    const [rows, totalStudents, mine] = await Promise.all([
      this.weeks.find(query).sort(SORT).limit(TOP_N + 10).lean().exec(),
      this.weeks.countDocuments(query).exec(),
      this.weeks.findOne({ ...query, studentId: new Types.ObjectId(userId) }).lean().exec(),
    ]);

    const owners = await this.users
      .find({ _id: { $in: rows.map(r => r.studentId) } })
      .select('username privacy status')
      .lean()
      .exec();
    const byId = new Map(owners.map(o => [String(o._id), o]));
    // Students you blocked (or who blocked you) appear as "Anonymous student".
    const me_ = new Types.ObjectId(userId);
    const blockRows = await this.blocks.find({ $or: [{ blockerId: me_ }, { blockedId: me_ }] }).lean().exec();
    const blocked = new Set(blockRows.map(b => String(String(b.blockerId) === userId ? b.blockedId : b.blockerId)));
    const entries: PublicEntry[] = rows
      .filter(r => byId.get(String(r.studentId))?.status !== AccountStatus.SUSPENDED)
      .slice(0, TOP_N)
      .map((r, i) => {
        const owner = byId.get(String(r.studentId));
        const isMe = String(r.studentId) === userId;
        const visible = isMe || (showsOnLeaderboards(owner) && !blocked.has(String(r.studentId)));
        return {
          rank: i + 1,
          username: visible ? owner?.username ?? null : null,
          anonymous: !visible,
          school: schoolShortName(r.institution),
          level: r.level ?? '',
          points: r.points,
          isMe,
        };
      });

    const rank = mine ? await this.rankOf(query, mine) : null;
    return {
      week,
      scope,
      entries,
      me: { rank, points: mine?.points ?? 0, nextTier: rank ? await this.nextTier(query, rank, mine!.points) : null },
      totalStudents,
    };
  }

  /** School against school this week: total and average points per school. */
  async schools(week = weekOf(new Date())) {
    const rows = await this.weeks.aggregate<{ _id: string; total: number; students: number }>([
      { $match: { week, institution: { $type: 'string' } } },
      { $group: { _id: '$institution', total: { $sum: '$points' }, students: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ]);
    return {
      week,
      schools: rows.map((r, i) => ({
        rank: i + 1,
        school: schoolShortName(r._id) || r._id,
        name: r._id,
        totalPoints: r.total,
        students: r.students,
        averagePoints: Math.round(r.total / r.students),
      })),
    };
  }

  /** The numbers share cards and the Progress screen show, computed on the server. */
  async summary(userId: string) {
    const id = new Types.ObjectId(userId);
    const [recent, mastered, thisWeek] = await Promise.all([
      this.attempts.find({ studentId: id }).select('submittedAt startedAt total').sort({ submittedAt: -1 }).limit(1000).lean().exec(),
      this.attempts.aggregate<{ count: number }>([
        { $match: { studentId: id } },
        { $group: { _id: '$topicId', best: { $max: '$score' } } },
        { $match: { best: { $gte: MASTERY_SCORE } } },
        { $count: 'count' },
      ]),
      this.board(userId, 'all'),
    ]);
    const practised = recent
      .filter(a => !isTooFast({ ...a, answeredCount: 0, score: 0, topicId: '', correctQuestionIds: [] }))
      .map(a => lagosDay(a.submittedAt));
    return {
      streakDays: streakDays(practised),
      topicsMastered: mastered[0]?.count ?? 0,
      week: thisWeek.week,
      weekPoints: thisWeek.me.points,
      weekRank: thisWeek.me.rank,
      weekStudents: thisWeek.totalStudents,
    };
  }

  // ── What admins see (names included, for prizes) ───────────────────────────

  async adminBoard(week: string, filter: Academics, limit = 50) {
    const query: FilterQuery<LeaderboardWeek> = { week };
    for (const key of ['institution', 'department', 'level'] as const) if (filter[key]) query[key] = filter[key];
    const rows = await this.weeks.find(query).sort(SORT).limit(limit).lean().exec();
    const owners = await this.users
      .find({ _id: { $in: rows.map(r => r.studentId) } })
      .select('username firstName lastName email privacy status')
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
          showsOnLeaderboards: showsOnLeaderboards(o),
          suspended: o?.status === AccountStatus.SUSPENDED,
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

  /** Top 3 of All of EdMira for each of the last `count` weeks (this week first). */
  async winners(count = 8) {
    const result = [];
    let week = weekOf(new Date());
    for (let i = 0; i < count; i++, week = previousWeek(week)) {
      const board = await this.adminBoard(week, {}, 3);
      result.push({ week, totalStudents: board.totalStudents, winners: board.entries });
    }
    return result;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private academicsOf(user: { studentProfile?: Academics } | null): Academics {
    const p = user?.studentProfile;
    return { institution: p?.institution || undefined, department: p?.department || undefined, level: p?.level || undefined };
  }

  /** null when the profile lacks what the tab needs (e.g. no school yet). */
  private scopeFilter(scope: LeaderboardScope, me: Academics): FilterQuery<LeaderboardWeek> | null {
    switch (scope) {
      case 'all':
        return {};
      case 'level':
        return me.level ? { level: me.level } : null;
      case 'school':
        return me.institution ? { institution: me.institution } : null;
      case 'course':
        return me.institution && me.department && me.level
          ? { institution: me.institution, department: me.department, level: me.level }
          : null;
    }
  }

  private async rankOf(query: FilterQuery<LeaderboardWeek>, mine: { points: number; reachedAt: Date; _id: unknown }) {
    const ahead = await this.weeks
      .countDocuments({
        ...query,
        $or: [
          { points: { $gt: mine.points } },
          { points: mine.points, reachedAt: { $lt: mine.reachedAt } },
          { points: mine.points, reachedAt: mine.reachedAt, _id: { $lt: mine._id } },
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
