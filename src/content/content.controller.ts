import { publicBaseUrl } from '../common/public-url';
import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { TopicVersionsService } from './topic-versions.service';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { GetCurrentUser } from '../common/decorators/get-current-user.decorator';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { ContentService } from './content.service';
import { NotesPdfService } from './notes-pdf.service';
import { PlansService } from '../plans/plans.service';
import { lockNotes, lockVideo } from '../plans/plan-locks';

@ApiTags('Content')
@ApiBearerAuth()
@Controller()
export class ContentController {
  constructor(
    private readonly content: ContentService,
    private readonly notesPdf: NotesPdfService,
    private readonly versions: TopicVersionsService,
    private readonly plans: PlansService,
  ) {}

  /**
   * A figure image for study notes. Public (figures aren't secret) and cached
   * for a year: the id is the image's hash, so a changed image has a new URL.
   */
  @Public()
  @Get('content-assets/:id')
  @ApiOperation({ summary: 'A study-notes figure (SVG / PNG / JPEG / WebP)' })
  async asset(@Param('id') id: string, @Res() res: Response) {
    const { mimeType, data } = await this.versions.asset(id);
    res.set({
      'Content-Type': mimeType,
      'Content-Length': String(data.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      // SVGs are images, never pages that run anything.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    });
    res.end(data);
  }

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
    const result = await this.content.getTopic(topicId, await this.content.academicsOf(userId));
    // Free students see the extended notes and clinical correlation as locked headings.
    if (await this.plans.canUse(userId, 'extended_notes')) return result;
    return { ...result, topic: lockNotes(result.topic as Record<string, unknown>) };
  }

  @Get('topics/:topicId/questions')
  @ApiOperation({ summary: 'One quiz (up to 20 questions, unseen first) from a topic — no answers or explanations' })
  @ApiQuery({ name: 'ids', required: false, description: 'Comma-separated question ids (Retry weak questions)' })
  async getQuizQuestions(
    @GetCurrentUser('userId') userId: string,
    @Param('topicId', ParseObjectIdPipe) topicId: string,
    @Query('ids') ids?: string,
  ) {
    if (ids) await this.plans.assertFeature(userId, 'retry_weak');
    // The daily MCQ limit: 403 MCQ_LIMIT when nothing is left, else at most what's left today.
    const allowance = await this.plans.allowance(userId);
    if (allowance.remaining === 0) this.plans.limitReached(allowance);
    const set = await this.content.getQuizSet(topicId, userId, ids ? ids.split(',').map(s => s.trim()).filter(Boolean).slice(0, 100) : undefined);
    return allowance.remaining === null ? set : set.slice(0, allowance.remaining);
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
    const list = await this.content.listResources(courseId, await this.content.academicsOf(userId));
    return (await this.plans.canUse(userId, 'videos')) ? list : list.map(lockVideo);
  }

  @Get('topics/:topicId/notes')
  @ApiOperation({ summary: "A 15-minute link to the topic's study notes as a PDF (for offline reading)" })
  async topicNotes(@GetCurrentUser('userId') userId: string, @Param('topicId', ParseObjectIdPipe) topicId: string, @Req() req: Request) {
    await this.plans.assertFeature(userId, 'downloads');
    return this.notesPdf.topicLink(topicId, publicBaseUrl(req));
  }

  @Get('courses/:courseId/notes')
  @ApiOperation({ summary: "A 15-minute link to all of a course's published notes as one PDF" })
  async courseNotes(@GetCurrentUser('userId') userId: string, @Param('courseId', ParseObjectIdPipe) courseId: string, @Req() req: Request) {
    await this.plans.assertFeature(userId, 'downloads');
    return this.notesPdf.courseLink(courseId, publicBaseUrl(req));
  }

  @Get('resources/:resourceId/download')
  @ApiOperation({ summary: 'A 15-minute link to download an uploaded study material' })
  async downloadResource(
    @GetCurrentUser('userId') userId: string,
    @Param('resourceId', ParseObjectIdPipe) resourceId: string,
    @Req() req: Request,
  ) {
    await this.plans.assertFeature(userId, 'downloads');
    return this.content.resourceDownload(
      resourceId,
      await this.content.academicsOf(userId),
      publicBaseUrl(req),
    );
  }
}
