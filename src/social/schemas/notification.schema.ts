import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

export type NotificationType =
  | 'connection_request'
  | 'connection_accepted'
  | 'account_warning'
  | 'challenge_received'
  | 'challenge_result'
  | 'group_invite';

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

  @Prop() readAt?: Date;

  createdAt?: Date;
}

export type NotificationDocument = HydratedDocument<Notification>;
export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
