import { Body, Controller, Get, Headers, HttpCode, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { timingSafeEqual } from 'crypto';
import { GetCurrentUser } from '../common/decorators/get-current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { BillingService } from './billing.service';

class PlayPurchaseDto {
  @ApiProperty({ example: 'edmira_pro' }) @IsString() @MaxLength(100) productId: string;
  @ApiProperty() @IsString() @MaxLength(1000) purchaseToken: string;
}

class RestoreDto {
  @ApiProperty({ type: [PlayPurchaseDto] })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PlayPurchaseDto)
  purchases: PlayPurchaseDto[];
}

class PaystackInitDto {
  @ApiProperty({ example: 'month' }) @IsString() @Matches(/^[a-z0-9_-]{2,20}$/) planId: string;
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

@ApiTags('Plans')
@Controller()
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Post('me/plan/play/verify')
  @ApiBearerAuth()
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Verify a Google Play purchase with Google and grant Pro. Returns { status: active|cancelled|pending|revoked, consumable, plan }' })
  verifyPlay(@GetCurrentUser('userId') userId: string, @Body() dto: PlayPurchaseDto) {
    return this.billing.verifyPlay(userId, dto.productId, dto.purchaseToken);
  }

  @Post('me/plan/play/restore')
  @ApiBearerAuth()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Restore purchases: verify everything Google Play still holds for this phone' })
  restorePlay(@GetCurrentUser('userId') userId: string, @Body() dto: RestoreDto) {
    return this.billing.restorePlay(userId, dto.purchases);
  }

  @Post('me/plan/paystack/initialize')
  @ApiBearerAuth()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Web: start a Paystack payment for a plan; returns the checkout URL' })
  paystackInit(@GetCurrentUser('userId') userId: string, @Body() dto: PaystackInitDto) {
    return this.billing.paystackInitialize(userId, dto.planId);
  }

  @Get('me/plan/paystack/verify/:reference')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Web: after checkout, confirm the payment with Paystack (the webhook usually did already)' })
  paystackVerify(@GetCurrentUser('userId') userId: string, @Param('reference') reference: string) {
    return this.billing.paystackVerify(userId, reference);
  }

  /** Google Play real-time developer notifications (Pub/Sub push to ?token=PLAY_RTDN_TOKEN). */
  @Public()
  @Post('billing/play/notifications')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  playNotification(@Query('token') token: string, @Body() body: { message?: { data?: string } }) {
    const expected = process.env.PLAY_RTDN_TOKEN;
    if (!expected || !token || !sameSecret(token, expected)) throw new NotFoundException();
    return this.billing.handlePlayNotification(body);
  }

  /** Paystack webhook (signed with the secret key). */
  @Public()
  @Post('billing/paystack/webhook')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  paystackWebhook(@Req() req: RawBodyRequest<Request>, @Headers('x-paystack-signature') signature: string, @Body() body: never) {
    return this.billing.paystackWebhook(req.rawBody, signature, body);
  }
}
