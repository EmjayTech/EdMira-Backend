import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

export const REPORT_REASONS = [
  'wrong_answer',
  'unclear_question',
  'explanation_issue',
  'typo',
  'other',
] as const;

export const FEEDBACK_AREAS = [
  'courses',
  'study_material',
  'quizzes',
  'progress',
  'account',
  'other',
] as const;

/** A student's report on a question (US-23). Handled in the admin dashboard. */
@Schema({ timestamps: true })
export class QuestionReport {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true, index: true })
  questionId: mongoose.Types.ObjectId;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Topic', required: true })
  topicId: mongoose.Types.ObjectId;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true })
  studentId: mongoose.Types.ObjectId;

  @Prop({ type: String, enum: REPORT_REASONS, required: true })
  reason: string;

  @Prop({ default: '' })
  note: string;

  @Prop({ type: String, enum: ['open', 'resolved', 'dismissed'], default: 'open', index: true })
  status: string;

  @Prop()
  resolutionNote?: string;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User' })
  handledById?: mongoose.Types.ObjectId;

  @Prop()
  handledAt?: Date;
}

export type QuestionReportDocument = HydratedDocument<QuestionReport>;
export const QuestionReportSchema = SchemaFactory.createForClass(QuestionReport);

/** Product feedback from a student (US-24). */
@Schema({ timestamps: true })
export class Feedback {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true })
  studentId: mongoose.Types.ObjectId;

  @Prop({ type: String, enum: FEEDBACK_AREAS, required: true })
  area: string;

  /** 1–5, or null when the student skipped the rating. */
  @Prop({ type: Number, min: 1, max: 5, default: null })
  rating: number | null;

  @Prop({ required: true })
  message: string;

  @Prop({ type: String, enum: ['new', 'reviewed', 'planned', 'wont_do'], default: 'new', index: true })
  status: string;
}

export type FeedbackDocument = HydratedDocument<Feedback>;
export const FeedbackSchema = SchemaFactory.createForClass(Feedback);
