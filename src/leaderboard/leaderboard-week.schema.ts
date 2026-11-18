import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

/**
 * One student's leaderboard total for one week — recomputed from their
 * quiz attempts whenever they submit one (see LeaderboardService), so
 * leaderboards never scan attempts. School / programme / level are copied
 * from the profile for filtering. Past weeks are kept (winners, prizes).
 */
@Schema({ collection: 'leaderboard_weeks', timestamps: true })
export class LeaderboardWeek {
  /** The week's Monday in Lagos, "YYYY-MM-DD". */
  @Prop({ required: true })
  week: string;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true })
  studentId: mongoose.Types.ObjectId;

  @Prop({ required: true, default: 0 })
  points: number;

  /** Breakdown (shown to admins; see scoring.ts). */
  @Prop({ default: 0 }) correct: number;
  @Prop({ default: 0 }) quizzes: number;
  @Prop({ default: 0 }) improvements: number;
  @Prop({ default: 0 }) activeDays: number;

  @Prop() institution?: string;
  @Prop() department?: string;
  @Prop() level?: string;

  /** When `points` last went up — ties go to whoever got there first. */
  @Prop({ required: true })
  reachedAt: Date;
}

export type LeaderboardWeekDocument = HydratedDocument<LeaderboardWeek>;
export const LeaderboardWeekSchema = SchemaFactory.createForClass(LeaderboardWeek);
LeaderboardWeekSchema.index({ week: 1, studentId: 1 }, { unique: true });
// One index per leaderboard tab, in ranking order: points, then study days,
// then correct answers, then whoever got there first.
LeaderboardWeekSchema.index({ week: 1, points: -1, activeDays: -1, correct: -1, reachedAt: 1 });
LeaderboardWeekSchema.index({ week: 1, level: 1, points: -1, activeDays: -1, correct: -1, reachedAt: 1 });
LeaderboardWeekSchema.index({ week: 1, institution: 1, points: -1, activeDays: -1, correct: -1, reachedAt: 1 });
LeaderboardWeekSchema.index({ week: 1, department: 1, points: -1, activeDays: -1, correct: -1, reachedAt: 1 });
LeaderboardWeekSchema.index({ week: 1, institution: 1, department: 1, level: 1, points: -1, activeDays: -1, correct: -1, reachedAt: 1 });
