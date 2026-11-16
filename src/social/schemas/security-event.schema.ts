import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

export const SECURITY_EVENT_RETENTION_SECONDS = 365 * 24 * 60 * 60;

export type SecurityEventType =
  | 'connection_request_sent'
  | 'connection_request_accepted'
  | 'connection_request_declined'
  | 'connection_removed'
  | 'user_blocked'
  | 'user_unblocked'
  | 'user_reported'
  | 'search_rate_limited'
  | 'request_rate_limited'
  | 'auto_flagged'
  | 'moderation_action'
  | 'referral_signup'
  | 'referral_rate_limited'
  | 'challenge_sent'
  | 'challenge_rate_limited';

/** Safety-relevant actions, searchable by admins. Kept for a year. */
@Schema({ collection: 'security_events', timestamps: { createdAt: true, updatedAt: false } })
export class SecurityEvent {
  @Prop({ required: true, index: true })
  type: SecurityEventType;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true })
  actorId?: mongoose.Types.ObjectId;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true })
  targetId?: mongoose.Types.ObjectId;

  /** Small details (ids, counts, category) — no message text. */
  @Prop({ type: Object })
  meta?: Record<string, unknown>;

  createdAt?: Date;
}

export type SecurityEventDocument = HydratedDocument<SecurityEvent>;
export const SecurityEventSchema = SchemaFactory.createForClass(SecurityEvent);
SecurityEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: SECURITY_EVENT_RETENTION_SECONDS });
