import { Module } from '@nestjs/common';
import { AdminPlansController } from './admin-plans.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { ContentModule } from '../content/content.module';
import { FeedbackModule } from '../feedback/feedback.module';
import { MailerModule } from '../mailer/mailer.module';
import { NewsModule } from '../news/news.module';
import { QuizModule } from '../quiz/quiz.module';
import { AdminContentService } from './admin-content.service';
import { AdminNewsService } from './admin-news.service';
import { AdminPeopleService } from './admin-people.service';
import { AdminTeamService } from './admin-team.service';
import { AiDraftService } from './ai-draft.service';
import { AiNewsService } from './ai-news.service';
import { AdminController } from './admin.controller';
import { AuditEntry, AuditEntrySchema } from './audit/audit.schema';
import { AuditService } from './audit/audit.service';
import { StaffInviteController } from './staff-invite.controller';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { SocialModule } from '../social/social.module';
import { Challenge, ChallengeSchema } from '../social/schemas/challenge.schema';
import { StaffGuard } from './staff.guard';
import { StudyModule } from '../study/study.module';

@Module({
  imports: [
    ContentModule,
    QuizModule,
    FeedbackModule,
    NewsModule,
    MailerModule,
    LeaderboardModule,
    SocialModule,
    StudyModule,
    MongooseModule.forFeature([
      { name: AuditEntry.name, schema: AuditEntrySchema },
      { name: Challenge.name, schema: ChallengeSchema },
    ]),
  ],
  controllers: [AdminController, StaffInviteController, AdminPlansController],
  providers: [AdminContentService, AiDraftService, AiNewsService, AdminNewsService, AdminPeopleService, AdminTeamService, AuditService, StaffGuard],
})
export class AdminModule {}
