import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { schoolShortName } from '../reference/school-short-names';
import { IntegrityFlag, IntegrityFlagDocument } from '../study/schemas/integrity-flag.schema';
import { PointsEntry, PointsEntryDocument } from '../study/schemas/points-ledger.schema';
import { StudyService } from '../study/study.service';
import { User, UserDocument } from '../users/model/user.model';
import { LeaderboardWeek, LeaderboardWeekDocument } from './leaderboard-week.schema';
import { LeaderboardWinner, LeaderboardWinnerDocument } from './leaderboard-winner.schema';
import { LeaderboardService } from './leaderboard.service';
import { addDays, lagosDay, previousWeek, weekOf, weekRange } from './week';

export const FLAG_ACTIONS = ['dismiss', 'exclude', 'reset'] as const;
export type FlagAction = (typeof FLAG_ACTIONS)[number];

/**
 * Admin tools for leaderboards (names included — admins only): the flags
 * queue, excluding a student, resetting a student's week, saved winners and
 * whether viewing the board goes with studying more. The controller writes
 * every action to the Activity log.
 */
@Injectable()
export class LeaderboardAdminService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(IntegrityFlag.name) private readonly flags: Model<IntegrityFlagDocument>,
    @InjectModel(PointsEntry.name) private readonly ledger: Model<PointsEntryDocument>,
    @InjectModel(LeaderboardWeek.name) private readonly weeks: Model<LeaderboardWeekDocument>,
    @InjectModel(LeaderboardWinner.name) private readonly winners: Model<LeaderboardWinnerDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly leaderboards: LeaderboardService,
    private readonly study: StudyService,
  ) {}

  // ── Flags ──────────────────────────────────────────────────────────────────

  async listFlags(status: 'open' | 'closed' = 'open') {
    const rows = await this.flags
      .find(status === 'open' ? { status: 'open' } : { status: { $ne: 'open' } })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean()
      .exec();
    const people = await this.people(rows.map(r => r.userId));
    return rows.map(r => ({
      id: String(r._id),
      kind: r.kind,
      status: r.status,
      createdAt: (r as { createdAt?: Date }).createdAt?.toISOString() ?? null,
      detail: r.detail ?? {},
      resolution: r.resolution ? { ...r.resolution, at: r.resolution.at?.toISOString?.() ?? r.resolution.at } : null,
      student: people.get(String(r.userId)) ?? null,
    }));
  }

  async actOnFlag(flagId: string, action: FlagAction, reason: string, staffName: string) {
    const flag = await this.flags.findById(flagId).exec();
    if (!flag) throw new NotFoundException('Flag not found.');
    if (flag.status !== 'open') throw new BadRequestException('This flag has already been handled.');
    if (action === 'exclude') await this.setExclusion(String(flag.userId), true, reason, staffName);
    if (action === 'reset') await this.resetWeek(String(flag.userId), reason, staffName);
    flag.status = action === 'dismiss' ? 'dismissed' : 'actioned';
    flag.resolution = { action, reason: reason || undefined, by: staffName, at: new Date() };
    await flag.save();
    return { ok: true, studentId: String(flag.userId) };
  }

  // ── Students ───────────────────────────────────────────────────────────────

  /** Remove a student from (or return them to) every leaderboard. They still see their own rank. */
  async setExclusion(studentId: string, excluded: boolean, reason: string, staffName: string) {
    if (excluded && !reason?.trim()) throw new BadRequestException('Please give a reason.');
    const update = excluded
      ? { $set: { leaderboardExclusion: { reason: reason.trim(), by: staffName, at: new Date() } } }
      : { $unset: { leaderboardExclusion: 1 } };
    const res = await this.users.updateOne({ _id: new Types.ObjectId(studentId), role: { $exists: false } }, update).exec();
    if (!res.matchedCount) throw new NotFoundException('Student not found.');
    this.leaderboards.forgetHidden();
    return { excluded };
  }

  /**
   * Take a student's points for this week back to 0 (a negative "adjustment"
   * in the ledger, so the history stays). Later quizzes count as normal.
   */
  async resetWeek(studentId: string, reason: string, staffName: string, week = weekOf(new Date())) {
    if (!reason?.trim()) throw new BadRequestException('Please give a reason.');
    const userId = new Types.ObjectId(studentId);
    if (!(await this.users.exists({ _id: userId }))) throw new NotFoundException('Student not found.');
    const [current] = await this.ledger.aggregate<{ total: number }>([
      { $match: { userId, week, leaderboard: { $ne: false } } },
      { $group: { _id: null, total: { $sum: '$points' } } },
    ]);
    const total = current?.total ?? 0;
    if (total > 0) {
      const now = new Date();
      await this.ledger.create({
        userId,
        occurredAt: now,
        day: lagosDay(now),
        week,
        sourceType: 'adjustment',
        sourceId: `${studentId}:${week}:${now.getTime()}`,
        points: -total,
        requested: -total,
        meta: { reason: reason.trim(), by: staffName, kind: 'weekly_reset' },
      });
    }
    await this.study.reconcileWeek(week);
    this.leaderboards.forgetHidden();
    return { week, removed: total };
  }

  // ── Winners and insights ───────────────────────────────────────────────────

  /** The saved top 10s for a closed week (default: last week), names included for prizes. */
  async savedWinners(week = previousWeek(weekOf(new Date())), scopeType?: string) {
    const rows = await this.winners
      .find({ week, ...(scopeType ? { scopeType } : {}) })
      .sort({ scopeType: 1, scopeId: 1, rank: 1 })
      .lean()
      .exec();
    const people = await this.people(rows.map(r => r.userId).filter(Boolean) as Types.ObjectId[]);
    return {
      week,
      winners: rows.map(r => ({
        scopeType: r.scopeType,
        scopeId: r.scopeId,
        scopeLabel: r.scopeType === 'school' || r.scopeType === 'schools' ? schoolShortName(r.scopeId) || r.scopeId : r.scopeId,
        rank: r.rank,
        username: r.username ?? null,
        points: r.points,
        studyDays: r.studyDays ?? null,
        activeStudents: r.activeStudents ?? null,
        totalPoints: r.totalPoints ?? null,
        student: r.userId ? people.get(String(r.userId)) ?? null : null,
      })),
    };
  }

  /**
   * For each closed week: students on the board, and the average study days
   * the next week of students who viewed the leaderboard vs those who didn't
   * (among students who studied that week).
   */
  async insights(count = 8) {
    const events = this.connection.collection('analytics_events');
    const result = [];
    let week = previousWeek(weekOf(new Date()));
    for (let i = 0; i < Math.min(count, 26); i++, week = previousWeek(week)) {
      const next = addDays(week, 7);
      const { start, end } = weekRange(week);
      const [onBoard, active, viewerIds] = await Promise.all([
        this.weeks.countDocuments({ week, points: { $gt: 0 } }).exec(),
        this.weeks.find({ week, activeDays: { $gte: 1 } }).select('studentId').lean().exec(),
        events.distinct('userId', { name: 'leaderboard_viewed', createdAt: { $gte: start, $lt: end } }),
      ]);
      const viewers = new Set(viewerIds.map(String));
      const nextRows = await this.weeks
        .find({ week: next, studentId: { $in: active.map(a => a.studentId) } })
        .select('studentId activeDays')
        .lean()
        .exec();
      const nextDays = new Map(nextRows.map(r => [String(r.studentId), r.activeDays ?? 0]));
      const avg = (ids: string[]) =>
        ids.length ? Math.round((ids.reduce((t, id) => t + (nextDays.get(id) ?? 0), 0) / ids.length) * 10) / 10 : null;
      const activeIds = active.map(a => String(a.studentId));
      const viewed = activeIds.filter(id => viewers.has(id));
      const didnt = activeIds.filter(id => !viewers.has(id));
      result.push({
        week,
        onBoard,
        activeStudents: activeIds.length,
        viewers: viewed.length,
        viewersNextWeekStudyDays: avg(viewed),
        othersNextWeekStudyDays: avg(didnt),
      });
    }
    return result;
  }

  private async people(ids: Types.ObjectId[]) {
    const users = await this.users
      .find({ _id: { $in: ids } })
      .select('username firstName lastName email studentProfile leaderboardExclusion')
      .lean()
      .exec();
    return new Map(
      users.map(u => [
        String(u._id),
        {
          id: String(u._id),
          username: u.username ?? '',
          name: [u.firstName, u.lastName].filter(Boolean).join(' '),
          email: u.email ?? '',
          school: schoolShortName(u.studentProfile?.institution) || u.studentProfile?.institution || '',
          excluded: !!u.leaderboardExclusion,
        },
      ]),
    );
  }
}
