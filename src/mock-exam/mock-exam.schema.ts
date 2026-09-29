import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';
import { AttemptAnswer } from '../quiz/quiz-attempt.schema';

@Schema({ _id: false })
class MockAnswer extends AttemptAnswer {}
const MockAnswerSchema = SchemaFactory.createForClass(MockAnswer);

/**
 * A timed, mixed-topic exam over one course (EdMira Pro). Created when the
 * student starts it — so the question set and deadline are fixed on the
 * server — and graded on submit.
 */
@Schema({ timestamps: true })
export class MockExam {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true })
  studentId: mongoose.Types.ObjectId;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true })
  courseId: mongoose.Types.ObjectId;

  @Prop({ required: true })
  courseTitle: string;

  /** In the order the student sees them. */
  @Prop({ type: [mongoose.Schema.Types.ObjectId], ref: 'Question', required: true })
  questionIds: mongoose.Types.ObjectId[];

  @Prop({ required: true })
  startedAt: Date;

  @Prop({ required: true })
  durationSeconds: number;

  @Prop({ required: true })
  endsAt: Date;

  @Prop()
  submittedAt?: Date;

  /** Submitted after the time ran out (plus a short grace for slow networks). */
  @Prop({ default: false })
  late: boolean;

  @Prop({ type: [MockAnswerSchema], default: [] })
  answers: MockAnswer[];

  @Prop({ default: 0 })
  correctCount: number;

  @Prop({ default: 0 })
  answeredCount: number;

  /** 0–100; null until submitted. */
  @Prop({ type: Number, default: null })
  score: number | null;
}

export type MockExamDocument = HydratedDocument<MockExam>;
export const MockExamSchema = SchemaFactory.createForClass(MockExam);
MockExamSchema.index({ studentId: 1, startedAt: -1 });
