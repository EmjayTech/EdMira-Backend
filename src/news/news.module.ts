import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NewsController } from './news.controller';
import { NewsArticle, NewsArticleSchema } from './news.schema';
import { NewsService } from './news.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: NewsArticle.name, schema: NewsArticleSchema }])],
  controllers: [NewsController],
  providers: [NewsService],
  exports: [MongooseModule],
})
export class NewsModule {}
