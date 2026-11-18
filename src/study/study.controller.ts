import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsInt, IsMongoId, Max, Min } from 'class-validator';
import { GetCurrentUser } from '../common/decorators/get-current-user.decorator';
import { WEEKLY_GOAL } from './points-config';
import { QotdService } from './qotd/qotd.service';
import { StudyService } from './study.service';

class StudyGoalDto {
  @ApiProperty({ minimum: WEEKLY_GOAL.min, maximum: WEEKLY_GOAL.max, example: 3 })
  @IsInt()
  @Min(WEEKLY_GOAL.min)
  @Max(WEEKLY_GOAL.max)
  weeklyDays: number;
}

class QotdAnswerDto {
  @ApiProperty()
  @IsMongoId()
  questionId: string;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  selectedIndex: number;
}

@ApiTags('Study')
@ApiBearerAuth()
@Controller()
export class StudyController {
  constructor(
    private readonly study: StudyService,
    private readonly qotd: QotdService,
  ) {}

  @Patch('me/study-goal')
  @ApiOperation({ summary: 'Set the weekly goal: study days a week (1–7, default 3)' })
  setGoal(@GetCurrentUser('userId') userId: string, @Body() dto: StudyGoalDto) {
    return this.study.setWeeklyGoal(userId, dto.weeklyDays);
  }

  @Get('qotd')
  @ApiOperation({
    summary:
      "Today's Question of the Day for your level + department (never the answer until you've answered), your answer if any, and how many answered (null under 20)",
  })
  today(@GetCurrentUser('userId') userId: string) {
    return this.qotd.today(userId);
  }

  @Post('qotd/answer')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Answer today\'s question once; graded here. Returns correct/incorrect, the explanation and points. Sending again returns the stored result. 409 QOTD_CHANGED if the day has moved on.',
  })
  answer(@GetCurrentUser('userId') userId: string, @Body() dto: QotdAnswerDto) {
    return this.qotd.answer(userId, dto.questionId, dto.selectedIndex);
  }
}
