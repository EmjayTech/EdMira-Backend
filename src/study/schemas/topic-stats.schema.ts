import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

/**
 * One student's results on one topic: powers "Continue learning", Focus Areas
 * (average < 60%, the same rule as the app's progressMath.ts) and the
 * improvement bonus. Every attempt counts, as in the app.
 */
@Schema({ collection: 'topic_stats', timestamps: true })
export class TopicStats {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true })
  userId: mongoose.Types.ObjectId;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Topic', required: true })
  topicId: mongoose.Types.ObjectId;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true })
  courseId: mongoose.Types.ObjectId;

  @Prop() topicTitle: string;
  @Prop() courseTitle: string;

  @Prop({ default: 0 }) attempts: number;
  @Prop({ default: 0 }) scoreSum: number;
  /** Rounded average score, 0–100. */
  @Prop({ default: 0 }) average: number;
  @Prop({ default: 0 }) best: number;
  @Prop({ default: 0 }) last: number;
  @Prop({ required: true }) lastAt: Date;

  /** Week (Lagos Monday) the improvement bonus was last given for this topic. */
  @Prop() improvedWeek?: string;
}

export type TopicStatsDocument = HydratedDocument<TopicStats>;
export const TopicStatsSchema = SchemaFactory.createForClass(TopicStats);
TopicStatsSchema.index({ userId: 1, topicId: 1 }, { unique: true });
TopicStatsSchema.index({ userId: 1, lastAt: -1 });
TopicStatsSchema.index({ userId: 1, average: 1 });
