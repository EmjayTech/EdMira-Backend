import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumberString, IsOptional, Max, Min } from 'class-validator';
import { GetCurrentUser } from '../common/decorators/get-current-user.decorator';
import {
  BOARD_PERIODS,
  BOARD_SCOPES,
  BoardPeriod,
  BoardScope,
  LEADERBOARD_SCOPES,
  LeaderboardScope,
  LeaderboardService,
  MAX_PAGE,
} from './leaderboard.service';

class LegacyBoardQuery {
  @IsOptional()
  @IsIn(LEADERBOARD_SCOPES)
  scope?: LeaderboardScope;
}

class BoardQuery {
  @ApiProperty({ required: false, enum: BOARD_SCOPES, default: 'school' })
  @IsOptional()
  @IsIn(BOARD_SCOPES)
  scope?: BoardScope;

  @ApiProperty({ required: false, enum: BOARD_PERIODS, default: 'this_week' })
  @IsOptional()
  @IsIn(BOARD_PERIODS)
  period?: BoardPeriod;

  @ApiProperty({ required: false, default: 50, maximum: MAX_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  limit?: number;

  /** From `next_cursor` of the previous page. */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumberString({ no_symbols: true })
  cursor?: string;
}

class PeriodQuery {
  @IsOptional()
  @IsIn(BOARD_PERIODS)
  period?: BoardPeriod;
}

class HistoryQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(26)
  weeks?: number;
}

@ApiTags('Leaderboards')
@ApiBearerAuth()
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Controller()
export class LeaderboardController {
  constructor(private readonly leaderboards: LeaderboardService) {}

  @Get('leaderboard')
  @ApiOperation({
    summary:
      'A weekly board: school (default) · course (classmates) · level · department · all · friends; this_week or last_week. Ranked by points, then study days, then correct answers. Usernames, school short names, levels, points and study days only; plus your own rank (private if you are hidden).',
  })
  board(@GetCurrentUser('userId') userId: string, @Query() query: BoardQuery) {
    return this.leaderboards.board(userId, query.scope ?? 'school', query.period ?? 'this_week', {
      limit: query.limit ?? 50,
      offset: query.cursor ? Number(query.cursor) : 0,
    });
  }

  @Get('leaderboard/schools')
  @ApiOperation({ summary: 'School against school: average points per active student, schools with 5+ active students' })
  schoolsBoard(@GetCurrentUser('userId') userId: string, @Query() query: PeriodQuery) {
    return this.leaderboards.schoolsBoard(userId, query.period ?? 'this_week');
  }

  @Get('leaderboard/history')
  @ApiOperation({ summary: 'Your own weekly rank (in your school) and points for the last weeks' })
  history(@GetCurrentUser('userId') userId: string, @Query() query: HistoryQuery) {
    return this.leaderboards.history(userId, query.weeks ?? 8);
  }

  // ── Original API, kept for app builds already installed ──

  @Get('leaderboards')
  @ApiOperation({ summary: "Original API: this week's top 20 for a tab, plus your rank (use GET /leaderboard)." })
  legacyBoard(@GetCurrentUser('userId') userId: string, @Query() query: LegacyBoardQuery) {
    return this.leaderboards.legacyBoard(userId, query.scope ?? 'all');
  }

  @Get('leaderboards/schools')
  @ApiOperation({ summary: 'Original API: school against school this week (use GET /leaderboard/schools)' })
  schools() {
    return this.leaderboards.schools();
  }

  @Get('me/progress-summary')
  @ApiOperation({ summary: 'Streak, topics mastered and this week’s points / rank (for Progress and share cards)' })
  summary(@GetCurrentUser('userId') userId: string) {
    return this.leaderboards.summary(userId);
  }
}
