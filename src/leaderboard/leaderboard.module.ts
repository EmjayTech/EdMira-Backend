import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { QuizAttempt, QuizAttemptSchema } from '../quiz/quiz-attempt.schema';
import { Block, BlockSchema } from '../social/schemas/block.schema';
import { Connection, ConnectionSchema } from '../social/schemas/connection.schema';
import { Notification, NotificationSchema } from '../social/schemas/notification.schema';
import { StudyModule } from '../study/study.module';
import { LeaderboardAdminService } from './leaderboard-admin.service';
import { LeaderboardJobsService } from './leaderboard-jobs.service';
import { LeaderboardWeek, LeaderboardWeekSchema } from './leaderboard-week.schema';
import { LeaderboardWinner, LeaderboardWinnerSchema } from './leaderboard-winner.schema';
import { LeaderboardController } from './leaderboard.controller';
import { LeaderboardService } from './leaderboard.service';

/**
 * Weekly leaderboards. Totals are written by StudyModule (points ledger) as
 * points are earned; this module ranks and presents them, closes each week,
 * sends leaderboard inbox messages and raises anomaly flags.
 *
 * Connections, blocks and notifications are owned by SocialModule (which
 * imports this one), so their collections are registered here directly
 * rather than importing SocialModule.
 */
@Module({
  imports: [
    StudyModule,
    MongooseModule.forFeature([
      { name: LeaderboardWeek.name, schema: LeaderboardWeekSchema },
      { name: LeaderboardWinner.name, schema: LeaderboardWinnerSchema },
      { name: QuizAttempt.name, schema: QuizAttemptSchema },
      { name: Block.name, schema: BlockSchema },
      { name: Connection.name, schema: ConnectionSchema },
      { name: Notification.name, schema: NotificationSchema },
    ]),
  ],
  controllers: [LeaderboardController],
  providers: [LeaderboardService, LeaderboardJobsService, LeaderboardAdminService],
  exports: [LeaderboardService, LeaderboardJobsService, LeaderboardAdminService],
})
export class LeaderboardModule {}
