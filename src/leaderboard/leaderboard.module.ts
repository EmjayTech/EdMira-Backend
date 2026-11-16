import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { QuizAttempt, QuizAttemptSchema } from '../quiz/quiz-attempt.schema';
import { LeaderboardWeek, LeaderboardWeekSchema } from './leaderboard-week.schema';
import { Block, BlockSchema } from '../social/schemas/block.schema';
import { LeaderboardController } from './leaderboard.controller';
import { LeaderboardService } from './leaderboard.service';

/**
 * Weekly leaderboards. Reads quiz attempts directly (rather than importing
 * QuizModule) because QuizModule calls this one after every submission.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LeaderboardWeek.name, schema: LeaderboardWeekSchema },
      { name: QuizAttempt.name, schema: QuizAttemptSchema },
      // Read-only here: blocked students show as "Anonymous student" (owned by SocialModule).
      { name: Block.name, schema: BlockSchema },
    ]),
  ],
  controllers: [LeaderboardController],
  providers: [LeaderboardService],
  exports: [LeaderboardService],
})
export class LeaderboardModule {}
