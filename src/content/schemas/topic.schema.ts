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

export const MaterialSectionSchema = SchemaFactory.createForClass(MaterialSection);

/**
 * A numbered figure ("Figure 6.2"). `assetId` points at content_assets (served
 * at /content-assets/:id). Sections show it where their body says {{fig:<key>}}.
 */
@Schema({ _id: false })
export class TopicFigure {
  /** Stable within the topic, e.g. "nephron". */
  @Prop({ required: true }) key: string;
  /** "Figure 6.2" */
  @Prop({ required: true }) label: string;
  @Prop({ required: true }) caption: string;
  /** For screen readers: what the figure shows. */
  @Prop({ required: true }) alt: string;
  /** Where it's from: "EdMira" (our own), "Servier Medical Art" or "Wikimedia Commons". */
  @Prop({ default: 'EdMira' }) source: string;
  /** e.g. "Original", "CC BY 4.0", "CC BY-SA 4.0", "CC0", "Public domain". Never NC / ND. */
  @Prop({ default: 'Original' }) licence: string;
  /** Shown under the figure (required for anything not our own). */
  @Prop({ default: '' }) attributionText: string;
  @Prop() originalUrl?: string;
  /** We changed it (cropped, relabelled, recoloured…). */
  @Prop({ default: false }) modified: boolean;
  @Prop({ required: true }) assetId: string;
  @Prop() mimeType?: string;
}

export const TopicFigureSchema = SchemaFactory.createForClass(TopicFigure);

/**
 * The study notes of a topic in the standard format. Lives on the topic (the
 * live version) and on each TopicVersion (drafts and history).
 *
 *   standard (Free): objectives · key points · `material` · summary box
 *   extended (Pro):  `extended` sections and `clinical` correlation
 */
export class TopicNotes {
  objectives?: string[];
  keyPoints?: string[];
  material: MaterialSection[];
  extended?: MaterialSection[];
  clinical?: MaterialSection[];
  /** The "quick revision" box. */
  revision?: string[];
  figures?: TopicFigure[];
  furtherReading?: string[];
}

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

  // ── Standard note format (imported topics; older topics may only have `material`) ──
  @Prop({ type: [String], default: undefined }) objectives?: string[];
  @Prop({ type: [String], default: undefined }) keyPoints?: string[];
  /** Extended notes (Pro). */
  @Prop({ type: [MaterialSectionSchema], default: undefined }) extended?: MaterialSection[];
  /** Clinical correlation (Pro). */
  @Prop({ type: [MaterialSectionSchema], default: undefined }) clinical?: MaterialSection[];
  @Prop({ type: [String], default: undefined }) revision?: string[];
  @Prop({ type: [TopicFigureSchema], default: undefined }) figures?: TopicFigure[];
  /** "Further reading" citations (e.g. "Guyton & Hall, ch. 9") — cited, never copied. */
  @Prop({ type: [String], default: undefined }) furtherReading?: string[];
  /** Curriculum tag, e.g. "PHY-05-03" (content-import/curriculum/*.json). */
  @Prop({ index: true, sparse: true }) curriculumId?: string;
  /** "Notes contributed by …" (contributors who asked to be credited). */
  @Prop({ type: [String], default: undefined }) credits?: string[];
  /** The reviewer who approved the live notes, and when. */
  @Prop() reviewedBy?: string;
  @Prop() reviewedAt?: Date;
  /** Stable id from the content files (re-imports find the topic by it). */
  @Prop({ index: true, sparse: true }) importKey?: string;
  /** Which TopicVersion is live (0 = the notes from before versioning). */
  @Prop() liveVersion?: number;

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
