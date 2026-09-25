import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
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

  /** Placeholder stories from the seed script; the app labels them "Sample". */
  @Prop({ default: false })
  isSample: boolean;
}

export type NewsArticleDocument = HydratedDocument<NewsArticle>;
export const NewsArticleSchema = SchemaFactory.createForClass(NewsArticle);
