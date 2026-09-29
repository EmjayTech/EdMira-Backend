import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

export enum SubscriptionSource {
  /** Bought in the Android app through Google Play Billing. */
  GOOGLE_PLAY = 'google_play',
  /** Given by EdMira (`yarn pro`, school deals, testing). */
  GRANT = 'grant',
}

/** Mirrors Google's SubscriptionState, without the prefix. */
export enum SubscriptionState {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  IN_GRACE_PERIOD = 'IN_GRACE_PERIOD',
  ON_HOLD = 'ON_HOLD',
  PAUSED = 'PAUSED',
  /** Auto-renew turned off; still Pro until expiresAt. */
  CANCELED = 'CANCELED',
  EXPIRED = 'EXPIRED',
  PENDING_PURCHASE_CANCELED = 'PENDING_PURCHASE_CANCELED',
  /** Upgraded/downgraded: a newer purchase token took over. */
  REPLACED = 'REPLACED',
}

/** States that still grant Pro while expiresAt is in the future. */
export const ENTITLED_STATES = [
  SubscriptionState.ACTIVE,
  SubscriptionState.IN_GRACE_PERIOD,
  SubscriptionState.CANCELED,
];

/**
 * One Pro entitlement: a Google Play subscription (one per purchase token)
 * or a manual grant. A student is Pro while any of theirs is entitled.
 */
@Schema({ timestamps: true })
export class Subscription {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true })
  userId: mongoose.Types.ObjectId;

  @Prop({ type: String, enum: Object.values(SubscriptionSource), required: true })
  source: SubscriptionSource;

  @Prop({ type: String, enum: Object.values(SubscriptionState), required: true })
  state: SubscriptionState;

  @Prop({ required: true })
  expiresAt: Date;

  /** Google Play: the subscription product and base plan bought. */
  @Prop()
  productId?: string;

  @Prop()
  basePlanId?: string;

  /** Google Play purchase token — identifies the subscription. */
  @Prop({ index: { unique: true, sparse: true } })
  purchaseToken?: string;

  @Prop()
  latestOrderId?: string;

  @Prop({ default: false })
  autoRenewing: boolean;

  @Prop({ default: false })
  testPurchase: boolean;

  /** Grants: why it was given (e.g. "UNILAG NiMSA deal"). */
  @Prop()
  note?: string;

  @Prop()
  lastVerifiedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export type SubscriptionDocument = HydratedDocument<Subscription>;
export const SubscriptionSchema = SchemaFactory.createForClass(Subscription);
SubscriptionSchema.index({ userId: 1, expiresAt: -1 });
