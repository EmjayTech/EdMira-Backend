import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

export const ENTITLEMENT_SOURCES = ['founding_tester', 'grant', 'play', 'paystack'] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

/**
 * Something that gives a student Pro until `expiresAt`: the Founding Tester
 * month, an admin grant, or a verified purchase. The user's `proExpiresAt` is
 * the latest active one, recomputed whenever these change.
 */
@Schema({ collection: 'pro_entitlements', timestamps: true })
export class ProEntitlement {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true })
  userId: mongoose.Types.ObjectId;

  @Prop({ type: String, enum: ENTITLEMENT_SOURCES, required: true }) source: EntitlementSource;

  /** Plan id from the catalog (day, week, …) for purchases. */
  @Prop() planId?: string;

  /** Purchase token / payment reference, unique per source (makes webhooks idempotent). */
  @Prop() ref?: string;

  @Prop({ required: true }) startsAt: Date;
  @Prop({ required: true }) expiresAt: Date;

  /** active | cancelled (still runs to expiresAt) | revoked (refund / admin) */
  @Prop({ type: String, default: 'active', index: true }) status: 'active' | 'cancelled' | 'revoked';

  /** Amount paid, in kobo (purchases only). */
  @Prop() amountKobo?: number;
  @Prop() autoRenewing?: boolean;
  @Prop() note?: string;
  /** Staff name for admin grants / revocations. */
  @Prop() byName?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export type ProEntitlementDocument = HydratedDocument<ProEntitlement>;
export const ProEntitlementSchema = SchemaFactory.createForClass(ProEntitlement);
ProEntitlementSchema.index({ source: 1, ref: 1 }, { unique: true, partialFilterExpression: { ref: { $type: 'string' } } });
