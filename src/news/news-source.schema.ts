import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * A trusted website the news fetcher reads (regulators, NCDC, universities…).
 * Only pages on the source's own site are ever fetched, so the allowlist is
 * the list of sources itself.
 */
@Schema({ timestamps: true })
export class NewsSource {
  @Prop({ required: true, trim: true })
  name: string;

  /** Homepage, news page or RSS/Atom feed. */
  @Prop({ required: true, trim: true })
  url: string;

  /** Tags stories from this source with a university, e.g. "University of Lagos". */
  @Prop({ trim: true })
  institution?: string;

  @Prop({ default: true })
  enabled: boolean;

  /** Publish straight away instead of waiting as a draft (only for fully trusted sources). */
  @Prop({ default: false })
  autoPublish: boolean;

  @Prop()
  lastCheckedAt?: Date;

  /** Stories added on the last check. */
  @Prop({ default: 0 })
  lastAdded: number;

  @Prop()
  lastError?: string;
}

export type NewsSourceDocument = HydratedDocument<NewsSource> & { createdAt?: Date; updatedAt?: Date };
export const NewsSourceSchema = SchemaFactory.createForClass(NewsSource);

/**
 * Links the fetcher has already considered, so each daily run only asks the
 * AI about new ones. Forgotten after 90 days.
 */
@Schema()
export class NewsSeenLink {
  @Prop({ required: true, unique: true })
  url: string;

  @Prop({ required: true, default: () => new Date(), expires: 60 * 60 * 24 * 90 })
  seenAt: Date;
}

export type NewsSeenLinkDocument = HydratedDocument<NewsSeenLink>;
export const NewsSeenLinkSchema = SchemaFactory.createForClass(NewsSeenLink);

/** Suggested starting list — admins edit it on the dashboard's News sources page. */
export const DEFAULT_NEWS_SOURCES: Pick<NewsSource, 'name' | 'url'>[] = [
  { name: 'NCDC', url: 'https://ncdc.gov.ng/news/press' },
  { name: 'NCDC situation reports', url: 'https://ncdc.gov.ng/diseases/sitreps' },
  { name: 'Federal Ministry of Health', url: 'https://www.health.gov.ng/' },
  { name: 'NUC', url: 'https://www.nuc.edu.ng/' },
  { name: 'MDCN', url: 'https://www.mdcn.gov.ng/' },
  { name: 'Nursing and Midwifery Council', url: 'https://www.nmcn.gov.ng/' },
  { name: 'Pharmacy Council of Nigeria', url: 'https://www.pcn.gov.ng/' },
  { name: 'JAMB', url: 'https://www.jamb.gov.ng/' },
  { name: 'NAFDAC', url: 'https://www.nafdac.gov.ng/' },
  { name: 'WHO Nigeria', url: 'https://www.afro.who.int/countries/nigeria' },
  { name: 'Nigeria Health Watch', url: 'https://nigeriahealthwatch.com/' },
];
