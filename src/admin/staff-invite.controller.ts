import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { AdminTeamService } from './admin-team.service';
import { AcceptInviteDto } from './dto/admin.dto';

/**
 * The invitee's side of a staff invite. Public: the one-time token in the
 * link is the credential (32 random bytes; only its hash is stored).
 */
@ApiTags('Admin')
@Controller('admin/invites')
export class StaffInviteController {
  constructor(private readonly team: AdminTeamService) {}

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':token')
  @ApiOperation({ summary: 'Who an invite link is for (before setting a password)' })
  lookup(@Param('token') token: string) {
    return this.team.lookupInvite(token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':token/accept')
  @ApiOperation({ summary: 'Set name and password; then sign in with /auth/login' })
  accept(@Param('token') token: string, @Body() dto: AcceptInviteDto) {
    return this.team.acceptInvite(token, dto);
  }
}
