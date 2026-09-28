import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';
import { ContentStatus } from '../common/enum/content-status.enum';

export const NEWS_CATEGORIES = [
  'admissions',
  'exams',
  'scholarships',
  'calendar',
  'clinical',
  'general',
] as const;

/** Campus news shown in the app's Home carousel. */
@Schema({ timestamps: true })
export class NewsArticle {
  @Prop({ required: true, trim: true })
  title: string;

  @Prop({ default: '' })
  summary: string;

  /** Paragraphs. */
  @Prop({ type: [String], default: [] })
  body: string[];

  @Prop({ type: String, enum: NEWS_CATEGORIES, default: 'general' })
  category: string;

  @Prop()
  institution?: string;

  @Prop({ default: 'EdMira' })
  source: string;

  /** Original story; the app shows "Read full story" when set. */
  @Prop()
  sourceUrl?: string;

  @Prop()
  imageUrl?: string;

  @Prop({ required: true, index: true })
  publishedAt: Date;

  @Prop({ type: String, enum: Object.values(ContentStatus), default: ContentStatus.DRAFT, index: true })
  status: ContentStatus;

  /** Staff member who wrote it (admin dashboard). */
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User' })
  createdById?: mongoose.Types.ObjectId;

  @Prop()
  createdByName?: string;

  /** 'ai' = found and summarised by the news fetcher from a trusted source. */
  @Prop({ type: String, enum: ['manual', 'ai'], default: 'manual', index: true })
  origin: 'manual' | 'ai';

  /** News source the fetcher found it on. */
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'NewsSource' })
  sourceId?: mongoose.Types.ObjectId;

  /** Placeholder stories from the seed script; the app labels them "Sample". */
  @Prop({ default: false })
  isSample: boolean;
}

export type NewsArticleDocument = HydratedDocument<NewsArticle> & { createdAt?: Date; updatedAt?: Date };
export const NewsArticleSchema = SchemaFactory.createForClass(NewsArticle);
NewsArticleSchema.index({ sourceUrl: 1 });
