import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

/**
 * One student's activity on one Lagos calendar day. Updated in the same
 * transaction as each quiz submission / Question of the Day answer, so
 * streaks, weekly goals and the daily points cap never scan attempts.
 *
 * A *study day* (`studied`) = at least one completed quiz (not too fast) or a
 * Question of the Day answer.
 */
@Schema({ collection: 'study_days', timestamps: true })
export class StudyDay {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true })
  userId: mongoose.Types.ObjectId;

  /** Lagos date, "YYYY-MM-DD". */
  @Prop({ required: true })
  day: string;

  /** That day's week (Lagos Monday). */
  @Prop({ required: true })
  week: string;

  @Prop({ default: false })
  studied: boolean;

  /** The +20 study-day bonus has been given (by the first completed quiz). */
  @Prop({ default: false })
  studyDayEarned: boolean;

  @Prop({ default: 0 }) quizzesCompleted: number;
  @Prop({ default: 0 }) questionsAnswered: number;
  @Prop({ default: 0 }) correctAnswers: number;
  @Prop({ default: false }) qotdAnswered: boolean;

  /** Points awarded that day (after the cap). */
  @Prop({ default: 0 }) points: number;
}

export type StudyDayDocument = HydratedDocument<StudyDay>;
export const StudyDaySchema = SchemaFactory.createForClass(StudyDay);
StudyDaySchema.index({ userId: 1, day: 1 }, { unique: true });
StudyDaySchema.index({ userId: 1, studied: 1, day: -1 });
StudyDaySchema.index({ week: 1, userId: 1 });
