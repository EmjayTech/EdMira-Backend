import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { presentQuizQuestion, presentStudentReviewQuestion } from '../content/content.presenter';
import { ContentService } from '../content/content.service';
import { ProFeature } from '../subscription/pro.constants';
import { SubscriptionService } from '../subscription/subscription.service';
import { MockExam, MockExamDocument } from './mock-exam.schema';
import { SubmittedAnswerDto } from '../quiz/dto/submit-attempt.dto';

/** 72 seconds a question — the pace of MBBS best-of-five papers. */
export const SECONDS_PER_QUESTION = 72;
/** A mock needs at least this many questions to be worth timing. */
export const MIN_MOCK_QUESTIONS = 5;
/** Slow networks: submissions this soon after the deadline aren't "late". */
const GRACE_MS = 2 * 60 * 1000;

const present = (exam: MockExamDocument) => ({
  id: exam.id,
  courseId: String(exam.courseId),
  courseTitle: exam.courseTitle,
  total: exam.questionIds.length,
  startedAt: exam.startedAt.toISOString(),
  endsAt: exam.endsAt.toISOString(),
  durationSeconds: exam.durationSeconds,
  submittedAt: exam.submittedAt?.toISOString() ?? null,
  late: exam.late,
  correctCount: exam.correctCount,
  answeredCount: exam.answeredCount,
  score: exam.score,
  answers: exam.answers.map(a => ({
    questionId: String(a.questionId),
    selectedIndex: a.selectedIndex,
    correct: a.correct,
  })),
});

@Injectable()
export class MockExamService {
  constructor(
    @InjectModel(MockExam.name) private readonly exams: Model<MockExamDocument>,
    private readonly content: ContentService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  private async own(studentId: string, examId: string) {
    const exam = await this.exams.findOne({ _id: examId, studentId: new Types.ObjectId(studentId) }).exec();
    if (!exam) throw new NotFoundException('We couldn’t find this mock exam.');
    return exam;
  }

  /** Picks the questions and starts the clock. Pro only. */
  async start(studentId: string, courseId: string, questionCount = 20) {
    await this.subscriptions.assertPro(
      studentId,
      ProFeature.MOCK_EXAMS,
      'Timed mock exams are part of EdMira Pro.',
    );
    const { course, questions } = await this.content.sampleCourseQuestions(courseId, questionCount);
    if (questions.length < MIN_MOCK_QUESTIONS) {
      throw new BadRequestException('This course doesn’t have enough questions for a mock exam yet.');
    }
    const startedAt = new Date();
    const durationSeconds = questions.length * SECONDS_PER_QUESTION;
    const exam = await this.exams.create({
      studentId: new Types.ObjectId(studentId),
      courseId: course._id,
      courseTitle: course.title,
      questionIds: questions.map(q => q._id),
      startedAt,
      durationSeconds,
      endsAt: new Date(startedAt.getTime() + durationSeconds * 1000),
    });
    return { ...present(exam), questions: questions.map(presentQuizQuestion) };
  }

  /** Grades on the server. Submitting twice returns the first result. */
  async submit(studentId: string, examId: string, answers: SubmittedAnswerDto[]) {
    const exam = await this.own(studentId, examId);
    if (exam.submittedAt) return present(exam);

    const questions = await this.content.findQuestionsByIds(exam.questionIds);
    const byId = new Map(questions.map(q => [q.id, q]));
    const given = new Map(answers.map(a => [a.questionId, a.selectedIndex]));
    if ([...given.keys()].some(id => !exam.questionIds.some(q => String(q) === id))) {
      throw new BadRequestException('Some answers are for questions that aren’t in this exam.');
    }

    // Every exam question is graded; unanswered ones count as skipped.
    const graded = exam.questionIds.map(id => {
      const question = byId.get(String(id));
      const selectedIndex = given.get(String(id)) ?? null;
      if (question && selectedIndex !== null && selectedIndex >= question.options.length) {
        throw new BadRequestException('An answer points at an option that does not exist.');
      }
      return { questionId: id, selectedIndex, correct: !!question && selectedIndex === question.answerIndex };
    });

    const submittedAt = new Date();
    const correctCount = graded.filter(g => g.correct).length;
    exam.set({
      submittedAt,
      late: submittedAt.getTime() > exam.endsAt.getTime() + GRACE_MS,
      answers: graded,
      correctCount,
      answeredCount: graded.filter(g => g.selectedIndex !== null).length,
      score: Math.round((correctCount / graded.length) * 100),
    });
    await exam.save();
    return present(exam);
  }

  async list(studentId: string) {
    const exams = await this.exams
      .find({ studentId: new Types.ObjectId(studentId), submittedAt: { $exists: true } })
      .sort({ startedAt: -1 })
      .limit(200)
      .exec();
    return exams.map(present);
  }

  /** A submitted exam with answers; explanations need Pro. */
  async review(studentId: string, examId: string) {
    const exam = await this.own(studentId, examId);
    if (!exam.submittedAt) throw new BadRequestException('Submit the exam to see your results.');
    const [questions, isPro] = await Promise.all([
      this.content.findQuestionsByIds(exam.questionIds),
      this.subscriptions.isPro(studentId),
    ]);
    const order = new Map(exam.questionIds.map((id, i) => [String(id), i]));
    questions.sort((a, b) => order.get(a.id) - order.get(b.id));
    return { ...present(exam), questions: questions.map(q => presentStudentReviewQuestion(q, isPro)) };
  }
}
