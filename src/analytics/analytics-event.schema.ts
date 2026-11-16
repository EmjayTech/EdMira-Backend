import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

/** Kept for 180 days, then MongoDB deletes it (TTL index on createdAt). */
export const ANALYTICS_RETENTION_SECONDS = 180 * 24 * 60 * 60;

/**
 * One product event, e.g. `login_with_username`. No personal data in
 * `props` — ids and counts only.
 */
@Schema({ collection: 'analytics_events', timestamps: { createdAt: true, updatedAt: false } })
export class AnalyticsEvent {
  @Prop({ required: true, index: true })
  name: string;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true })
  userId?: mongoose.Types.ObjectId;

  @Prop({ type: Object, default: undefined })
  props?: Record<string, string | number | boolean>;

  createdAt?: Date;
}

export type AnalyticsEventDocument = HydratedDocument<AnalyticsEvent>;
export const AnalyticsEventSchema = SchemaFactory.createForClass(AnalyticsEvent);
AnalyticsEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: ANALYTICS_RETENTION_SECONDS });
