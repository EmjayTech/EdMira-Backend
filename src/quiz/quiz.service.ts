import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { presentReviewQuestion } from '../content/content.presenter';
import { ContentService } from '../content/content.service';
import { SubmitAttemptDto } from './dto/submit-attempt.dto';
import { QuizAttempt, QuizAttemptDocument } from './quiz-attempt.schema';
import { presentAttempt } from './quiz.presenter';
import { PlansService } from '../plans/plans.service';
import { lockExplanations } from '../plans/plan-locks';
import { QuizPointsResult, StudyService } from '../study/study.service';
import { inTransaction } from '../study/transactions';
import { keyedHash } from '../common/keyed-hash';

const HISTORY_LIMIT = 500;
const DUPLICATE_KEY = 11000;

/** A keyed hash of the network address (see common/keyed-hash). */
const hashIp = keyedHash;

/** The attempt's own unique key (same student, topic and start time), not another collection's. */
const isDuplicateAttempt = (error: any) =>
  error?.code === DUPLICATE_KEY && (!error.keyPattern || 'startedAt' in error.keyPattern);

@Injectable()
export class QuizService {
  private readonly logger = new Logger(QuizService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(QuizAttempt.name) private readonly attempts: Model<QuizAttemptDocument>,
    private readonly content: ContentService,
    private readonly study: StudyService,
    private readonly plans: PlansService,
  ) {}

  /**
   * Grades on the server (answers never reach the phone before this) and
   * stores the attempt. Re-submitting the same run returns the stored attempt.
   */
  async submit(studentId: string, dto: SubmitAttemptDto, ip?: string) {
    const { topic, course } = await this.content.findVisibleTopic(dto.topicId);
    const studentObjectId = new Types.ObjectId(studentId);
    const startedAt = new Date(dto.startedAt);

    const existing = await this.attempts
      .findOne({ studentId: studentObjectId, topicId: topic._id, startedAt })
      .exec();
    if (existing) return presentAttempt(existing);

    // One answer per question; later duplicates are ignored.
    const answers = [...new Map(dto.answers.map(a => [a.questionId, a])).values()];
    const questions = await this.content.findGradableQuestions(
      topic._id,
      answers.map(a => a.questionId),
    );
    if (questions.length !== answers.length) {
      throw new BadRequestException(
        'Some questions are no longer available for this topic. Please restart the quiz.',
      );
    }
    const byId = new Map(questions.map(q => [q.id, q]));
    for (const a of answers) {
      if (a.selectedIndex !== null && a.selectedIndex >= byId.get(a.questionId).options.length) {
        throw new BadRequestException('An answer points at an option that does not exist.');
      }
    }

    // Daily MCQ limit (Free 30 / Pro 100): only answered questions count, and
    // anything past today's limit isn't graded or stored.
    const answeredTotal = answers.filter(a => a.selectedIndex !== null).length;
    const allowed = await this.plans.consume(studentId, answeredTotal);
    if (answeredTotal && !allowed) this.plans.limitReached(await this.plans.allowance(studentId));
    let kept = answers;
    if (allowed < answeredTotal) {
      let counted = 0;
      kept = answers.slice(0, answers.findIndex(a => a.selectedIndex !== null && ++counted > allowed));
    }

    const graded = kept.map(a => {
      const question = byId.get(a.questionId);
      return {
        questionId: question._id,
        selectedIndex: a.selectedIndex,
        correct: a.selectedIndex === question.answerIndex,
      };
    });

    const correctCount = graded.filter(g => g.correct).length;
    const record = {
      studentId: studentObjectId,
      topicId: topic._id,
      courseId: course._id,
      topicTitle: topic.title,
      courseTitle: course.title,
      startedAt,
      submittedAt: new Date(),
      total: graded.length,
      correctCount,
      answeredCount: graded.filter(g => g.selectedIndex !== null).length,
      score: Math.round((correctCount / graded.length) * 100),
      answers: graded,
      ...(dto.retry ? { retry: true } : {}),
      ...(ip ? { ipHash: hashIp(ip) } : {}),
    };

    let attempt: QuizAttemptDocument;
    let points: QuizPointsResult | null = null;
    try {
      // The attempt, study day, streak, points and weekly totals are stored together.
      [attempt, points] = await inTransaction(this.connection, async session => {
        const [created] = await this.attempts.create([record], { session });
        return [created, await this.study.recordQuiz(created._id, session)] as const;
      });
    } catch (error) {
      if (isDuplicateAttempt(error)) return this.storedRun(studentObjectId, topic._id, startedAt);
      // A scoring problem must never lose a student's quiz: keep it unscored;
      // the nightly job scores it.
      this.logger.error(`Couldn't score a quiz for ${studentId}; saving it unscored: ${error?.message ?? error}`);
      try {
        attempt = await this.attempts.create(record);
      } catch (retryError) {
        if (isDuplicateAttempt(retryError)) return this.storedRun(studentObjectId, topic._id, startedAt);
        throw retryError;
      }
    }
    await this.study.invalidate(studentId);
    if (points) await this.study.pointsAdded({ userId: studentId, week: points.week, day: points.day, points: points.points });
    if (points?.referral) await this.study.referralRewarded(points.referral);
    const reloaded = (await this.attempts.findById(attempt._id).exec()) ?? attempt;
    const pointsResult = points && (({ week: _week, day: _day, referral: _referral, ...rest }) => rest)(points);
    return {
      ...presentAttempt(reloaded),
      ...(pointsResult ? { pointsResult } : {}),
      // Answers past today's limit that weren't counted (the app shows the upgrade screen).
      ...(allowed < answeredTotal ? { overLimit: answeredTotal - allowed } : {}),
    };
  }

  /** Two identical submissions raced (or a retry): return the stored one. */
  private async storedRun(studentId: Types.ObjectId, topicId: Types.ObjectId, startedAt: Date) {
    const winner = await this.attempts.findOne({ studentId, topicId, startedAt }).exec();
    return presentAttempt(winner);
  }

  /** The student's attempts, newest first. */
  async list(studentId: string) {
    const attempts = await this.attempts
      .find({ studentId: new Types.ObjectId(studentId) })
      .sort({ submittedAt: -1 })
      .limit(HISTORY_LIMIT)
      .exec();
    return attempts.map(presentAttempt);
  }

  /** One of the student's own attempts, with full questions (answers + explanations). */
  async review(studentId: string, attemptId: string) {
    const attempt = await this.attempts
      .findOne({ _id: attemptId, studentId: new Types.ObjectId(studentId) })
      .exec();
    // Someone else's attempt is reported as not found, not forbidden.
    if (!attempt) throw new NotFoundException('We couldn’t find this attempt.');

    const questions = await this.content.findQuestionsByIds(attempt.answers.map(a => a.questionId));
    const order = new Map(attempt.answers.map((a, i) => [String(a.questionId), i]));
    questions.sort((a, b) => order.get(a.id) - order.get(b.id));

    const review = { ...presentAttempt(attempt), questions: questions.map(presentReviewQuestion) };
    // Free students still see right / wrong and the correct option; explanations are Pro.
    return (await this.plans.canUse(studentId, 'explanations')) ? review : lockExplanations(review);
  }
}
