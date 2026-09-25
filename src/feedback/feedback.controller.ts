import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { GetCurrentUser } from '../common/decorators/get-current-user.decorator';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { CreateFeedbackDto, CreateReportDto } from './dto/feedback.dto';
import { FeedbackService } from './feedback.service';

@ApiTags('Feedback')
@ApiBearerAuth()
@Controller()
export class FeedbackController {
  constructor(private readonly service: FeedbackService) {}

  @Post('questions/:questionId/reports')
  @ApiOperation({ summary: 'Report a problem with a question' })
  report(
    @GetCurrentUser('userId') studentId: string,
    @Param('questionId', ParseObjectIdPipe) questionId: string,
    @Body() dto: CreateReportDto,
  ) {
    return this.service.reportQuestion(studentId, questionId, dto);
  }

  @Post('feedback')
  @ApiOperation({ summary: 'Send product feedback' })
  feedback(@GetCurrentUser('userId') studentId: string, @Body() dto: CreateFeedbackDto) {
    return this.service.sendFeedback(studentId, dto);
  }
}
