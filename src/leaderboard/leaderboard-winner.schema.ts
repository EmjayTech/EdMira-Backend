import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

export const WINNER_SCOPES = ['all', 'school', 'level', 'department', 'schools'] as const;
export type WinnerScope = (typeof WINNER_SCOPES)[number];

/**
 * The final top 10 of every board, saved when a week closes (Monday 00:00
 * Lagos), so prizes and "last week" never change afterwards. `scopeId` is the
 * school / level / department name ('' for All of EdMira). For the Schools
 * board each row is a school (no student).
 */
@Schema({ collection: 'leaderboard_winners', timestamps: { createdAt: true, updatedAt: false } })
export class LeaderboardWinner {
  @Prop({ required: true }) week: string;
  @Prop({ type: String, required: true }) scopeType: WinnerScope;
  @Prop({ default: '' }) scopeId: string;
  @Prop({ required: true }) rank: number;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User' })
  userId?: mongoose.Types.ObjectId;
  /** Username at the time (it may change later). */
  @Prop() username?: string;

  @Prop({ required: true }) points: number;
  @Prop() studyDays?: number;
  /** Schools board only. */
  @Prop() activeStudents?: number;
  @Prop() totalPoints?: number;
}

export type LeaderboardWinnerDocument = HydratedDocument<LeaderboardWinner>;
export const LeaderboardWinnerSchema = SchemaFactory.createForClass(LeaderboardWinner);
LeaderboardWinnerSchema.index({ week: 1, scopeType: 1, scopeId: 1, rank: 1 }, { unique: true });
LeaderboardWinnerSchema.index({ userId: 1, week: -1 });
