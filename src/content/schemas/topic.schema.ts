import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';
import { ContentStatus } from '../../common/enum/content-status.enum';
import { ReviewRecord, ReviewRecordSchema } from './review.schema';

@Schema({ _id: false })
export class MaterialSection {
  @Prop({ required: true })
  heading: string;

  @Prop({ required: true })
  body: string;

  @Prop({ type: [String], default: undefined })
  keyPoints?: string[];
}

const MaterialSectionSchema = SchemaFactory.createForClass(MaterialSection);

@Schema({ timestamps: true })
export class Topic {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true })
  courseId: mongoose.Types.ObjectId;

  @Prop({ required: true, trim: true })
  title: string;

  @Prop({ required: true, min: 1 })
  order: number;

  @Prop({ default: '' })
  summary: string;

  @Prop()
  readMinutes?: number;

  @Prop({ type: [MaterialSectionSchema], default: [] })
  material: MaterialSection[];

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

export type TopicDocument = HydratedDocument<Topic>;
export const TopicSchema = SchemaFactory.createForClass(Topic);
TopicSchema.index({ courseId: 1, order: 1 });
