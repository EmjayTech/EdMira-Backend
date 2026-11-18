import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

/**
 * One trial per person: each trial records hashes of the account's email,
 * phone number and phone install. A new account matching any of them gets
 * no second trial. Kept even if the account is deleted.
 */
@Schema({ collection: 'trial_claims', timestamps: { createdAt: true, updatedAt: false } })
export class TrialClaim {
  /** e.g. "email:<sha256>", "phone:<sha256>", "install:<hash>". */
  @Prop({ required: true, unique: true }) key: string;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true })
  userId: mongoose.Types.ObjectId;
}

export type TrialClaimDocument = HydratedDocument<TrialClaim>;
export const TrialClaimSchema = SchemaFactory.createForClass(TrialClaim);
