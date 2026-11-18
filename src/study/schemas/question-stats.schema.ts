import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

/**
 * One student's history with one question, for the anti-farming rules:
 * +2 instead of +10 after two correct answers, and only 3 tries a day count.
 */
@Schema({ collection: 'question_stats' })
export class QuestionStats {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true })
  userId: mongoose.Types.ObjectId;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true })
  questionId: mongoose.Types.ObjectId;

  /** Times answered correctly (ever). */
  @Prop({ default: 0 }) correct: number;
  /** Times answered (ever). */
  @Prop({ default: 0 }) tries: number;
  /** Lagos day of the latest try, and how many tries on that day. */
  @Prop() lastDay?: string;
  @Prop({ default: 0 }) triesOnLastDay: number;
}

export type QuestionStatsDocument = HydratedDocument<QuestionStats>;
export const QuestionStatsSchema = SchemaFactory.createForClass(QuestionStats);
QuestionStatsSchema.index({ userId: 1, questionId: 1 }, { unique: true });
