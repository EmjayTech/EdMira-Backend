import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { GetCurrentUser } from '../common/decorators/get-current-user.decorator';
import { LEADERBOARD_SCOPES, LeaderboardScope, LeaderboardService } from './leaderboard.service';

class BoardQuery {
  @IsOptional()
  @IsIn(LEADERBOARD_SCOPES)
  scope?: LeaderboardScope;
}

@ApiTags('Leaderboards')
@ApiBearerAuth()
@Controller()
export class LeaderboardController {
  constructor(private readonly leaderboards: LeaderboardService) {}

  @Get('leaderboards')
  @ApiOperation({
    summary:
      "This week's top 20 for a tab (course = classmates: same school, programme and level · level · school · all), plus your rank. Usernames, school short names, levels and points only.",
  })
  board(@GetCurrentUser('userId') userId: string, @Query() query: BoardQuery) {
    return this.leaderboards.board(userId, query.scope ?? 'all');
  }

  @Get('leaderboards/schools')
  @ApiOperation({ summary: 'School against school this week: total and average points' })
  schools() {
    return this.leaderboards.schools();
  }

  @Get('me/progress-summary')
  @ApiOperation({ summary: 'Streak, topics mastered and this week’s points / rank (for Progress and share cards)' })
  summary(@GetCurrentUser('userId') userId: string) {
    return this.leaderboards.summary(userId);
  }
}
