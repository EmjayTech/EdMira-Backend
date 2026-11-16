import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { GetCurrentUser } from '../common/decorators/get-current-user.decorator';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { ConnectionsService } from './connections.service';
import { NotificationsService } from './notifications.service';
import { PeopleService } from './people.service';
import { REPORT_CATEGORIES, REQUEST_NOTES, ReportCategory, RequestNote } from './social-policy';

class SearchQuery {
  @IsString() @MaxLength(40) q: string;
}
class RequestDto {
  @IsString() @MaxLength(64) username: string;
  @IsOptional() @IsIn(REQUEST_NOTES) note?: RequestNote;
}
class UsernameDto {
  @IsString() @MaxLength(64) username: string;
}
class ReportDto {
  @IsString() @MaxLength(64) username: string;
  @IsIn(REPORT_CATEGORIES) category: ReportCategory;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsOptional() @IsBoolean() block?: boolean;
}

/**
 * Find classmates, connection requests, block & report, inbox.
 * Every route needs a logged-in student; everything is authorised in the services.
 */
@ApiTags('Classmates')
@ApiBearerAuth()
@Controller()
export class SocialController {
  constructor(
    private readonly people: PeopleService,
    private readonly connections: ConnectionsService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get('people/search')
  // Per IP, on top of the per-student limits (30/min, 300/day). Generous because a
  // whole campus can share one public IP on university Wi-Fi.
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @ApiOperation({ summary: 'Search by username (3+ characters, max 10). Username, initials, school short name, level only.' })
  search(@GetCurrentUser('userId') userId: string, @Query() query: SearchQuery) {
    return this.people.search(userId, query.q);
  }

  @Get('people/:username')
  @ApiOperation({ summary: 'A student card. 404 for anyone you can’t see (any reason).' })
  card(@GetCurrentUser('userId') userId: string, @Param('username') username: string) {
    return this.people.card(userId, username);
  }

  @Post('connections')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send a connection request (optional preset note). Always { ok: true } — never reveals the outcome.' })
  request(@GetCurrentUser('userId') userId: string, @Body() dto: RequestDto) {
    return this.connections.request(userId, dto.username, dto.note);
  }

  @Get('connections')
  @ApiOperation({ summary: 'My accepted connections' })
  list(@GetCurrentUser('userId') userId: string) {
    return this.connections.list(userId);
  }

  @Get('connections/requests')
  @ApiOperation({ summary: 'Requests waiting for me (incoming) and the ones I sent (outgoing)' })
  requests(@GetCurrentUser('userId') userId: string) {
    return this.connections.requests(userId);
  }

  @Post('connections/:id/accept')
  @HttpCode(HttpStatus.OK)
  accept(@GetCurrentUser('userId') userId: string, @Param('id', ParseObjectIdPipe) id: string) {
    return this.connections.act(userId, id, 'accept');
  }

  @Post('connections/:id/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline silently — the sender is never told' })
  decline(@GetCurrentUser('userId') userId: string, @Param('id', ParseObjectIdPipe) id: string) {
    return this.connections.act(userId, id, 'decline');
  }

  @Post('connections/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@GetCurrentUser('userId') userId: string, @Param('id', ParseObjectIdPipe) id: string) {
    return this.connections.act(userId, id, 'cancel');
  }

  @Delete('connections/:id')
  @ApiOperation({ summary: 'Remove a connection (silently, either side)' })
  remove(@GetCurrentUser('userId') userId: string, @Param('id', ParseObjectIdPipe) id: string) {
    return this.connections.act(userId, id, 'remove');
  }

  @Get('blocks')
  blocked(@GetCurrentUser('userId') userId: string) {
    return this.connections.blocked(userId);
  }

  @Post('blocks')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Block (instant and silent). Always { ok: true }.' })
  block(@GetCurrentUser('userId') userId: string, @Body() dto: UsernameDto) {
    return this.connections.block(userId, dto.username);
  }

  @Delete('blocks/:username')
  unblock(@GetCurrentUser('userId') userId: string, @Param('username') username: string) {
    return this.connections.unblock(userId, username);
  }

  @Post('reports/users')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } }) // per IP (campus Wi-Fi is shared)
  @ApiOperation({ summary: 'Report a student (optionally also block). Always { ok: true }.' })
  report(@GetCurrentUser('userId') userId: string, @Body() dto: ReportDto) {
    return this.connections.report(userId, dto.username, dto.category, dto.note, dto.block);
  }

  @Get('notifications')
  inbox(@GetCurrentUser('userId') userId: string) {
    return this.notifications.inbox(userId);
  }

  @Post('notifications/read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async readAll(@GetCurrentUser('userId') userId: string) {
    await this.notifications.markAllRead(userId);
  }

  @Get('me/social-summary')
  @ApiOperation({ summary: 'Badge counts: incoming requests, unread notifications' })
  summary(@GetCurrentUser('userId') userId: string) {
    return this.connections.summary(userId);
  }
}
