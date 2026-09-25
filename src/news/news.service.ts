import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ContentStatus } from '../common/enum/content-status.enum';
import { NewsArticle, NewsArticleDocument } from './news.schema';

const MAX_LIMIT = 20;

const present = (a: NewsArticleDocument) => ({
  id: a.id,
  title: a.title,
  summary: a.summary,
  body: [...a.body],
  category: a.category,
  institution: a.institution,
  source: a.source,
  sourceUrl: a.sourceUrl,
  imageUrl: a.imageUrl,
  publishedAt: a.publishedAt.toISOString(),
  isSample: a.isSample || undefined,
});

@Injectable()
export class NewsService {
  constructor(@InjectModel(NewsArticle.name) private readonly news: Model<NewsArticleDocument>) {}

  private visible() {
    return { status: ContentStatus.PUBLISHED, publishedAt: { $lte: new Date() } };
  }

  /** Latest published stories, newest first. */
  async latest(limit: number) {
    const safeLimit = Math.min(Math.max(1, limit || 6), MAX_LIMIT);
    const items = await this.news.find(this.visible()).sort({ publishedAt: -1 }).limit(safeLimit).exec();
    return items.map(present);
  }

  async findOne(id: string) {
    const item = await this.news.findOne({ _id: id, ...this.visible() }).exec();
    if (!item) throw new NotFoundException('Article not found');
    return present(item);
  }
}
