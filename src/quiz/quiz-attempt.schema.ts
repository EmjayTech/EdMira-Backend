import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

@Schema({ _id: false })
export class AttemptAnswer {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true })
  questionId: mongoose.Types.ObjectId;

  /** null = skipped (counts as incorrect). */
  @Prop({ type: Number, default: null })
  selectedIndex: number | null;

  @Prop({ required: true })
  correct: boolean;
}

const AttemptAnswerSchema = SchemaFactory.createForClass(AttemptAnswer);

@Schema({ timestamps: true })
export class QuizAttempt {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true })
  studentId: mongoose.Types.ObjectId;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Topic', required: true })
  topicId: mongoose.Types.ObjectId;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true })
  courseId: mongoose.Types.ObjectId;

  /** Titles are copied so history still reads well if content is renamed. */
  @Prop({ required: true })
  topicTitle: string;

  @Prop({ required: true })
  courseTitle: string;

  @Prop({ required: true })
  startedAt: Date;

  @Prop({ required: true })
  submittedAt: Date;

  @Prop({ required: true })
  total: number;

  @Prop({ required: true })
  correctCount: number;

  @Prop({ required: true })
  answeredCount: number;

  /** 0–100 */
  @Prop({ required: true })
  score: number;

  @Prop({ type: [AttemptAnswerSchema], default: [] })
  answers: AttemptAnswer[];
}

export type QuizAttemptDocument = HydratedDocument<QuizAttempt>;
export const QuizAttemptSchema = SchemaFactory.createForClass(QuizAttempt);
// Makes submission safe to retry: the same quiz run can only be stored once.
QuizAttemptSchema.index({ studentId: 1, topicId: 1, startedAt: 1 }, { unique: true });
QuizAttemptSchema.index({ studentId: 1, submittedAt: -1 });
