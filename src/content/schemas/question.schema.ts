import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';
import { ContentStatus } from '../../common/enum/content-status.enum';
import { ReviewRecord, ReviewRecordSchema } from './review.schema';

@Schema({ timestamps: true })
export class Question {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Topic', required: true, index: true })
  topicId: mongoose.Types.ObjectId;

  @Prop({ required: true })
  stem: string;

  @Prop({
    type: [String],
    validate: {
      validator: (options: string[]) =>
        options.length >= 2 && options.length <= 6 && new Set(options).size === options.length,
      message: 'A question needs 2–6 different options.',
    },
  })
  options: string[];

  /** Index into `options`. Never sent to students before they submit. */
  @Prop({ required: true, min: 0 })
  answerIndex: number;

  @Prop()
  explanation?: string;

  @Prop({ type: String, enum: ['easy', 'medium', 'hard'] }) difficulty?: 'easy' | 'medium' | 'hard';
  /** recall · understanding · clinical application */
  @Prop({ type: String, enum: ['recall', 'understanding', 'clinical'] }) kind?: 'recall' | 'understanding' | 'clinical';
  /** Curriculum tag of its topic, e.g. "PHY-05-03". */
  @Prop({ index: true, sparse: true }) tag?: string;
  /** The notes version it was written for (missing = before versioning). */
  @Prop() topicVersion?: number;
  /** Archived because this topic version went live (restoring an older version brings it back). */
  @Prop() retiredByVersion?: number;

  @Prop({ type: String, enum: Object.values(ContentStatus), default: ContentStatus.DRAFT, index: true })
  status: ContentStatus;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User' })
  createdById?: mongoose.Types.ObjectId;

  @Prop()
  createdByName?: string;

  @Prop({ type: ReviewRecordSchema })
  lastReview?: ReviewRecord;

  createdAt?: Date;
  updatedAt?: Date;
}

export type QuestionDocument = HydratedDocument<Question>;
export const QuestionSchema = SchemaFactory.createForClass(Question);
QuestionSchema.path('answerIndex').validate(function (this: Question, value: number) {
  return value < (this.options?.length ?? 0);
}, 'answerIndex must point at one of the options.');
