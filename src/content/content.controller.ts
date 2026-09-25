import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { ContentService } from './content.service';

@ApiTags('Content')
@ApiBearerAuth()
@Controller()
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Get('courses')
  @ApiOperation({ summary: 'Published courses with their published topics' })
  listCourses() {
    return this.content.listCourses();
  }

  @Get('courses/:courseId')
  @ApiOperation({ summary: 'One published course with its topics' })
  getCourse(@Param('courseId', ParseObjectIdPipe) courseId: string) {
    return this.content.getCourse(courseId);
  }

  @Get('topics/:topicId')
  @ApiOperation({ summary: 'A topic with its study material, its course and question count' })
  getTopic(@Param('topicId', ParseObjectIdPipe) topicId: string) {
    return this.content.getTopic(topicId);
  }

  @Get('topics/:topicId/questions')
  @ApiOperation({ summary: 'Quiz questions for a topic — no answers or explanations' })
  getQuizQuestions(@Param('topicId', ParseObjectIdPipe) topicId: string) {
    return this.content.getQuizQuestions(topicId);
  }

  @Get('search')
  @ApiQuery({ name: 'q', required: false })
  @ApiOperation({ summary: 'Search published courses and topics' })
  search(@Query('q') q = '') {
    return this.content.search(q);
  }
}
