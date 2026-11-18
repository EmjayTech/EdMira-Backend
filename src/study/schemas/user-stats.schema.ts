import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';
import { WEEKLY_GOAL } from '../points-config';

/**
 * Per-student study numbers kept up to date after every quiz / QOTD (and
 * recounted nightly). The streak shown to students is always recomputed from
 * study_days with streak.ts; these copies serve badges and admin views.
 */
@Schema({ collection: 'user_stats', timestamps: true })
export class UserStats {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true })
  userId: mongoose.Types.ObjectId;

  @Prop({ default: 0 }) currentStreak: number;
  @Prop({ default: 0 }) longestStreak: number;
  @Prop() lastStudyDay?: string;
  @Prop({ type: [String], default: [] }) frozenDays: string[];

  /** Study days a week the student aims for (1–7). */
  @Prop({ default: WEEKLY_GOAL.default, min: WEEKLY_GOAL.min, max: WEEKLY_GOAL.max })
  weeklyGoalDays: number;
}

export type UserStatsDocument = HydratedDocument<UserStats>;
export const UserStatsSchema = SchemaFactory.createForClass(UserStats);
