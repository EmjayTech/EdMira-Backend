import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ContentStatus } from '../common/enum/content-status.enum';
import { NewsArticle, NewsArticleDocument } from '../news/news.schema';
import { adminNews } from './admin.presenter';
import { AuditService } from './audit/audit.service';
import { NewsInputDto, NewsStatusDto } from './dto/admin.dto';
import type { Staff } from './staff.guard';

/**
 * Campus news for the app's Home carousel. News isn't medical content, so an
 * admin publishes it directly — no review queue.
 */
@Injectable()
export class AdminNewsService {
  constructor(
    @InjectModel(NewsArticle.name) private readonly news: Model<NewsArticleDocument>,
    private readonly audit: AuditService,
  ) {}

  async list() {
    return (await this.news.find().sort({ publishedAt: -1 }).exec()).map(adminNews);
  }

  async save(staff: Staff, input: NewsInputDto, id?: string) {
    const errors: string[] = [];
    if (!input.title?.trim()) errors.push('Give the story a title.');
    if (!input.summary?.trim()) errors.push('Write a short summary.');
    if (errors.length) throw new BadRequestException(errors.join(' '));

    const fields = {
      title: input.title.trim(),
      summary: input.summary.trim(),
      body: input.body.map(p => p.trim()).filter(Boolean),
      category: input.category,
      institution: input.institution?.trim() || undefined,
      source: input.source?.trim() || 'EdMira',
      sourceUrl: input.sourceUrl?.trim() || undefined,
      imageUrl: input.imageUrl?.trim() || undefined,
      isSample: false,
    };

    if (!id) {
      const created = await this.news.create({
        ...fields,
        publishedAt: input.publishedAt ? new Date(input.publishedAt) : new Date(),
        status: ContentStatus.DRAFT,
        createdById: new Types.ObjectId(staff.id),
        createdByName: staff.name,
      });
      await this.audit.log(staff, 'news', created.id, 'created', `Drafted news “${created.title}”`);
      return adminNews(created);
    }

    const item = await this.findOr404(id);
    // `undefined` must unset optional fields, which Mongoose's set() does.
    item.set(fields);
    if (input.publishedAt) item.publishedAt = new Date(input.publishedAt);
    await item.save();
    await this.audit.log(staff, 'news', id, 'edited', `Edited news “${item.title}”`);
    return adminNews(item);
  }

  async setStatus(staff: Staff, id: string, status: NewsStatusDto['status']) {
    const item = await this.findOr404(id);
    if (status === ContentStatus.PUBLISHED && item.status !== ContentStatus.PUBLISHED) {
      // Publishing now puts it at the top of the carousel; a future date stays scheduled.
      if (item.publishedAt <= new Date()) item.publishedAt = new Date();
    }
    item.status = status;
    await item.save();
    const verb =
      status === ContentStatus.PUBLISHED ? 'published' : status === ContentStatus.ARCHIVED ? 'archived' : 'unpublished';
    await this.audit.log(staff, 'news', id, verb, `${verb[0].toUpperCase()}${verb.slice(1)} news “${item.title}”`);
    return adminNews(item);
  }

  private async findOr404(id: string) {
    const item = await this.news.findById(id).exec();
    if (!item) throw new NotFoundException('That story no longer exists.');
    return item;
  }
}
