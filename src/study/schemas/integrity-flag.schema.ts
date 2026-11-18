import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

export const INTEGRITY_FLAG_KINDS = [
  /** A quiz answered faster than 2 s a question (earned 0). */
  'too_fast_quiz',
  /** More than 300 points in an hour. */
  'points_burst',
  /** 95%+ correct on 200+ questions in a day. */
  'high_accuracy',
  /** 3+ accounts on one network in the same school's top 20. */
  'shared_network',
  /** Several students invited by one classmate from the same phone or network (rewards held). */
  'referral_cluster',
] as const;
export type IntegrityFlagKind = (typeof INTEGRITY_FLAG_KINDS)[number];

/**
 * Suspicious activity for an admin to look at (never an automatic ban).
 * Admins handle them in Leaderboards → Flags.
 */
@Schema({ collection: 'integrity_flags', timestamps: true })
export class IntegrityFlag {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true })
  userId: mongoose.Types.ObjectId;

  @Prop({ type: String, required: true }) kind: IntegrityFlagKind;
  @Prop({ required: true }) sourceId: string;
  @Prop({ type: Object, default: undefined }) detail?: Record<string, unknown>;
  @Prop({ type: String, default: 'open' }) status: 'open' | 'dismissed' | 'actioned';
  /** Who handled it, what they did and why. */
  @Prop({ type: Object, default: undefined }) resolution?: { action: string; reason?: string; by: string; at: Date };
}

export type IntegrityFlagDocument = HydratedDocument<IntegrityFlag>;
export const IntegrityFlagSchema = SchemaFactory.createForClass(IntegrityFlag);
IntegrityFlagSchema.index({ kind: 1, sourceId: 1 }, { unique: true });
IntegrityFlagSchema.index({ status: 1, createdAt: -1 });
