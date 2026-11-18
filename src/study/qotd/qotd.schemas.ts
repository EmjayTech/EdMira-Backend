import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

/**
 * The Question of the Day for one group on one Lagos day. Created by the
 * first student to open it (or pinned ahead by an admin), so everyone in the
 * group gets the same question. Group keys: see qotd-groups.ts.
 */
@Schema({ collection: 'qotd_days', timestamps: true })
export class QotdDay {
  @Prop({ required: true }) day: string;
  @Prop({ required: true }) group: string;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true })
  questionId: mongoose.Types.ObjectId;

  @Prop({ default: false }) pinned: boolean;
  @Prop() pinnedBy?: string;

  @Prop({ default: 0 }) answeredCount: number;
}

export type QotdDayDocument = HydratedDocument<QotdDay>;
export const QotdDaySchema = SchemaFactory.createForClass(QotdDay);
QotdDaySchema.index({ day: 1, group: 1 }, { unique: true });
QotdDaySchema.index({ group: 1, day: -1 });

/** A student's one answer for one day. */
@Schema({ collection: 'qotd_answers' })
export class QotdAnswer {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true })
  userId: mongoose.Types.ObjectId;

  @Prop({ required: true }) day: string;
  @Prop({ required: true }) group: string;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true })
  questionId: mongoose.Types.ObjectId;

  @Prop({ required: true }) selectedIndex: number;
  @Prop({ required: true }) correct: boolean;
  @Prop({ required: true }) points: number;
  @Prop({ required: true }) answeredAt: Date;
}

export type QotdAnswerDocument = HydratedDocument<QotdAnswer>;
export const QotdAnswerSchema = SchemaFactory.createForClass(QotdAnswer);
QotdAnswerSchema.index({ userId: 1, day: 1 }, { unique: true });
