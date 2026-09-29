import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { GetCurrentUser } from '../common/decorators/get-current-user.decorator';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { StartMockExamDto, SubmitMockExamDto } from './dto/mock-exam.dto';
import { MockExamService } from './mock-exam.service';

@ApiTags('Mock exams (EdMira Pro)')
@ApiBearerAuth()
@Controller('mock-exams')
export class MockExamController {
  constructor(private readonly exams: MockExamService) {}

  @Post()
  @ApiOperation({
    summary: 'Start a timed mixed-topic mock exam for a course (Pro)',
    description: 'Returns the questions (no answers) and the deadline. 403 PRO_REQUIRED for free students.',
  })
  start(@GetCurrentUser('userId') studentId: string, @Body() dto: StartMockExamDto) {
    return this.exams.start(studentId, dto.courseId, dto.questionCount);
  }

  @Post(':examId/submit')
  @ApiOperation({ summary: 'Submit answers; graded on the server. Safe to retry.' })
  submit(
    @GetCurrentUser('userId') studentId: string,
    @Param('examId', ParseObjectIdPipe) examId: string,
    @Body() dto: SubmitMockExamDto,
  ) {
    return this.exams.submit(studentId, examId, dto.answers);
  }

  @Get()
  @ApiOperation({ summary: "The student's submitted mock exams, newest first" })
  list(@GetCurrentUser('userId') studentId: string) {
    return this.exams.list(studentId);
  }

  @Get(':examId')
  @ApiOperation({ summary: 'A submitted mock exam with answers (explanations for Pro)' })
  review(
    @GetCurrentUser('userId') studentId: string,
    @Param('examId', ParseObjectIdPipe) examId: string,
  ) {
    return this.exams.review(studentId, examId);
  }
}
