import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';
import { ContentStatus } from '../../common/enum/content-status.enum';
import { Institution } from '../../common/enum/institution.enum';
import { ReviewRecord, ReviewRecordSchema } from './review.schema';

/**
 * A study material attached to a course (or one of its topics): lecture
 * slides, a YouTube video, a textbook, or other notes/handouts. Shown in the
 * app as "Study materials" and goes through the same review as topics.
 *
 * Exactly one of `file` (uploaded, see storage/) or `link` is set. Videos are
 * YouTube links.
 */
export const RESOURCE_KINDS = ['slides', 'video', 'textbook', 'notes'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

@Schema({ _id: false })
export class ResourceFile {
  @Prop({ required: true }) key: string;
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) size: number;
  @Prop({ required: true }) mimeType: string;
}
const ResourceFileSchema = SchemaFactory.createForClass(ResourceFile);

@Schema({ timestamps: true })
export class Resource {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true })
  courseId: mongoose.Types.ObjectId;

  /** Set when the material belongs to one topic rather than the whole course. */
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Topic', index: true })
  topicId?: mongoose.Types.ObjectId;

  @Prop({ type: String, enum: RESOURCE_KINDS, required: true })
  kind: ResourceKind;

  @Prop({ required: true, trim: true })
  title: string;

  @Prop({ default: '' })
  description: string;

  /** A school's own material (e.g. its lecture slides): only its students see it. */
  @Prop({ type: String, enum: Object.values(Institution) })
  institution?: Institution;

  @Prop({ type: ResourceFileSchema })
  file?: ResourceFile;

  @Prop()
  link?: string;

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

export type ResourceDocument = HydratedDocument<Resource>;
export const ResourceSchema = SchemaFactory.createForClass(Resource);

/** The video id from any common YouTube URL shape, or null. */
export function youTubeId(url?: string): string | null {
  if (!url) return null;
  const match = url.match(
    /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/,
  );
  return match ? match[1] : null;
}
