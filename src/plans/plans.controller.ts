import { BadRequestException, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { GetCurrentUser } from '../common/decorators/get-current-user.decorator';
import { PLAN_NOTICES, PlanNotice, PlansService } from './plans.service';

@ApiTags('Plans')
@ApiBearerAuth()
@Controller('me/plan')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @ApiOperation({
    summary: 'My plan: free | trial | pro, trial/Pro end, today’s questions left, which features are unlocked, the modal to show (if any) and the Pro plans',
  })
  mine(@GetCurrentUser('userId') userId: string) {
    return this.plans.summary(userId);
  }

  @Post('notices/:notice')
  @HttpCode(200)
  @ApiOperation({ summary: 'The app showed this plan modal (each shows once, on any device)' })
  seen(@GetCurrentUser('userId') userId: string, @Param('notice') notice: string) {
    if (!(PLAN_NOTICES as readonly string[]).includes(notice)) throw new BadRequestException('Unknown notice.');
    return this.plans.markNotice(userId, notice as PlanNotice);
  }
}
