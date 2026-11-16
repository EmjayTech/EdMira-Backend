import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { GetCurrentUser } from '../common/decorators/get-current-user.decorator';
import { AnalyticsService, CLIENT_EVENTS, ClientEventName } from './analytics.service';

class ClientEventDto {
  @IsIn(CLIENT_EVENTS)
  name: ClientEventName;

  /** One short tag, e.g. the leaderboard tab or card type — never personal data. */
  @IsOptional()
  @Matches(/^[a-z0-9_]{1,30}$/)
  detail?: string;
}

@ApiTags('Analytics')
@ApiBearerAuth()
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Post('events')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: `Record an app event: ${CLIENT_EVENTS.join(', ')}` })
  record(@GetCurrentUser('userId') userId: string, @Body() dto: ClientEventDto) {
    this.analytics.track(dto.name, userId, dto.detail ? { detail: dto.detail } : undefined);
  }
}
