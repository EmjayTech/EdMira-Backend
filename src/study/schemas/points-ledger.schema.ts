import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';
import { PointsSource } from '../points';

/**
 * Every point a student earns, one row per event. Append-only. The unique
 * (sourceType, sourceId) key makes awarding idempotent:
 *   quiz_answers / quiz_complete → attempt id
 *   study_day → "<userId>:<day>"     qotd → "<userId>:<day>"
 *   improvement → "<userId>:<topicId>:<week>"
 *   referral → the invited student's id (one reward per invited student, ever)
 * Weekly totals (leaderboard_weeks) are kept in step in the same
 * transaction and can always be recounted from here.
 */
@Schema({ collection: 'points_ledger' })
export class PointsEntry {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true })
  userId: mongoose.Types.ObjectId;

  @Prop({ required: true }) occurredAt: Date;
  @Prop({ required: true }) day: string;
  @Prop({ required: true }) week: string;

  @Prop({ type: String, required: true }) sourceType: PointsSource;
  @Prop({ required: true }) sourceId: string;

  /** Awarded (after the daily cap). */
  @Prop({ required: true }) points: number;
  /** Before the cap. */
  @Prop({ required: true }) requested: number;

  @Prop({ type: Object, default: undefined }) meta?: Record<string, unknown>;

  /**
   * false: lifetime points only, not the weekly leaderboard (referral rewards
   * past the weekly limit, and back-filled ones). Missing = counts.
   */
  @Prop() leaderboard?: boolean;
}

export type PointsEntryDocument = HydratedDocument<PointsEntry>;
export const PointsEntrySchema = SchemaFactory.createForClass(PointsEntry);
PointsEntrySchema.index({ sourceType: 1, sourceId: 1 }, { unique: true });
PointsEntrySchema.index({ userId: 1, week: 1 });
PointsEntrySchema.index({ week: 1 });
