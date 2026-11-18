import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AnalyticsModule } from '../analytics/analytics.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { FakePaystackApi, LivePaystackApi, PAYSTACK_API } from './paystack-api';
import { FakePlayApi, GooglePlayApi, PLAY_API } from './play-api';
import { PaymentIntent, PaymentIntentSchema } from './schemas/payment-intent.schema';

const fake = (flag: string | undefined) => process.env.NODE_ENV === 'test' || flag === '1';

/** Google Play Billing (Android) and Paystack (web) → Pro. */
@Module({
  imports: [AnalyticsModule, MongooseModule.forFeature([{ name: PaymentIntent.name, schema: PaymentIntentSchema }])],
  controllers: [BillingController],
  providers: [
    BillingService,
    { provide: PLAY_API, useFactory: () => (fake(process.env.PLAY_FAKE) ? new FakePlayApi() : new GooglePlayApi()) },
    { provide: PAYSTACK_API, useFactory: () => (fake(process.env.PAYSTACK_FAKE) ? new FakePaystackApi() : new LivePaystackApi()) },
  ],
  exports: [BillingService],
})
export class BillingModule {}
