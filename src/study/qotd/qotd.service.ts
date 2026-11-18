import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { ContentStatus } from '../../common/enum/content-status.enum';
import { Course, CourseDocument } from '../../content/schemas/course.schema';
import { Question, QuestionDocument } from '../../content/schemas/question.schema';
import { Topic, TopicDocument } from '../../content/schemas/topic.schema';
import { addDays, lagosDay, weekOfDay } from '../../leaderboard/week';
import { User, UserDocument } from '../../users/model/user.model';
import { StudyService } from '../study.service';
import { inTransaction } from '../transactions';
import { ALL_GROUP, QotdGroup, candidateGroups, courseFitsGroup, parseGroup, pickQuestion } from './qotd-groups';
import { QotdAnswer, QotdAnswerDocument, QotdDay, QotdDayDocument } from './qotd.schemas';

const PUBLISHED = ContentStatus.PUBLISHED;
/** A group needs at least this many published questions, else it falls back to a wider one. */
export const MIN_POOL = 30;
/** Questions aren't repeated for a group within this many days (when the pool allows). */
export const NO_REPEAT_DAYS = 30;
/** "1,204 students answered today" is hidden below this. */
export const MIN_ANSWERED_TO_SHOW = 20;
const DUPLICATE_KEY = 11000;

/**
 * Question of the Day (Part A5): one published question per day per level +
 * department (falling back to level, then everyone), the same for the whole
 * group, graded on the server, one answer per student per day.
 */
@Injectable()
export class QotdService {
  /** Published question ids per group, rebuilt once a day per server. */
  private pools = new Map<string, string[]>();
  private poolsDay = '';

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(QotdDay.name) private readonly qotdDays: Model<QotdDayDocument>,
    @InjectModel(QotdAnswer.name) private readonly answers: Model<QotdAnswerDocument>,
    @InjectModel(Question.name) private readonly questions: Model<QuestionDocument>,
    @InjectModel(Topic.name) private readonly topics: Model<TopicDocument>,
    @InjectModel(Course.name) private readonly courses: Model<CourseDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly study: StudyService,
  ) {}

  // ── Students ───────────────────────────────────────────────────────────────

  /** Today's question for the student (never the answer, until they've answered). */
  async today(userId: string, now = new Date()) {
    const day = lagosDay(now);
    const doc = await this.forStudent(userId, day);
    if (!doc) return { day, question: null, answer: null, answeredCount: null };
    const mine = await this.answers.findOne({ userId: new Types.ObjectId(userId), day }).lean().exec();
    return this.present(doc, mine);
  }

  /** Grade an answer. Answering again returns the stored result (never awards twice). */
  async answer(userId: string, questionId: string, selectedIndex: number, now = new Date()) {
    const day = lagosDay(now);
    const uid = new Types.ObjectId(userId);
    const doc = await this.forStudent(userId, day);
    if (!doc) throw new NotFoundException('There is no Question of the Day right now.');

    const existing = await this.answers.findOne({ userId: uid, day }).lean().exec();
    if (existing) return { ...(await this.present(doc, existing)), awarded: 0, alreadyAnswered: true };
    if (String(doc.questionId) !== questionId) {
      throw new ConflictException({
        statusCode: 409,
        code: 'QOTD_CHANGED',
        message: 'There is a new Question of the Day. Pull down to refresh.',
      });
    }
    const question = await this.questions.findById(doc.questionId).select('options answerIndex').lean().exec();
    if (!question) throw new NotFoundException('There is no Question of the Day right now.');
    if (selectedIndex >= question.options.length) throw new BadRequestException('That option does not exist.');
    const correct = selectedIndex === question.answerIndex;

    let awarded = 0;
    try {
      awarded = await inTransaction(this.connection, async session => {
        const [row] = await this.answers.create(
          [{ userId: uid, day, group: doc.group, questionId: doc.questionId, selectedIndex, correct, points: 0, answeredAt: now }],
          { session },
        );
        const points = await this.study.recordQotd(uid, day, correct, now, session);
        await this.answers.updateOne({ _id: row._id }, { $set: { points } }, { session }).exec();
        await this.qotdDays.updateOne({ _id: doc._id }, { $inc: { answeredCount: 1 } }, { session }).exec();
        return points;
      });
    } catch (error) {
      // The same answer sent twice at once (e.g. an offline retry): the first one counts.
      if (error?.code !== DUPLICATE_KEY) throw error;
      const stored = await this.answers.findOne({ userId: uid, day }).lean().exec();
      return { ...(await this.present(doc, stored)), awarded: 0, alreadyAnswered: true };
    }
    await this.study.invalidate(userId);
    if (awarded > 0) await this.study.pointsAdded({ userId, week: weekOfDay(day), day, points: awarded });
    const fresh = await this.qotdDays.findById(doc._id).lean().exec();
    const mine = await this.answers.findOne({ userId: uid, day }).lean().exec();
    return { ...(await this.present(fresh ?? doc, mine)), awarded, alreadyAnswered: false };
  }

  // ── Admins ─────────────────────────────────────────────────────────────────

  /** Every group's question for a day (picked or pinned so far). */
  async listForDay(day: string) {
    const docs = await this.qotdDays.find({ day }).sort({ group: 1 }).lean().exec();
    const questions = await this.questions.find({ _id: { $in: docs.map(d => d.questionId) } }).select('stem').lean().exec();
    const stems = new Map(questions.map(q => [String(q._id), q.stem]));
    return docs.map(d => ({
      day: d.day,
      group: d.group,
      questionId: String(d.questionId),
      stem: stems.get(String(d.questionId)) ?? '',
      pinned: d.pinned,
      pinnedBy: d.pinnedBy ?? null,
      answeredCount: d.answeredCount,
    }));
  }

  /** Pin a published question for a group on today or a future day. */
  async pin(day: string, groupKey: string, questionId: string, staffName: string, now = new Date()) {
    const group = this.assertEditable(day, groupKey, now);
    if (!Types.ObjectId.isValid(questionId)) throw new BadRequestException('Unknown question.');
    const ok = await this.questions.exists({ _id: questionId, status: PUBLISHED });
    if (!ok) throw new BadRequestException('Only published questions can be the Question of the Day.');
    const current = await this.qotdDays.findOne({ day, group: group.key }).lean().exec();
    if (current?.answeredCount) throw new ConflictException('Students have already answered this question, so it can’t be changed.');
    await this.qotdDays
      .updateOne(
        { day, group: group.key },
        { $set: { questionId: new Types.ObjectId(questionId), pinned: true, pinnedBy: staffName }, $setOnInsert: { answeredCount: 0 } },
        { upsert: true },
      )
      .exec();
    return (await this.listForDay(day)).find(d => d.group === group.key);
  }

  /** Remove a pin; the day's question is then picked automatically. */
  async unpin(day: string, groupKey: string, now = new Date()) {
    const group = this.assertEditable(day, groupKey, now);
    const current = await this.qotdDays.findOne({ day, group: group.key }).lean().exec();
    if (current?.answeredCount) throw new ConflictException('Students have already answered this question, so it can’t be changed.');
    await this.qotdDays.deleteOne({ day, group: group.key, answeredCount: 0 }).exec();
    return { ok: true };
  }

  // ── Picking ────────────────────────────────────────────────────────────────

  /** The day's question for the student's group (created on first request). */
  private async forStudent(userId: string, day: string) {
    const user = await this.users.findById(userId).select('studentProfile').lean().exec();
    const groups = candidateGroups(user?.studentProfile?.level, user?.studentProfile?.department);
    const existing = await this.qotdDays.find({ day, group: { $in: groups.map(g => g.key) } }).lean().exec();
    for (const group of groups) {
      const found = existing.find(e => e.group === group.key);
      if (found && (await this.isLive(found.questionId))) return found;
      const pool = await this.pool(group, day);
      if (pool.length >= MIN_POOL || (group.key === ALL_GROUP && pool.length)) return this.create(group, pool, day);
    }
    return null;
  }

  private async create(group: QotdGroup, pool: string[], day: string) {
    const recent = await this.qotdDays
      .find({ group: group.key, day: { $gte: addDays(day, -NO_REPEAT_DAYS), $lt: day } })
      .select('questionId')
      .lean()
      .exec();
    const questionId = pickQuestion(pool, new Set(recent.map(r => String(r.questionId))), day, group.key);
    if (!questionId) return null;
    try {
      // If the stored question was unpublished since, it's replaced (only before anyone answered).
      return await this.qotdDays
        .findOneAndUpdate(
          { day, group: group.key, answeredCount: 0, pinned: { $ne: true } },
          { $set: { questionId: new Types.ObjectId(questionId) }, $setOnInsert: { pinned: false, answeredCount: 0 } },
          { upsert: true, new: true },
        )
        .lean()
        .exec();
    } catch (error) {
      // Another request created it at the same moment (or it's pinned / answered): use that one.
      if (error?.code !== DUPLICATE_KEY) throw error;
      return this.qotdDays.findOne({ day, group: group.key }).lean().exec();
    }
  }

  private async isLive(questionId: Types.ObjectId) {
    const q = await this.questions.findOne({ _id: questionId, status: PUBLISHED }).select('topicId').lean().exec();
    if (!q) return false;
    const t = await this.topics.findOne({ _id: q.topicId, status: PUBLISHED }).select('courseId').lean().exec();
    return !!t && !!(await this.courses.exists({ _id: t.courseId, status: PUBLISHED }));
  }

  /** Published questions in published topics of published courses that fit the group, sorted by id. */
  private async pool(group: QotdGroup, day: string): Promise<string[]> {
    if (this.poolsDay !== day) {
      this.pools.clear();
      this.poolsDay = day;
    }
    const cached = this.pools.get(group.key);
    if (cached) return cached;
    const courses = await this.courses.find({ status: PUBLISHED }).select('audience').lean().exec();
    const courseIds = courses.filter(c => courseFitsGroup(c.audience, group)).map(c => c._id);
    const topicIds = (await this.topics.find({ status: PUBLISHED, courseId: { $in: courseIds } }).select('_id').lean().exec()).map(t => t._id);
    const ids = (await this.questions.find({ status: PUBLISHED, topicId: { $in: topicIds } }).select('_id').sort({ _id: 1 }).lean().exec()).map(q =>
      String(q._id),
    );
    this.pools.set(group.key, ids);
    return ids;
  }

  private assertEditable(day: string, groupKey: string, now: Date): QotdGroup {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) throw new BadRequestException('Use a date like 2026-11-20.');
    if (day < lagosDay(now)) throw new BadRequestException('Past days can’t be changed.');
    const group = parseGroup(groupKey);
    if (!group) throw new BadRequestException('Unknown group.');
    return group;
  }

  // ── Shape sent to the app ──────────────────────────────────────────────────

  private async present(doc: Pick<QotdDay, 'day' | 'questionId' | 'answeredCount'>, mine?: QotdAnswer | null) {
    const question = await this.questions.findById(doc.questionId).lean().exec();
    const topic = question && (await this.topics.findById(question.topicId).select('title courseId').lean().exec());
    const course = topic && (await this.courses.findById(topic.courseId).select('title code shortName').lean().exec());
    return {
      day: doc.day,
      question: question && {
        id: String(question._id),
        stem: question.stem,
        options: [...question.options],
        topicTitle: topic?.title ?? '',
        courseTitle: course?.title ?? '',
        courseCode: course?.code ?? course?.shortName ?? '',
      },
      // The answer and explanation only once the student has answered.
      answer: mine
        ? {
            selectedIndex: mine.selectedIndex,
            correct: mine.correct,
            answerIndex: question?.answerIndex ?? null,
            explanation: question?.explanation ?? null,
            points: mine.points,
          }
        : null,
      answeredCount: doc.answeredCount >= MIN_ANSWERED_TO_SHOW ? doc.answeredCount : null,
    };
  }
}
