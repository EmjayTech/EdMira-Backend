import { Global, Module, OnModuleInit } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AnalyticsModule } from '../analytics/analytics.module';
import { lagosDay } from '../leaderboard/week';
import { MailerModule } from '../mailer/mailer.module';
import { AppSetting, AppSettingSchema } from '../settings/app-setting.schema';
import { StudyJobsService } from '../study/study-jobs.service';
import { StudyModule } from '../study/study.module';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { McqUsage, McqUsageSchema } from './schemas/mcq-usage.schema';
import { ProEntitlement, ProEntitlementSchema } from './schemas/pro-entitlement.schema';
import { TrialClaim, TrialClaimSchema } from './schemas/trial-claim.schema';

/** Free vs Pro. Global: content, quiz and social check locks and the daily limit through PlansService. */
@Global()
@Module({
  imports: [
    AnalyticsModule,
    MailerModule,
    MongooseModule.forFeature([
      { name: AppSetting.name, schema: AppSettingSchema },
      { name: McqUsage.name, schema: McqUsageSchema },
      { name: TrialClaim.name, schema: TrialClaimSchema },
      { name: ProEntitlement.name, schema: ProEntitlementSchema },
    ]),
  ],
  controllers: [PlansController],
  providers: [PlansService],
  exports: [PlansService, MongooseModule],
})
export class PlansModule {}

/** The hourly plan emails, on the shared job runner (kept apart to avoid an import cycle). */
@Module({ imports: [StudyModule] })
export class PlansJobsModule implements OnModuleInit {
  constructor(
    private readonly jobs: StudyJobsService,
    private readonly plans: PlansService,
  ) {}

  onModuleInit() {
    this.jobs.register({
      name: 'plan-emails',
      runKey: now => `${lagosDay(now)}T${String(now.getUTCHours()).padStart(2, '0')}`,
      run: now => this.plans.hourly(now),
    });
  }
}
