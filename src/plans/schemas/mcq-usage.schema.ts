import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

/** Answered practice questions per student per Lagos day (the daily MCQ limit). QOTD doesn't count. */
@Schema({ collection: 'mcq_usage', timestamps: { createdAt: false, updatedAt: true } })
export class McqUsage {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true })
  userId: mongoose.Types.ObjectId;

  /** Lagos calendar day, YYYY-MM-DD. */
  @Prop({ required: true }) day: string;

  @Prop({ default: 0 }) answered: number;
}

export type McqUsageDocument = HydratedDocument<McqUsage>;
export const McqUsageSchema = SchemaFactory.createForClass(McqUsage);
McqUsageSchema.index({ userId: 1, day: 1 }, { unique: true });
// Old days aren't needed after a while.
McqUsageSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 60 * 86_400 });
