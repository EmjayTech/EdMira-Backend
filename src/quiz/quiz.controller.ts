import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { GetCurrentUser } from '../common/decorators/get-current-user.decorator';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { SubmitAttemptDto } from './dto/submit-attempt.dto';
import { QuizService } from './quiz.service';

@ApiTags('Quizzes')
@ApiBearerAuth()
@Controller('quiz-attempts')
export class QuizController {
  constructor(private readonly quiz: QuizService) {}

  @Post()
  @ApiOperation({ summary: 'Submit a quiz; graded and stored on the server. Safe to retry.' })
  submit(@GetCurrentUser('userId') studentId: string, @Body() dto: SubmitAttemptDto) {
    return this.quiz.submit(studentId, dto);
  }

  @Get()
  @ApiOperation({ summary: "The current student's attempts, newest first" })
  list(@GetCurrentUser('userId') studentId: string) {
    return this.quiz.list(studentId);
  }

  @Get(':attemptId')
  @ApiOperation({ summary: 'One attempt with questions, answers and explanations (owner only)' })
  review(
    @GetCurrentUser('userId') studentId: string,
    @Param('attemptId', ParseObjectIdPipe) attemptId: string,
  ) {
    return this.quiz.review(studentId, attemptId);
  }
}
