import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

/**
 * Every username a student has given up. Kept permanently (support and
 * moderation can see who used a name); while `reservedUntil` is in the
 * future, nobody else can take that name.
 */
@Schema({ collection: 'username_history', timestamps: { createdAt: true, updatedAt: false } })
export class UsernameHistory {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true })
  userId: mongoose.Types.ObjectId;

  /** The old username as it was written. */
  @Prop({ required: true })
  username: string;

  @Prop({ required: true, index: true })
  usernameLower: string;

  @Prop({ required: true })
  releasedAt: Date;

  @Prop({ required: true })
  reservedUntil: Date;

  /** 'student' when they changed it themselves; the staff member's name when forced. */
  @Prop({ required: true })
  changedBy: string;
}

export type UsernameHistoryDocument = HydratedDocument<UsernameHistory>;
export const UsernameHistorySchema = SchemaFactory.createForClass(UsernameHistory);
