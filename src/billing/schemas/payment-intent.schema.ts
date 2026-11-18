import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

/**
 * A started Paystack payment: who pays for which plan and how much. The
 * webhook (or a verify call) only grants Pro if Paystack confirms exactly this.
 */
@Schema({ collection: 'payment_intents', timestamps: true })
export class PaymentIntent {
  @Prop({ required: true, unique: true }) reference: string;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true })
  userId: mongoose.Types.ObjectId;

  @Prop({ required: true }) planId: string;
  @Prop({ required: true }) days: number;
  @Prop({ required: true }) amountKobo: number;

  @Prop({ type: String, default: 'pending', index: true }) status: 'pending' | 'paid' | 'failed' | 'refunded';
  @Prop() paidAt?: Date;

  createdAt?: Date;
}

export type PaymentIntentDocument = HydratedDocument<PaymentIntent>;
export const PaymentIntentSchema = SchemaFactory.createForClass(PaymentIntent);
