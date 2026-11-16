import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { ContentModule } from '../content/content.module';
import { QuizModule } from '../quiz/quiz.module';
import { ChallengesController } from './challenges.controller';
import { ChallengesService } from './challenges.service';
import { ReferralsService } from './referrals.service';
import { Challenge, ChallengeSchema } from './schemas/challenge.schema';
import { StudyGroup, StudyGroupSchema } from './schemas/study-group.schema';
import { LeaderboardWeek, LeaderboardWeekSchema } from '../leaderboard/leaderboard-week.schema';
import { BadgesService } from './badges.service';
import { GroupsService } from './groups.service';
import { GroupsController } from './groups.controller';
import { QuizAttempt, QuizAttemptSchema } from '../quiz/quiz-attempt.schema';
import { ConnectionsService } from './connections.service';
import { ModerationService } from './moderation.service';
import { NotificationsService } from './notifications.service';
import { PeopleService } from './people.service';
import { SafetyService } from './safety.service';
import { Block, BlockSchema } from './schemas/block.schema';
import { Connection, ConnectionSchema } from './schemas/connection.schema';
import { Notification, NotificationSchema } from './schemas/notification.schema';
import { SecurityEvent, SecurityEventSchema } from './schemas/security-event.schema';
import { UserReport, UserReportSchema } from './schemas/user-report.schema';
import { SocialController } from './social.controller';

/**
 * Find classmates, connections, block & report, inbox, moderation.
 * Later phases (challenges, groups) use PeopleService.areConnected() and
 * PeopleService.canSee() so the same consent and block rules apply.
 */
@Module({
  imports: [
    LeaderboardModule,
    ContentModule,
    QuizModule,
    MongooseModule.forFeature([
      { name: Connection.name, schema: ConnectionSchema },
      { name: Block.name, schema: BlockSchema },
      { name: UserReport.name, schema: UserReportSchema },
      { name: SecurityEvent.name, schema: SecurityEventSchema },
      { name: Notification.name, schema: NotificationSchema },
      { name: QuizAttempt.name, schema: QuizAttemptSchema },
      { name: Challenge.name, schema: ChallengeSchema },
      { name: StudyGroup.name, schema: StudyGroupSchema },
      { name: LeaderboardWeek.name, schema: LeaderboardWeekSchema },
    ]),
  ],
  controllers: [SocialController, ChallengesController, GroupsController],
  providers: [PeopleService, ConnectionsService, SafetyService, NotificationsService, ModerationService, ReferralsService, ChallengesService, BadgesService, GroupsService],
  exports: [PeopleService, ModerationService, SafetyService, ReferralsService, GroupsService, BadgesService],
})
export class SocialModule {}
