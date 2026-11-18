import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsMongoId, IsOptional, IsString, Matches, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { GetCurrentUser } from '../common/decorators/get-current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { ChallengesService } from './challenges.service';
import { ReferralsService } from './referrals.service';

class CreateChallengeDto {
  @IsMongoId() topicId: string;
  /** A connection's username; leave out to make a link to share. */
  @IsOptional() @IsString() @MaxLength(64) username?: string;
}
class ChallengeAnswerDto {
  @IsMongoId() questionId: string;
  @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) selectedIndex: number | null;
}
class SubmitChallengeDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ChallengeAnswerDto)
  answers: ChallengeAnswerDto[];
}
const CODE = /^[a-z0-9]{6,12}$/i;

/** Challenge a friend, and invite links. */
@ApiTags('Challenges & invites')
@Controller()
export class ChallengesController {
  constructor(
    private readonly challenges: ChallengesService,
    private readonly referrals: ReferralsService,
  ) {}

  // ── Public: the edmira.org/join and /challenge pages ──

  @Public()
  @Get('invites/:username')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Invite page: { username, initials, school?, level? } — 404 if not available' })
  invite(@Param('username') username: string) {
    return this.referrals.publicInvite(username);
  }

  @Public()
  @Get('challenges/public/:code')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Challenge page: challenger username, topic, still open?' })
  publicChallenge(@Param('code') code: string) {
    if (!CODE.test(code)) return this.challenges.publicLink('-');
    return this.challenges.publicLink(code);
  }

  // ── Signed in ──

  @Get('me/referrals')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Classmates you invited: joined · pending · rewarded, points earned (+10 each), lifetime points and the latest 20',
  })
  myReferrals(@GetCurrentUser('userId') userId: string) {
    // `count` is kept for older app versions.
    return this.referrals.mine(userId);
  }

  @Post('challenges')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Challenge a connection on a topic (username), or create a link to share (no username)' })
  create(@GetCurrentUser('userId') userId: string, @Body() dto: CreateChallengeDto) {
    return this.challenges.create(userId, dto.topicId, dto.username);
  }

  @Get('challenges')
  @ApiBearerAuth()
  list(@GetCurrentUser('userId') userId: string) {
    return this.challenges.list(userId);
  }

  @Get('challenges/link/:code')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Open a shared challenge link (claims it, or first sends a connection request from the challenger)' })
  openLink(@GetCurrentUser('userId') userId: string, @Param('code') code: string) {
    if (!CODE.test(code)) return this.challenges.publicLink('-');
    return this.challenges.openLink(userId, code);
  }

  @Get('challenges/:id')
  @ApiBearerAuth()
  get(@GetCurrentUser('userId') userId: string, @Param('id', ParseObjectIdPipe) id: string) {
    return this.challenges.get(userId, id);
  }

  @Post('challenges/:id/accept')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  accept(@GetCurrentUser('userId') userId: string, @Param('id', ParseObjectIdPipe) id: string) {
    return this.challenges.respond(userId, id, 'accept');
  }

  @Post('challenges/:id/decline')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  decline(@GetCurrentUser('userId') userId: string, @Param('id', ParseObjectIdPipe) id: string) {
    return this.challenges.respond(userId, id, 'decline');
  }

  @Post('challenges/:id/cancel')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  cancel(@GetCurrentUser('userId') userId: string, @Param('id', ParseObjectIdPipe) id: string) {
    return this.challenges.respond(userId, id, 'cancel');
  }

  @Post('challenges/:id/start')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start my run: the server records the time and returns the questions (no answers)' })
  start(@GetCurrentUser('userId') userId: string, @Param('id', ParseObjectIdPipe) id: string) {
    return this.challenges.start(userId, id);
  }

  @Post('challenges/:id/submit')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  submit(@GetCurrentUser('userId') userId: string, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: SubmitChallengeDto) {
    return this.challenges.submit(userId, id, dto.answers);
  }
}
