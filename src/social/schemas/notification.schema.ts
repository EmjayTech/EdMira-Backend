import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

export type NotificationType =
  | 'connection_request'
  | 'connection_accepted'
  | 'account_warning'
  /** An admin removed your profile photo (it broke the community rules). */
  | 'avatar_removed'
  | 'challenge_received'
  | 'challenge_result'
  | 'group_invite'
  /** Monday 9am: "Last week you finished #8 in UNILAG" (data: rank, school, week). */
  | 'leaderboard_weekly'
  /** Someone passed you in your school's top 10 (data: rank). */
  | 'leaderboard_overtaken'
  /** A classmate you invited completed their first quiz (fromId: them). */
  | 'referral_rewarded';

/**
 * In-app inbox. Declines and blocks never create one. Kept 90 days.
 * (Push notifications come later; their text must stay generic on the lock screen.)
 */
@Schema({ collection: 'notifications', timestamps: { createdAt: true, updatedAt: false } })
export class Notification {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true })
  userId: mongoose.Types.ObjectId;

  @Prop({ required: true })
  type: NotificationType;

  /** The other student (shown by username), if any. */
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User' })
  fromId?: mongoose.Types.ObjectId;

  /** What it's about (e.g. the challenge id), for opening it from the inbox. */
  @Prop() refId?: string;

  /** Numbers or short labels the app puts in the message (e.g. rank, school). */
  @Prop({ type: Object, default: undefined }) data?: Record<string, string | number>;

  @Prop() readAt?: Date;

  createdAt?: Date;
}

export type NotificationDocument = HydratedDocument<Notification>;
export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
