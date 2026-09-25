import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose from 'mongoose';

/** Last review decision on a topic / question (set by the admin dashboard). */
@Schema({ _id: false })
export class ReviewRecord {
  @Prop({ enum: ['approved', 'changes_requested', 'rejected'] })
  decision: string;

  @Prop()
  note?: string;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User' })
  reviewerId?: mongoose.Types.ObjectId;

  @Prop()
  reviewerName?: string;

  @Prop()
  at: Date;
}

export const ReviewRecordSchema = SchemaFactory.createForClass(ReviewRecord);
