import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';
import { GetCurrentUser } from '../common/decorators/get-current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { Throttle } from '@nestjs/throttler';
import { GroupsService } from './groups.service';
import { PeopleService } from './people.service';

class CreateGroupDto {
  @IsString() @MaxLength(60) name: string;
  @IsOptional() @IsMongoId() courseId?: string;
}
class InviteDto {
  @IsString() @MaxLength(64) username: string;
}
class CodeDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() reset?: boolean;
}

/** Study groups and profiles. */
@ApiTags('Groups & profiles')
@Controller()
export class GroupsController {
  constructor(
    private readonly groups: GroupsService,
    private readonly people: PeopleService,
  ) {}

  // ── Profiles ──

  @Get('me/profile')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My profile as others see it (badges, streak, topics mastered)' })
  myProfile(@GetCurrentUser('userId') userId: string) {
    return this.people.myProfile(userId);
  }

  @Public()
  @Get('profiles/:username')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Public profile (no login) — only for students who made theirs public; 404 otherwise' })
  publicProfile(@Param('username') username: string) {
    return this.people.publicProfile(username);
  }

  // ── Groups ──

  @Post('groups')
  @ApiBearerAuth()
  create(@GetCurrentUser('userId') userId: string, @Body() dto: CreateGroupDto) {
    return this.groups.create(userId, dto.name, dto.courseId);
  }

  @Get('groups')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My groups and invitations waiting for me' })
  mine(@GetCurrentUser('userId') userId: string) {
    return this.groups.mine(userId);
  }

  @Get('groups/code/:code')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'What a group code leads to (before joining)' })
  preview(@GetCurrentUser('userId') userId: string, @Param('code') code: string) {
    return this.groups.preview(userId, code);
  }

  @Post('groups/code/:code/join')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  join(@GetCurrentUser('userId') userId: string, @Param('code') code: string) {
    return this.groups.joinByCode(userId, code);
  }

  @Get('groups/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'A group I belong to: members, this week, recent activity (404 otherwise)' })
  detail(@GetCurrentUser('userId') userId: string, @Param('id', ParseObjectIdPipe) id: string) {
    return this.groups.detail(userId, id);
  }

  @Post('groups/:id/invites')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Invite one of your accepted connections (they must accept)' })
  invite(@GetCurrentUser('userId') userId: string, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: InviteDto) {
    return this.groups.invite(userId, id, dto.username);
  }

  @Post('groups/:id/invites/accept')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  accept(@GetCurrentUser('userId') userId: string, @Param('id', ParseObjectIdPipe) id: string) {
    return this.groups.answerInvite(userId, id, true);
  }

  @Post('groups/:id/invites/decline')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  decline(@GetCurrentUser('userId') userId: string, @Param('id', ParseObjectIdPipe) id: string) {
    return this.groups.answerInvite(userId, id, false);
  }

  @Post('groups/:id/code')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Owner: turn the join code on/off, or reset it' })
  setCode(@GetCurrentUser('userId') userId: string, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: CodeDto) {
    return this.groups.setCode(userId, id, dto);
  }

  @Delete('groups/:id/members/:username')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Owner: remove a member' })
  remove(@GetCurrentUser('userId') userId: string, @Param('id', ParseObjectIdPipe) id: string, @Param('username') username: string) {
    return this.groups.removeMember(userId, id, username);
  }

  @Post('groups/:id/leave')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  leave(@GetCurrentUser('userId') userId: string, @Param('id', ParseObjectIdPipe) id: string) {
    return this.groups.leave(userId, id);
  }
}
