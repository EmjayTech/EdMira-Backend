import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { timingSafeEqual } from 'crypto';
import { GetCurrentUser } from '../common/decorators/get-current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { VerifyGooglePurchaseDto } from './dto/verify-google-purchase.dto';
import { SubscriptionService } from './subscription.service';

@ApiTags('Subscription (EdMira Pro)')
@ApiBearerAuth()
@Controller('subscription')
export class SubscriptionController {
  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @ApiOperation({ summary: "The student's plan (free / pro), expiry and today's quiz allowance" })
  status(@GetCurrentUser('userId') userId: string) {
    return this.subscriptions.status(userId);
  }

  @Post('google/verify')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verify a Google Play purchase (new or restored) and unlock Pro',
    description: 'Checks the token with Google, binds it to this account and acknowledges it.',
  })
  verifyGoogle(@GetCurrentUser('userId') userId: string, @Body() dto: VerifyGooglePurchaseDto) {
    return this.subscriptions.verifyGooglePurchase(userId, dto.productId, dto.purchaseToken);
  }

  /**
   * Google Play Real-time Developer Notifications, pushed by Pub/Sub to
   * /api/v1/subscription/google/notifications?secret=<GOOGLE_PLAY_RTDN_SECRET>.
   */
  @Public()
  @Post('google/notifications')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  googleNotification(@Query('secret') secret: string, @Body() body: unknown) {
    const expected = this.config.get<string>('GOOGLE_PLAY_RTDN_SECRET');
    const ok =
      !!expected &&
      !!secret &&
      expected.length === secret.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(secret));
    if (!ok) throw new ForbiddenException();
    return this.subscriptions.handleGoogleNotification(body);
  }
}
