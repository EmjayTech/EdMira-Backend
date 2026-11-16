import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';
import { REPORT_CATEGORIES, ReportCategory } from '../social-policy';

export const MODERATION_ACTIONS = ['dismiss', 'warn', 'rename', 'suspend', 'ban'] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

/** A student reported another student (admin → Moderation). */
@Schema({ collection: 'user_reports', timestamps: true })
export class UserReport {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true })
  reporterId: mongoose.Types.ObjectId;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true })
  reportedId: mongoose.Types.ObjectId;

  @Prop({ type: String, enum: REPORT_CATEGORIES, required: true })
  category: ReportCategory;

  @Prop({ maxlength: 300 })
  note?: string;

  /** Snapshot at report time: usernames and recent requests between the two. */
  @Prop({ type: Object })
  evidence?: Record<string, unknown>;

  @Prop({ type: String, enum: ['open', 'resolved'], default: 'open', index: true })
  status: 'open' | 'resolved';

  @Prop({ type: String, enum: MODERATION_ACTIONS })
  action?: ModerationAction;

  @Prop() actionNote?: string;
  @Prop() handledByName?: string;
  @Prop() handledAt?: Date;

  createdAt?: Date;
}

export type UserReportDocument = HydratedDocument<UserReport>;
export const UserReportSchema = SchemaFactory.createForClass(UserReport);
