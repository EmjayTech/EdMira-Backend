import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { presentReviewQuestion } from '../content/content.presenter';
import { ContentService } from '../content/content.service';
import { SubmitAttemptDto } from './dto/submit-attempt.dto';
import { QuizAttempt, QuizAttemptDocument } from './quiz-attempt.schema';
import { presentAttempt } from './quiz.presenter';

const HISTORY_LIMIT = 500;
const DUPLICATE_KEY = 11000;

@Injectable()
export class QuizService {
  constructor(
    @InjectModel(QuizAttempt.name) private readonly attempts: Model<QuizAttemptDocument>,
    private readonly content: ContentService,
  ) {}

  /**
   * Grades on the server (answers never reach the phone before this) and
   * stores the attempt. Re-submitting the same run returns the stored attempt.
   */
  async submit(studentId: string, dto: SubmitAttemptDto) {
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

    const graded = answers.map(a => {
      const question = byId.get(a.questionId);
      if (a.selectedIndex !== null && a.selectedIndex >= question.options.length) {
        throw new BadRequestException('An answer points at an option that does not exist.');
      }
      return {
        questionId: question._id,
        selectedIndex: a.selectedIndex,
        correct: a.selectedIndex === question.answerIndex,
      };
    });

    const correctCount = graded.filter(g => g.correct).length;
    try {
      const attempt = await this.attempts.create({
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
      });
      return presentAttempt(attempt);
    } catch (error) {
      // Two identical submissions raced; return the one that won.
      if (error?.code !== DUPLICATE_KEY) throw error;
      const winner = await this.attempts
        .findOne({ studentId: studentObjectId, topicId: topic._id, startedAt })
        .exec();
      return presentAttempt(winner);
    }
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

    return { ...presentAttempt(attempt), questions: questions.map(presentReviewQuestion) };
  }
}
