import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { GetCurrentUser } from '../common/decorators/get-current-user.decorator';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { ContentService } from './content.service';

@ApiTags('Content')
@ApiBearerAuth()
@Controller()
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Get('courses')
  @ApiOperation({
    summary: 'Published courses with their published topics',
    description: "Every course is returned; `forYou` is true for the student's level / department / school.",
  })
  async listCourses(@GetCurrentUser('userId') userId: string) {
    return this.content.listCourses(await this.content.academicsOf(userId));
  }

  @Get('courses/:courseId')
  @ApiOperation({ summary: 'One published course with its topics' })
  async getCourse(
    @GetCurrentUser('userId') userId: string,
    @Param('courseId', ParseObjectIdPipe) courseId: string,
  ) {
    return this.content.getCourse(courseId, await this.content.academicsOf(userId));
  }

  @Get('topics/:topicId')
  @ApiOperation({ summary: 'A topic with its study material, its course and question count' })
  async getTopic(
    @GetCurrentUser('userId') userId: string,
    @Param('topicId', ParseObjectIdPipe) topicId: string,
  ) {
    return this.content.getTopic(topicId, await this.content.academicsOf(userId));
  }

  @Get('topics/:topicId/questions')
  @ApiOperation({ summary: 'Quiz questions for a topic — no answers or explanations' })
  getQuizQuestions(@Param('topicId', ParseObjectIdPipe) topicId: string) {
    return this.content.getQuizQuestions(topicId);
  }

  @Get('search')
  @ApiQuery({ name: 'q', required: false })
  @ApiOperation({ summary: 'Search published courses and topics' })
  async search(@GetCurrentUser('userId') userId: string, @Query('q') q = '') {
    return this.content.search(q, await this.content.academicsOf(userId));
  }

  @Get('courses/:courseId/resources')
  @ApiOperation({
    summary: 'Study materials (slides, videos, textbooks, notes) for a course and its topics',
    description: "Published only; school-tagged materials only for that school's students.",
  })
  async listResources(
    @GetCurrentUser('userId') userId: string,
    @Param('courseId', ParseObjectIdPipe) courseId: string,
  ) {
    return this.content.listResources(courseId, await this.content.academicsOf(userId));
  }

  @Get('resources/:resourceId/download')
  @ApiOperation({ summary: 'A 15-minute link to download an uploaded study material' })
  async downloadResource(
    @GetCurrentUser('userId') userId: string,
    @Param('resourceId', ParseObjectIdPipe) resourceId: string,
    @Req() req: Request,
  ) {
    return this.content.resourceDownload(
      resourceId,
      await this.content.academicsOf(userId),
      `${req.protocol}://${req.get('host')}`,
    );
  }
}
