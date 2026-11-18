import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';
import { MaterialSection, MaterialSectionSchema, TopicFigure, TopicFigureSchema } from './topic.schema';
import { ReviewRecord, ReviewRecordSchema } from './review.schema';

export const TOPIC_VERSION_STATUSES = ['in_review', 'changes_requested', 'rejected', 'published', 'superseded'] as const;
export type TopicVersionStatus = (typeof TOPIC_VERSION_STATUSES)[number];

/**
 * One version of a topic's notes. Imports never overwrite live notes: they add
 * version N+1 "in_review". Approving it copies it onto the topic (live) and
 * the previous live version becomes "superseded" — still here, so it can be
 * compared and restored. Version 0 is a snapshot of the notes from before.
 */
@Schema({ collection: 'topic_versions', timestamps: true })
export class TopicVersion {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Topic', required: true, index: true })
  topicId: mongoose.Types.ObjectId;

  @Prop({ required: true }) version: number;
  @Prop({ type: String, enum: TOPIC_VERSION_STATUSES, required: true, index: true }) status: TopicVersionStatus;

  @Prop({ required: true }) title: string;
  @Prop({ default: '' }) summary: string;
  @Prop() readMinutes?: number;
  @Prop({ type: [String], default: [] }) objectives: string[];
  @Prop({ type: [String], default: [] }) keyPoints: string[];
  @Prop({ type: [MaterialSectionSchema], default: [] }) material: MaterialSection[];
  @Prop({ type: [MaterialSectionSchema], default: [] }) extended: MaterialSection[];
  @Prop({ type: [MaterialSectionSchema], default: [] }) clinical: MaterialSection[];
  @Prop({ type: [String], default: [] }) revision: string[];
  @Prop({ type: [TopicFigureSchema], default: [] }) figures: TopicFigure[];
  @Prop({ type: [String], default: [] }) furtherReading: string[];
  @Prop() curriculumId?: string;
  /** Where the topic sits in its course (1, 2, 3 … in curriculum order). */
  @Prop() order?: number;
  @Prop({ type: [String], default: [] }) credits: string[];
  /** Contributor records (lecturers' own notes, with permission) used in it. */
  @Prop({ type: [String], default: [] }) contributorIds: string[];
  /**
   * "⚑" check markers the writer left: each must be confirmed, corrected or
   * removed by a reviewer (recorded here) before the version can go live.
   */
  @Prop({ type: [Object], default: [] }) flags: {
    id: string;
    where: string;
    location: Record<string, unknown>;
    excerpt: string;
    questionId?: string;
    status: 'open' | 'confirmed' | 'corrected' | 'removed';
    resolution?: { action: 'confirm' | 'correct' | 'remove'; text?: string; note?: string; by: string; at: Date };
  }[];

  /** Originality check: passages that closely match other text, for rewriting. */
  @Prop({ type: [Object], default: [] }) originality: { section: string; passage: string; matches: string; score: number }[];

  /** Hash of the content: re-importing unchanged files adds nothing. */
  @Prop({ required: true }) contentHash: string;
  /** Questions written for this version (Question.topicVersion). */
  @Prop({ default: 0 }) questionCount: number;
  /** Where it came from, e.g. "content-library/notes/physiology". */
  @Prop() source?: string;
  @Prop() createdByName?: string;
  @Prop({ type: ReviewRecordSchema }) lastReview?: ReviewRecord;
  @Prop() publishedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export type TopicVersionDocument = HydratedDocument<TopicVersion>;
export const TopicVersionSchema = SchemaFactory.createForClass(TopicVersion);
TopicVersionSchema.index({ topicId: 1, version: 1 }, { unique: true });
