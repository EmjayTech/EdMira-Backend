import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { GetCurrentUser } from '../common/decorators/get-current-user.decorator';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { ProFeature } from '../subscription/pro.constants';
import { SubscriptionService } from '../subscription/subscription.service';
import { ContentService } from './content.service';
import { NotesPdfService } from './notes-pdf.service';

@ApiTags('Content')
@ApiBearerAuth()
@Controller()
export class ContentController {
  constructor(
    private readonly content: ContentService,
    private readonly notesPdf: NotesPdfService,
    private readonly subscriptions: SubscriptionService,
  ) {}

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
  @ApiOperation({
    summary: 'Quiz questions for a topic — no answers or explanations',
    description: 'Free students get a few quizzes a day; past that, 403 with code PRO_REQUIRED.',
  })
  async getQuizQuestions(
    @GetCurrentUser('userId') userId: string,
    @Param('topicId', ParseObjectIdPipe) topicId: string,
  ) {
    await this.subscriptions.assertCanTakeQuiz(userId);
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

  @Get('topics/:topicId/notes')
  @ApiOperation({ summary: "A 15-minute link to the topic's study notes as a PDF (for offline reading)" })
  async topicNotes(
    @GetCurrentUser('userId') userId: string,
    @Param('topicId', ParseObjectIdPipe) topicId: string,
    @Req() req: Request,
  ) {
    await this.assertCanDownloadNotes(userId);
    return this.notesPdf.topicLink(topicId, `${req.protocol}://${req.get('host')}`);
  }

  @Get('courses/:courseId/notes')
  @ApiOperation({ summary: "A 15-minute link to all of a course's published notes as one PDF" })
  async courseNotes(
    @GetCurrentUser('userId') userId: string,
    @Param('courseId', ParseObjectIdPipe) courseId: string,
    @Req() req: Request,
  ) {
    await this.assertCanDownloadNotes(userId);
    return this.notesPdf.courseLink(courseId, `${req.protocol}://${req.get('host')}`);
  }

  /** Notes are free to read in the app; the offline PDF is EdMira Pro. */
  private assertCanDownloadNotes(userId: string) {
    return this.subscriptions.assertPro(
      userId,
      ProFeature.OFFLINE_DOWNLOADS,
      'Downloading notes for offline study is part of EdMira Pro.',
    );
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
