import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Cache } from 'cache-manager';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { LeaderboardWeek, LeaderboardWeekDocument } from '../leaderboard/leaderboard-week.schema';
import { addDays, lagosDay, weekOf, weekOfDay, weekRange } from '../leaderboard/week';
import { QuizAttempt, QuizAttemptDocument } from '../quiz/quiz-attempt.schema';
import { User, UserDocument } from '../users/model/user.model';
import { WEEKLY_GOAL } from './points-config';
import { SettingsService } from '../settings/settings.service';
import { Award, QuestionHistory, scoreQotd, scoreQuiz } from './points';
import { IntegrityFlag, IntegrityFlagDocument } from './schemas/integrity-flag.schema';
import { PointsEntry, PointsEntryDocument } from './schemas/points-ledger.schema';
import { QuestionStats, QuestionStatsDocument } from './schemas/question-stats.schema';
import { StudyDay, StudyDayDocument } from './schemas/study-day.schema';
import { TopicStats, TopicStatsDocument } from './schemas/topic-stats.schema';
import { UserStats, UserStatsDocument } from './schemas/user-stats.schema';
import { computeStreak, StreakInfo } from './streak';
import { inTransaction } from './transactions';

/** Study days looked at for the current streak (longest is kept in user_stats). */
const STREAK_WINDOW_DAYS = 400;
export const homeCacheKey = (userId: string | Types.ObjectId) => `home:summary:${String(userId)}`;

/** Sent after points are saved (after the transaction commits). */
export interface PointsEvent {
  userId: string;
  week: string;
  day: string;
  points: number;
}
type PointsListener = (event: PointsEvent) => Promise<void> | void;

/** What a quiz submission reports back to the app. */
export interface QuizPointsResult {
  points: number;
  breakdown: { type: Award['sourceType']; points: number }[];
  capped: boolean;
  tooFast: boolean;
  studyDay: boolean;
  streak: number;
  /** For the after-commit hooks. */
  week: string;
  day: string;
  /** This quiz earned the student's inviter their referral reward. */
  referral?: ReferralReward | null;
}

/** An inviter's +10, given when the student they invited completes a first quiz. */
export interface ReferralReward {
  inviterId: string;
  refereeId: string;
  points: number;
  /** Counted on the weekly leaderboard (false past the weekly limit / back-filled). */
  leaderboard: boolean;
  week: string;
  day: string;
}

export type ReferralListener = (reward: ReferralReward) => Promise<void> | void;

export interface WeekDay {
  date: string;
  studied: boolean;
  frozen: boolean;
  isToday: boolean;
  future: boolean;
}

type Academics = { institution?: string; department?: string; level?: string };
type StudentRef = { _id: Types.ObjectId; role?: string; studentProfile?: Academics };
type Session = ClientSession | undefined;

/**
 * Study activity: study days, streaks, the weekly goal and points (Part A).
 * Writes happen inside the caller's transaction (quiz submission, QOTD
 * answer) so a quiz is never stored without its points or vice versa.
 */
@Injectable()
export class StudyService {
  private readonly logger = new Logger(StudyService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(StudyDay.name) private readonly days: Model<StudyDayDocument>,
    @InjectModel(UserStats.name) private readonly stats: Model<UserStatsDocument>,
    @InjectModel(TopicStats.name) private readonly topics: Model<TopicStatsDocument>,
    @InjectModel(QuestionStats.name) private readonly questions: Model<QuestionStatsDocument>,
    @InjectModel(PointsEntry.name) private readonly ledger: Model<PointsEntryDocument>,
    @InjectModel(IntegrityFlag.name) private readonly flags: Model<IntegrityFlagDocument>,
    @InjectModel(LeaderboardWeek.name) private readonly weeks: Model<LeaderboardWeekDocument>,
    @InjectModel(QuizAttempt.name) private readonly attempts: Model<QuizAttemptDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly settings: SettingsService,
  ) {}

  // ── Recording activity (inside a transaction) ──────────────────────────────

  /**
   * Records one submitted quiz: question / topic history, the study day,
   * points, weekly totals and the streak. Idempotent: an attempt that already
   * has `scoredAt` is skipped. Returns null for staff accounts (they don't
   * compete) and already-scored attempts.
   */
  async recordQuiz(attemptId: Types.ObjectId | string, session: Session): Promise<QuizPointsResult | null> {
    const attempt = await this.attempts.findById(attemptId).session(session ?? null).exec();
    if (!attempt || attempt.scoredAt) return null;
    const user = await this.student(attempt.studentId, session);
    if (!user) {
      await this.attempts.updateOne({ _id: attempt._id }, { $set: { scoredAt: new Date(), points: 0 } }, { session }).exec();
      return null;
    }

    const userId = user._id;
    const at = attempt.submittedAt;
    const day = lagosDay(at);
    const week = weekOfDay(day);
    const answered = attempt.answers.filter(a => a.selectedIndex !== null);

    // Sequential on purpose: a transaction's session can't run operations in parallel.
    const dayRow = await this.days.findOne({ userId, day }).session(session ?? null).lean().exec();
    const questionRows = await this.questions
      .find({ userId, questionId: { $in: answered.map(a => a.questionId) } })
      .session(session ?? null)
      .lean()
      .exec();
    const topicRow = await this.topics.findOne({ userId, topicId: attempt.topicId }).session(session ?? null).lean().exec();

    const history = new Map<string, QuestionHistory>(
      questionRows.map(q => [
        String(q.questionId),
        { correctBefore: q.correct, triesToday: q.lastDay === day ? q.triesOnLastDay : 0 },
      ]),
    );
    const points = await this.settings.points();
    const topicAfterAverage = Math.round(((topicRow?.scoreSum ?? 0) + attempt.score) / ((topicRow?.attempts ?? 0) + 1));
    const score = scoreQuiz(
      {
        total: attempt.total,
        answeredCount: attempt.answeredCount,
        startedAt: attempt.startedAt,
        submittedAt: at,
        answers: attempt.answers.map(a => ({ questionId: String(a.questionId), selectedIndex: a.selectedIndex, correct: a.correct })),
        retry: !!attempt.retry,
      },
      {
        history,
        studyDayAlreadyEarned: !!dayRow?.studyDayEarned,
        pointsToday: dayRow?.points ?? 0,
        topicBefore: topicRow ? { attempts: topicRow.attempts, average: topicRow.average } : null,
        topicAfterAverage,
        improvedThisWeek: topicRow?.improvedWeek === week,
      },
      points,
    );

    // Topic history counts every attempt except "Retry weak questions" runs
    // (a retry of only the missed questions would inflate the average);
    // the app's Focus Areas skip them too.
    const scoreSum = (topicRow?.scoreSum ?? 0) + attempt.score;
    if (!attempt.retry) {
      await this.topics
        .updateOne(
          { userId, topicId: attempt.topicId },
          {
            $set: {
              courseId: attempt.courseId,
              topicTitle: attempt.topicTitle,
              courseTitle: attempt.courseTitle,
              attempts: (topicRow?.attempts ?? 0) + 1,
              scoreSum,
              average: topicAfterAverage,
              best: Math.max(topicRow?.best ?? 0, attempt.score),
              ...(!topicRow || topicRow.lastAt <= at ? { last: attempt.score, lastAt: at } : {}),
              ...(score.improved ? { improvedWeek: week } : {}),
            },
          },
          { upsert: true, session },
        )
        .exec();
    }

    let referral: ReferralReward | null = null;
    if (score.tooFast) {
      await this.flags
        .updateOne(
          { kind: 'too_fast_quiz', sourceId: String(attempt._id) },
          {
            $setOnInsert: {
              userId,
              status: 'open',
              detail: { secondsPerQuestion: score.secondsPerQuestion, answered: attempt.answeredCount, topic: attempt.topicTitle },
            },
          },
          { upsert: true, session },
        )
        .exec();
    } else {
      if (answered.length) {
        await this.questions.bulkWrite(
          answered.map(a => {
            const prev = questionRows.find(q => String(q.questionId) === String(a.questionId));
            const sameDay = prev?.lastDay === day;
            return {
              updateOne: {
                filter: { userId, questionId: a.questionId },
                update: {
                  $set: {
                    correct: (prev?.correct ?? 0) + (a.correct ? 1 : 0),
                    tries: (prev?.tries ?? 0) + 1,
                    lastDay: day,
                    triesOnLastDay: (sameDay ? prev!.triesOnLastDay : 0) + 1,
                  },
                },
                upsert: true,
              },
            };
          }),
          { session },
        );
      }

      const sourceIds: Record<Award['sourceType'], string> = {
        quiz_answers: String(attempt._id),
        quiz_complete: String(attempt._id),
        study_day: `${userId}:${day}`,
        improvement: `${userId}:${attempt.topicId}:${week}`,
        qotd: '',
        referral: '',
        adjustment: '',
      };
      await this.writeAwards(userId, at, day, week, score.awards.map(a => ({ ...a, sourceId: sourceIds[a.sourceType] })), session);

      // A "Retry weak questions" run isn't a study day or a completed quiz.
      const countsAsQuiz = score.completed && !attempt.retry;
      const studiedNow = countsAsQuiz;
      const flagsToSet = { ...(studiedNow ? { studied: true } : {}), ...(score.newStudyDay ? { studyDayEarned: true } : {}) };
      await this.days
        .updateOne(
          { userId, day },
          {
            $setOnInsert: { week },
            $inc: {
              quizzesCompleted: countsAsQuiz ? 1 : 0,
              questionsAnswered: attempt.answeredCount,
              correctAnswers: score.correctAnswers,
              points: score.points,
            },
            ...(Object.keys(flagsToSet).length ? { $set: flagsToSet } : {}),
          },
          { upsert: true, session },
        )
        .exec();

      await this.addToWeek(user, week, at, {
        points: score.points,
        correct: score.correctAnswers,
        quizzes: countsAsQuiz ? 1 : 0,
        activeDays: studiedNow && !dayRow?.studied ? 1 : 0,
        improvements: score.improved ? 1 : 0,
      }, session);

      // Their first completed quiz earns whoever invited them +10.
      if (countsAsQuiz) referral = await this.awardReferral(userId, at, session);
    }

    await this.attempts.updateOne({ _id: attempt._id }, { $set: { scoredAt: new Date(), points: score.points } }, { session }).exec();
    const streak = await this.refreshStreak(userId, day, session);

    return {
      points: score.points,
      breakdown: score.awards.filter(a => a.points > 0).map(a => ({ type: a.sourceType, points: a.points })),
      capped: score.capped,
      tooFast: score.tooFast,
      studyDay: score.newStudyDay,
      streak: streak.current,
      week,
      day,
      referral,
    };
  }

  // ── Referral rewards ──────────────────────────────────────────────────────

  /**
   * Gives `refereeId`'s inviter the referral reward, once ever (the invited
   * student's referral status moves pending → rewarded in this transaction).
   * Nothing for held / rejected referrals, banned or deleted accounts, staff
   * inviters, or a 0 setting. Only the first N a week count on the
   * leaderboard; the rest (and `lifetimeOnly` back-fills) are lifetime points.
   */
  async awardReferral(
    refereeId: Types.ObjectId | string,
    at: Date,
    session: Session,
    opts: { lifetimeOnly?: boolean; reason?: string } = {},
  ): Promise<ReferralReward | null> {
    const referee = await this.users
      .findById(refereeId)
      .select('referredBy referral status deletedAt')
      .session(session ?? null)
      .lean()
      .exec();
    if (!referee?.referredBy || referee.deletedAt || referee.status === 'banned') return null;
    if (referee.referral && referee.referral.status !== 'pending') return null;
    const inviter = await this.users
      .findById(referee.referredBy)
      .select('role studentProfile status deletedAt')
      .session(session ?? null)
      .lean()
      .exec();
    if (!inviter || inviter.role || inviter.deletedAt || inviter.status === 'banned') return null;

    const config = await this.settings.points();
    const day = lagosDay(at);
    const week = weekOfDay(day);
    const counted = opts.lifetimeOnly
      ? Infinity
      : await this.ledger
          .countDocuments({ userId: inviter._id, week, sourceType: 'referral', leaderboard: { $ne: false } })
          .session(session ?? null)
          .exec();
    const leaderboard = counted < config.referralLeaderboardPerWeek;

    // Claim it first: a second quiz (or a race) finds it no longer pending.
    const claimed = await this.users
      .updateOne(
        { _id: referee._id, $or: [{ referral: { $exists: false } }, { 'referral.status': 'pending' }] },
        { $set: { referral: { status: 'rewarded', at, ...(opts.reason ? { reason: opts.reason } : {}) } } },
        { session },
      )
      .exec();
    if (!claimed.modifiedCount) return null;

    const points = Math.max(0, config.referral);
    if (points > 0) {
      await this.ledger.insertMany(
        [
          {
            userId: inviter._id,
            occurredAt: at,
            day,
            week,
            sourceType: 'referral',
            sourceId: String(referee._id),
            points,
            requested: points,
            leaderboard,
            ...(opts.reason ? { meta: { reason: opts.reason } } : {}),
          },
        ],
        { session },
      );
      if (leaderboard) await this.addToWeek(inviter as StudentRef, week, at, { points }, session);
    }
    return { inviterId: String(inviter._id), refereeId: String(referee._id), points, leaderboard, week, day };
  }

  private referralListeners: ReferralListener[] = [];

  /** Run `listener` after a referral reward is saved (the inviter's notification). */
  onReferralRewarded(listener: ReferralListener) {
    this.referralListeners.push(listener);
  }

  /** Call after the transaction that saved the reward has committed. Never throws. */
  async referralRewarded(reward: ReferralReward) {
    if (!reward.points) return;
    await this.invalidate(reward.inviterId);
    if (reward.leaderboard) {
      await this.pointsAdded({ userId: reward.inviterId, week: reward.week, day: reward.day, points: reward.points });
    }
    for (const listener of this.referralListeners) {
      try {
        await listener(reward);
      } catch (error) {
        this.logger.warn(`Referral listener failed: ${(error as Error)?.message ?? error}`);
      }
    }
  }

  /** A student's points ever (every ledger row, leaderboard or not). */
  async lifetimePoints(userId: string | Types.ObjectId) {
    const [row] = await this.ledger.aggregate<{ total: number }>([
      { $match: { userId: new Types.ObjectId(String(userId)) } },
      { $group: { _id: null, total: { $sum: '$points' } } },
    ]);
    return row?.total ?? 0;
  }

  /**
   * Records a Question of the Day answer: a study day (no +20 bonus: that's
   * for quizzes), +15 / +5 points, weekly totals and the streak. Returns the
   * points awarded.
   */
  async recordQotd(userId: Types.ObjectId, day: string, correct: boolean, at: Date, session: Session): Promise<number> {
    const user = await this.student(userId, session);
    if (!user) return 0;
    const week = weekOfDay(day);
    const dayRow = await this.days.findOne({ userId, day }).session(session ?? null).lean().exec();
    const award = scoreQotd(correct, dayRow?.points ?? 0, await this.settings.points());

    await this.writeAwards(userId, at, day, week, [{ ...award, sourceId: `${userId}:${day}` }], session);
    await this.days
      .updateOne(
        { userId, day },
        { $setOnInsert: { week }, $set: { studied: true, qotdAnswered: true }, $inc: { points: award.points } },
        { upsert: true, session },
      )
      .exec();
    await this.addToWeek(user, week, at, { points: award.points, activeDays: dayRow?.studied ? 0 : 1 }, session);
    await this.refreshStreak(userId, day, session);
    return award.points;
  }

  // ── After points are saved ─────────────────────────────────────────────────

  private listeners: PointsListener[] = [];

  /** Run `listener` whenever a student earns points (leaderboard cache, notifications, flags). */
  onPointsAdded(listener: PointsListener) {
    this.listeners.push(listener);
  }

  /** Call after the transaction that saved the points has committed. Never throws. */
  async pointsAdded(event: PointsEvent) {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (error) {
        this.logger.warn(`After-points step failed for ${event.userId}: ${error?.message ?? error}`);
      }
    }
  }

  /** Forget the cached Home summary (after a quiz / QOTD answer / goal change). */
  async invalidate(userId: string | Types.ObjectId) {
    await this.cache.del(homeCacheKey(userId)).catch(() => undefined);
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  async streakFor(userId: string | Types.ObjectId, now = new Date(), session?: Session): Promise<StreakInfo> {
    const today = lagosDay(now);
    const id = new Types.ObjectId(String(userId));
    const rows = await this.days
      .find({ userId: id, studied: true, day: { $gte: addDays(today, -STREAK_WINDOW_DAYS), $lte: today } })
      .select('day')
      .session(session ?? null)
      .lean()
      .exec();
    const info = computeStreak(rows.map(r => r.day), today);
    const stored = await this.stats.findOne({ userId: id }).select('longestStreak').session(session ?? null).lean().exec();
    return { ...info, longest: Math.max(info.longest, stored?.longestStreak ?? 0) };
  }

  /** This week Monday → Sunday, and the weekly goal. */
  async weekFor(userId: string | Types.ObjectId, now = new Date()) {
    const id = new Types.ObjectId(String(userId));
    const today = lagosDay(now);
    const week = weekOf(now);
    const [rows, goalDays, streak] = await Promise.all([
      this.days.find({ userId: id, week, studied: true }).select('day').lean().exec(),
      this.weeklyGoal(id),
      this.streakFor(id, now),
    ]);
    const studied = new Set(rows.map(r => r.day));
    const frozen = new Set(streak.frozenDays);
    const days: WeekDay[] = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(week, i);
      return { date, studied: studied.has(date), frozen: frozen.has(date), isToday: date === today, future: date > today };
    });
    return { weekStart: week, weekEnd: addDays(week, 6), goalDays, doneDays: studied.size, studiedToday: studied.has(today), days };
  }

  async weeklyGoal(userId: Types.ObjectId): Promise<number> {
    const row = await this.stats.findOne({ userId }).select('weeklyGoalDays').lean().exec();
    return row?.weeklyGoalDays ?? WEEKLY_GOAL.default;
  }

  async setWeeklyGoal(userId: string, weeklyDays: number) {
    if (!Number.isInteger(weeklyDays) || weeklyDays < WEEKLY_GOAL.min || weeklyDays > WEEKLY_GOAL.max) {
      throw new BadRequestException(`The weekly goal must be ${WEEKLY_GOAL.min}–${WEEKLY_GOAL.max} days.`);
    }
    await this.stats
      .updateOne({ userId: new Types.ObjectId(userId) }, { $set: { weeklyGoalDays: weeklyDays } }, { upsert: true })
      .exec();
    await this.invalidate(userId);
    return { weeklyDays };
  }

  /** Longest streak ever (badges). */
  async longestStreak(userId: string | Types.ObjectId) {
    return (await this.streakFor(userId)).longest;
  }

  // ── Repair, recount, rebuild ───────────────────────────────────────────────

  /** Score attempts that missed scoring (oldest first). Used nightly and by the rebuild. */
  async scoreUnscored(since?: Date) {
    const query = { scoredAt: { $exists: false }, ...(since ? { submittedAt: { $gte: since } } : {}) };
    const ids = await this.attempts.find(query).sort({ submittedAt: 1, _id: 1 }).select('_id').lean().exec();
    let scored = 0;
    for (const { _id } of ids) {
      try {
        const result = await inTransaction(this.connection, session => this.recordQuiz(_id, session));
        if (result) {
          scored += 1;
          if (result.referral) await this.referralRewarded(result.referral);
        }
      } catch (error) {
        this.logger.error(`Couldn't score attempt ${_id}: ${error?.message ?? error}`);
      }
    }
    return { found: ids.length, scored };
  }

  /**
   * Recount a week's leaderboard totals from the ledger and study days (the
   * nightly safety net; also `yarn leaderboard rebuild`). Keeps `reachedAt`.
   */
  async reconcileWeek(week: string) {
    const [points, days] = await Promise.all([
      this.ledger.aggregate<{ _id: Types.ObjectId; points: number; improvements: number; lastAt: Date }>([
        // Lifetime-only rows (referrals past the weekly limit) aren't leaderboard points.
        { $match: { week, leaderboard: { $ne: false } } },
        {
          $group: {
            _id: '$userId',
            points: { $sum: '$points' },
            improvements: { $sum: { $cond: [{ $and: [{ $eq: ['$sourceType', 'improvement'] }, { $gt: ['$points', 0] }] }, 1, 0] } },
            lastAt: { $max: { $cond: [{ $gt: ['$points', 0] }, '$occurredAt', null] } },
          },
        },
      ]),
      this.days.aggregate<{ _id: Types.ObjectId; studied: number; correct: number; quizzes: number }>([
        { $match: { week } },
        {
          $group: {
            _id: '$userId',
            studied: { $sum: { $cond: ['$studied', 1, 0] } },
            correct: { $sum: '$correctAnswers' },
            quizzes: { $sum: '$quizzesCompleted' },
          },
        },
      ]),
    ]);
    const byUser = new Map<string, { points: number; improvements: number; lastAt?: Date; studied: number; correct: number; quizzes: number }>();
    for (const p of points) byUser.set(String(p._id), { points: p.points, improvements: p.improvements, lastAt: p.lastAt ?? undefined, studied: 0, correct: 0, quizzes: 0 });
    for (const d of days) {
      const row = byUser.get(String(d._id)) ?? { points: 0, improvements: 0, studied: 0, correct: 0, quizzes: 0 };
      byUser.set(String(d._id), { ...row, studied: d.studied, correct: d.correct, quizzes: d.quizzes });
    }

    const users = await this.users
      .find({ _id: { $in: [...byUser.keys()].map(id => new Types.ObjectId(id)) } })
      .select('role studentProfile')
      .lean()
      .exec();
    const existing = new Map(
      (await this.weeks.find({ week }).select('studentId reachedAt').lean().exec()).map(w => [String(w.studentId), w.reachedAt]),
    );
    let students = 0;
    for (const u of users) {
      if (u.role) continue;
      const r = byUser.get(String(u._id))!;
      if (!r.points && !r.studied) continue;
      students += 1;
      await this.weeks
        .updateOne(
          { week, studentId: u._id },
          {
            $set: {
              points: r.points,
              correct: r.correct,
              quizzes: r.quizzes,
              activeDays: r.studied,
              improvements: r.improvements,
              ...academicsOf(u),
              reachedAt: existing.get(String(u._id)) ?? r.lastAt ?? weekRange(week).start,
            },
          },
          { upsert: true },
        )
        .exec();
    }
    // Rows with no activity left (e.g. after a rebuild) are removed.
    // (A week that nets to 0 points with no study days goes too, e.g. after a reversal.)
    const keep = users
      .filter(u => {
        const r = byUser.get(String(u._id));
        return !u.role && !!r && (!!r.points || !!r.studied);
      })
      .map(u => u._id);
    await this.weeks.deleteMany({ week, studentId: { $nin: keep } }).exec();
    return { week, students };
  }

  /** Store the current / longest streak for students who studied recently (nightly). */
  async refreshRecentStreaks(now = new Date()) {
    const today = lagosDay(now);
    const ids: Types.ObjectId[] = await this.days.distinct('userId', { studied: true, day: { $gte: addDays(today, -3) } });
    for (const id of ids) await this.refreshStreak(id, today, undefined);
    return { students: ids.length };
  }

  /**
   * Recount everything from the quiz attempts and QOTD answers (first deploy,
   * or after a points change). Keeps weekly goals, admin adjustments and the
   * status of integrity flags. Run at a quiet time.
   */
  async rebuildAll(log: (line: string) => void = () => undefined) {
    const qotdAnswers = this.connection.collection('qotd_answers');
    log('Clearing study days, topic/question history, points and weekly totals…');
    await Promise.all([
      this.days.deleteMany({}).exec(),
      this.topics.deleteMany({}).exec(),
      this.questions.deleteMany({}).exec(),
      // Admin adjustments and referral rewards aren't recalculated from quizzes: they stay.
      this.ledger.deleteMany({ sourceType: { $nin: ['adjustment', 'referral'] } }).exec(),
      this.weeks.deleteMany({}).exec(),
      this.stats.updateMany({}, { $set: { currentStreak: 0, longestStreak: 0, frozenDays: [] }, $unset: { lastStudyDay: 1 } }).exec(),
      this.attempts.updateMany({}, { $unset: { scoredAt: 1, points: 1 } }).exec(),
    ]);

    const answers = await qotdAnswers.find({}).sort({ answeredAt: 1 }).toArray();
    const attemptIds = await this.attempts.find({}).sort({ submittedAt: 1, _id: 1 }).select('_id submittedAt').lean().exec();
    log(`Replaying ${attemptIds.length} quiz attempts and ${answers.length} QOTD answers…`);

    let a = 0;
    const replayAnswersUntil = async (until?: Date) => {
      while (a < answers.length && (!until || answers[a].answeredAt <= until)) {
        const ans = answers[a++];
        const points = await inTransaction(this.connection, session =>
          this.recordQotd(ans.userId, ans.day, ans.correct, ans.answeredAt, session),
        );
        await qotdAnswers.updateOne({ _id: ans._id }, { $set: { points } });
      }
    };
    let done = 0;
    for (const { _id, submittedAt } of attemptIds) {
      await replayAnswersUntil(submittedAt);
      await inTransaction(this.connection, session => this.recordQuiz(_id, session));
      if (++done % 500 === 0) log(`  ${done}/${attemptIds.length}`);
    }
    await replayAnswersUntil();

    const weeks: string[] = await this.ledger.distinct('week');
    for (const week of weeks) await this.reconcileWeek(week);
    await this.refreshAllStreaks();
    return { attempts: attemptIds.length, qotdAnswers: answers.length, weeks: weeks.length };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** The student (null for staff and missing accounts). */
  private async student(userId: Types.ObjectId, session: Session): Promise<StudentRef | null> {
    const user = await this.users.findById(userId).select('role studentProfile').session(session ?? null).lean().exec();
    return user && !user.role ? (user as StudentRef) : null;
  }

  private async writeAwards(
    userId: Types.ObjectId,
    occurredAt: Date,
    day: string,
    week: string,
    awards: (Award & { sourceId: string })[],
    session: Session,
  ) {
    const rows = awards
      .filter(a => a.requested > 0)
      .map(a => ({ userId, occurredAt, day, week, sourceType: a.sourceType, sourceId: a.sourceId, points: a.points, requested: a.requested, meta: a.meta }));
    if (rows.length) await this.ledger.insertMany(rows, { session });
  }

  private async addToWeek(
    user: StudentRef,
    week: string,
    at: Date,
    inc: Partial<Record<'points' | 'correct' | 'quizzes' | 'activeDays' | 'improvements', number>>,
    session: Session,
  ) {
    if (!Object.values(inc).some(Boolean)) return;
    await this.weeks
      .updateOne(
        { week, studentId: user._id },
        {
          $inc: inc,
          $set: { ...academicsOf(user), ...(inc.points ? { reachedAt: at } : {}) },
          ...(inc.points ? {} : { $setOnInsert: { reachedAt: at } }),
        },
        { upsert: true, session },
      )
      .exec();
  }

  private async refreshStreak(userId: Types.ObjectId, day: string, session: Session) {
    // Noon Lagos time on `day`: any instant inside it works.
    const info = await this.streakFor(userId, new Date(`${day}T11:00:00Z`), session);
    await this.stats
      .updateOne(
        { userId },
        {
          $set: { currentStreak: info.current, lastStudyDay: info.lastStudyDay ?? undefined, frozenDays: info.frozenDays },
          $max: { longestStreak: info.longest },
        },
        { upsert: true, session },
      )
      .exec();
    return info;
  }

  private async refreshAllStreaks() {
    const ids: Types.ObjectId[] = await this.days.distinct('userId', { studied: true });
    const today = lagosDay(new Date());
    for (const id of ids) {
      const rows = await this.days.find({ userId: id, studied: true }).select('day').lean().exec();
      const info = computeStreak(rows.map(r => r.day), today);
      await this.stats
        .updateOne(
          { userId: id },
          { $set: { currentStreak: info.current, longestStreak: info.longest, lastStudyDay: info.lastStudyDay ?? undefined, frozenDays: info.frozenDays } },
          { upsert: true },
        )
        .exec();
    }
  }
}

const academicsOf = (user: { studentProfile?: Academics }) => {
  const p = user.studentProfile;
  return { institution: p?.institution || undefined, department: p?.department || undefined, level: p?.level || undefined };
};
