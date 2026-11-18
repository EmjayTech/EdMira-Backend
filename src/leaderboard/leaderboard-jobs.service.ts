import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { QuizAttempt, QuizAttemptDocument } from '../quiz/quiz-attempt.schema';
import { schoolShortName } from '../reference/school-short-names';
import { Notification, NotificationDocument } from '../social/schemas/notification.schema';
import { IntegrityFlag, IntegrityFlagDocument } from '../study/schemas/integrity-flag.schema';
import { PointsEntry, PointsEntryDocument } from '../study/schemas/points-ledger.schema';
import { StudyDay, StudyDayDocument } from '../study/schemas/study-day.schema';
import { lagosMinutes, StudyJobsService } from '../study/study-jobs.service';
import { PointsEvent, StudyService } from '../study/study.service';
import { User, UserDocument } from '../users/model/user.model';
import { LeaderboardWeek, LeaderboardWeekDocument } from './leaderboard-week.schema';
import { LeaderboardWinner, LeaderboardWinnerDocument, WinnerScope } from './leaderboard-winner.schema';
import { LeaderboardService, SORT } from './leaderboard.service';
import { lagosDay, previousWeek, weekOf, weekRange } from './week';

/** Saved per board when a week closes. */
export const WINNERS_PER_BOARD = 10;
/** "Overtaken" messages only for a school's top 10. */
const OVERTAKE_TOP = 10;
/** Weekly results go out from 09:00 Lagos on Monday. */
const RESULTS_AFTER_MS = 9 * 60 * 60_000;

/** Anomaly thresholds (flags for admin review, never automatic bans). */
export const ANOMALY = {
  pointsPerHour: 300,
  accuracy: 0.95,
  questionsPerDay: 200,
  accountsPerNetwork: 3,
  networkTop: 20,
} as const;

/**
 * Leaderboard background work:
 *  - Monday 00:00 Lagos: close last week (recount, save the top 10 of every board)
 *  - Monday 09:00: "Last week you finished #8 in UNILAG" to everyone ranked
 *  - after points are earned: "someone passed you" (school top 10, max 1 a day)
 *    and anomaly flags (fast point bursts, near-perfect accuracy at volume)
 *  - nightly: several accounts on one network climbing one school's board
 */
@Injectable()
export class LeaderboardJobsService implements OnModuleInit {
  private readonly logger = new Logger(LeaderboardJobsService.name);

  constructor(
    @InjectModel(LeaderboardWeek.name) private readonly weeks: Model<LeaderboardWeekDocument>,
    @InjectModel(LeaderboardWinner.name) private readonly winners: Model<LeaderboardWinnerDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Notification.name) private readonly notifications: Model<NotificationDocument>,
    @InjectModel(IntegrityFlag.name) private readonly flags: Model<IntegrityFlagDocument>,
    @InjectModel(PointsEntry.name) private readonly ledger: Model<PointsEntryDocument>,
    @InjectModel(StudyDay.name) private readonly days: Model<StudyDayDocument>,
    @InjectModel(QuizAttempt.name) private readonly attempts: Model<QuizAttemptDocument>,
    private readonly leaderboards: LeaderboardService,
    private readonly study: StudyService,
    private readonly jobs: StudyJobsService,
  ) {}

  onModuleInit() {
    this.study.onPointsAdded(event => this.afterPoints(event));
    this.jobs.register({
      name: 'leaderboard-close',
      // As soon as a new week starts, last week is final.
      runKey: now => previousWeek(weekOf(now)),
      run: now => this.closeWeek(previousWeek(weekOf(now))),
    });
    this.jobs.register({
      name: 'leaderboard-results',
      runKey: now => (now.getTime() - weekRange(weekOf(now)).start.getTime() >= RESULTS_AFTER_MS ? previousWeek(weekOf(now)) : null),
      run: now => this.sendWeeklyResults(previousWeek(weekOf(now))),
    });
    this.jobs.register({
      name: 'shared-network-check',
      runKey: now => (lagosMinutes(now) >= 20 ? lagosDay(now) : null),
      run: now => this.checkSharedNetworks(weekOf(now)),
    });
  }

  // ── Closing a week ─────────────────────────────────────────────────────────

  /** Recount the week, then save the final top 10 of every board. Safe to re-run. */
  async closeWeek(week: string) {
    await this.study.reconcileWeek(week);
    const hidden = await this.leaderboards.hiddenIds();
    const visible: FilterQuery<LeaderboardWeek> = { week, points: { $gt: 0 }, studentId: { $nin: hidden } };
    const boards: { scopeType: WinnerScope; scopeId: string; filter: FilterQuery<LeaderboardWeek> }[] = [
      { scopeType: 'all', scopeId: '', filter: {} },
    ];
    for (const field of ['institution', 'level', 'department'] as const) {
      const values: string[] = (await this.weeks.distinct(field, visible)).filter(Boolean);
      const scopeType: WinnerScope = field === 'institution' ? 'school' : field;
      for (const value of values) boards.push({ scopeType, scopeId: value, filter: { [field]: value } });
    }

    let saved = 0;
    for (const board of boards) {
      const rows = await this.weeks.find({ ...visible, ...board.filter }).sort(SORT).limit(WINNERS_PER_BOARD).lean().exec();
      const names = await this.usernames(rows.map(r => r.studentId));
      saved += await this.save(
        rows.map((r, i) => ({
          week,
          scopeType: board.scopeType,
          scopeId: board.scopeId,
          rank: i + 1,
          userId: r.studentId,
          username: names.get(String(r.studentId)) ?? '',
          points: r.points,
          studyDays: r.activeDays,
        })),
      );
    }

    const schools = await this.leaderboards.schoolsBoard(null, 'this_week', week);
    saved += await this.save(
      schools.schools.slice(0, WINNERS_PER_BOARD).map(s => ({
        week,
        scopeType: 'schools' as const,
        scopeId: s.school_name,
        rank: s.rank,
        points: s.avg_points,
        activeStudents: s.active_students,
        totalPoints: s.total_points,
      })),
    );
    return { week, boards: boards.length + 1, saved };
  }

  private async save(docs: Partial<LeaderboardWinner>[]) {
    if (!docs.length) return 0;
    try {
      const res = await this.winners.insertMany(docs, { ordered: false });
      return res.length;
    } catch (error) {
      // Re-running the close: rows already saved are kept as they were.
      if (error?.code !== 11000 && !error?.writeErrors) throw error;
      return error?.insertedDocs?.length ?? 0;
    }
  }

  /** Monday 09:00: one inbox message per student ranked last week, with their school rank. */
  async sendWeeklyResults(week: string) {
    const hidden = await this.leaderboards.hiddenIds();
    const rows = await this.weeks.find({ week, points: { $gt: 0 }, studentId: { $nin: hidden } }).sort(SORT).lean().exec();
    const users = await this.users.find({ _id: { $in: rows.map(r => r.studentId) } }).select('privacy role').lean().exec();
    const muted = new Set(users.filter(u => u.privacy?.muteLeaderboardNotifications || u.role).map(u => String(u._id)));
    const known = new Set(users.map(u => String(u._id)));

    // Rank inside each school (or All of EdMira for students without one).
    const counters = new Map<string, number>();
    const messages = [];
    for (const r of rows) {
      const group = r.institution ?? '';
      const rank = (counters.get(group) ?? 0) + 1;
      counters.set(group, rank);
      if (!known.has(String(r.studentId)) || muted.has(String(r.studentId))) continue;
      messages.push({
        userId: r.studentId,
        type: 'leaderboard_weekly' as const,
        refId: week,
        data: { rank, school: group ? schoolShortName(group) || group : '', week },
      });
    }
    if (messages.length) await this.notifications.insertMany(messages);
    return { week, sent: messages.length };
  }

  // ── After points are earned ────────────────────────────────────────────────

  private async afterPoints(event: PointsEvent) {
    await this.checkAnomalies(event);
    if (event.week === weekOf(new Date())) await this.notifyOvertaken(event);
  }

  /**
   * "Someone passed you": students in the same school's top 10 that this
   * student just moved past. At most one such message a day each; never for
   * students who muted leaderboard messages; nothing if the mover is hidden.
   */
  async notifyOvertaken(event: PointsEvent) {
    const me = new Types.ObjectId(event.userId);
    const mine = await this.weeks.findOne({ week: event.week, studentId: me }).lean().exec();
    if (!mine?.institution || event.points <= 0) return;
    const hidden = await this.leaderboards.hiddenIds();
    if (hidden.some(h => h.equals(me))) return;
    const before = mine.points - event.points;
    const school: FilterQuery<LeaderboardWeek> = {
      week: event.week,
      institution: mine.institution,
      points: { $gt: 0 },
      studentId: { $nin: hidden },
    };
    const passed = await this.weeks
      .find({ ...school, studentId: { $nin: [...hidden, me] }, points: { $gte: before, $lt: mine.points } })
      .sort(SORT)
      .limit(OVERTAKE_TOP)
      .lean()
      .exec();
    if (!passed.length) return;

    const users = await this.users.find({ _id: { $in: passed.map(p => p.studentId) } }).select('privacy').lean().exec();
    const muted = new Set(users.filter(u => u.privacy?.muteLeaderboardNotifications).map(u => String(u._id)));
    const dayStart = new Date(Date.parse(`${lagosDay(new Date())}T00:00:00+01:00`));
    for (const p of passed) {
      if (muted.has(String(p.studentId))) continue;
      const rank = await this.leaderboards.rankOf(school, p as never);
      if (rank > OVERTAKE_TOP + 1) continue; // wasn't in the top 10
      const already = await this.notifications.exists({
        userId: p.studentId,
        type: 'leaderboard_overtaken',
        createdAt: { $gte: dayStart },
      });
      if (already) continue;
      await this.notifications.create({ userId: p.studentId, type: 'leaderboard_overtaken', fromId: me, data: { rank } });
    }
  }

  /** Flags for admins: a burst of points in an hour, or near-perfect accuracy at volume. */
  async checkAnomalies(event: PointsEvent) {
    const userId = new Types.ObjectId(event.userId);
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    const [recent] = await this.ledger.aggregate<{ total: number }>([
      // Study points only: a burst of referral rewards is checked separately.
      { $match: { userId, occurredAt: { $gte: hourAgo }, sourceType: { $ne: 'referral' } } },
      { $group: { _id: null, total: { $sum: '$points' } } },
    ]);
    if ((recent?.total ?? 0) > ANOMALY.pointsPerHour) {
      const hour = new Date().toISOString().slice(0, 13);
      await this.flag(userId, 'points_burst', `${event.userId}:${hour}`, { points: recent.total, inMinutes: 60 });
    }
    const day = await this.days.findOne({ userId, day: event.day }).lean().exec();
    if (
      day &&
      day.questionsAnswered >= ANOMALY.questionsPerDay &&
      day.correctAnswers / day.questionsAnswered >= ANOMALY.accuracy
    ) {
      await this.flag(userId, 'high_accuracy', `${event.userId}:${event.day}`, {
        answered: day.questionsAnswered,
        correct: day.correctAnswers,
        day: event.day,
      });
    }
  }

  /** Nightly: 3+ accounts quizzing from one network, all in the same school's top 20 this week. */
  async checkSharedNetworks(week: string) {
    const { start, end } = weekRange(week);
    const groups = await this.attempts.aggregate<{ _id: string; students: Types.ObjectId[] }>([
      { $match: { submittedAt: { $gte: start, $lt: end }, ipHash: { $type: 'string' } } },
      { $group: { _id: '$ipHash', students: { $addToSet: '$studentId' } } },
      { $match: { [`students.${ANOMALY.accountsPerNetwork - 1}`]: { $exists: true } } },
    ]);
    const hidden = await this.leaderboards.hiddenIds();
    let flagged = 0;
    for (const g of groups) {
      const rows = await this.weeks.find({ week, studentId: { $in: g.students }, institution: { $type: 'string' } }).lean().exec();
      const bySchool = new Map<string, typeof rows>();
      for (const r of rows) bySchool.set(r.institution!, [...(bySchool.get(r.institution!) ?? []), r]);
      for (const [school, members] of bySchool) {
        if (members.length < ANOMALY.accountsPerNetwork) continue;
        const top = await this.weeks
          .find({ week, institution: school, points: { $gt: 0 }, studentId: { $nin: hidden } })
          .sort(SORT)
          .limit(ANOMALY.networkTop)
          .select('studentId')
          .lean()
          .exec();
        const topIds = new Set(top.map(t => String(t.studentId)));
        const climbing = members.filter(m => topIds.has(String(m.studentId)));
        if (climbing.length < ANOMALY.accountsPerNetwork) continue;
        const names = await this.usernames(climbing.map(c => c.studentId));
        await this.flag(climbing[0].studentId, 'shared_network', `${week}:${g._id}:${school}`, {
          school: schoolShortName(school) || school,
          usernames: climbing.map(c => names.get(String(c.studentId)) ?? '?'),
          week,
        });
        flagged += 1;
      }
    }
    return { week, networks: groups.length, flagged };
  }

  private async flag(userId: Types.ObjectId, kind: IntegrityFlag['kind'], sourceId: string, detail: Record<string, unknown>) {
    await this.flags
      .updateOne({ kind, sourceId }, { $setOnInsert: { userId, status: 'open', detail } }, { upsert: true })
      .exec()
      .catch(error => {
        if (error?.code !== 11000) this.logger.warn(`Couldn't flag ${kind}: ${error?.message ?? error}`);
      });
  }

  private async usernames(ids: Types.ObjectId[]) {
    const users = await this.users.find({ _id: { $in: ids } }).select('username').lean().exec();
    return new Map(users.map(u => [String(u._id), u.username ?? '']));
  }
}
