import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NewsController } from './news.controller';
import { NewsArticle, NewsArticleSchema } from './news.schema';
import { NewsSeenLink, NewsSeenLinkSchema, NewsSource, NewsSourceSchema } from './news-source.schema';
import { NewsService } from './news.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: NewsArticle.name, schema: NewsArticleSchema },
      { name: NewsSource.name, schema: NewsSourceSchema },
      { name: NewsSeenLink.name, schema: NewsSeenLinkSchema },
    ]),
  ],
  controllers: [NewsController],
  providers: [NewsService],
  exports: [MongooseModule],
})
export class NewsModule {}
