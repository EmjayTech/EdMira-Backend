import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { NewsService } from './news.service';

@ApiTags('News')
@ApiBearerAuth()
@Controller('news')
export class NewsController {
  constructor(private readonly news: NewsService) {}

  @Get()
  @ApiQuery({ name: 'limit', required: false, description: '1–20, default 6' })
  @ApiOperation({ summary: 'Latest published campus news' })
  latest(@Query('limit', new DefaultValuePipe(6), ParseIntPipe) limit: number) {
    return this.news.latest(limit);
  }

  @Get(':articleId')
  @ApiOperation({ summary: 'One published story' })
  findOne(@Param('articleId', ParseObjectIdPipe) articleId: string) {
    return this.news.findOne(articleId);
  }
}
