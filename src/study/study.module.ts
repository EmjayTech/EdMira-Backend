import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ContentModule } from '../content/content.module';
import { LeaderboardWeek, LeaderboardWeekSchema } from '../leaderboard/leaderboard-week.schema';
import { QuizAttempt, QuizAttemptSchema } from '../quiz/quiz-attempt.schema';
import { QotdAnswer, QotdAnswerSchema, QotdDay, QotdDaySchema } from './qotd/qotd.schemas';
import { QotdService } from './qotd/qotd.service';
import { IntegrityFlag, IntegrityFlagSchema } from './schemas/integrity-flag.schema';
import { JobRun, JobRunSchema } from './schemas/job-run.schema';
import { PointsEntry, PointsEntrySchema } from './schemas/points-ledger.schema';
import { QuestionStats, QuestionStatsSchema } from './schemas/question-stats.schema';
import { StudyDay, StudyDaySchema } from './schemas/study-day.schema';
import { TopicStats, TopicStatsSchema } from './schemas/topic-stats.schema';
import { UserStats, UserStatsSchema } from './schemas/user-stats.schema';
import { StudyJobsService } from './study-jobs.service';
import { StudyController } from './study.controller';
import { StudyService } from './study.service';

/**
 * Study activity (Part A): study days, streaks + freezes, weekly goal, the
 * points ledger, Question of the Day and the nightly safety net.
 *
 * Reads quiz attempts and leaderboard weeks directly (rather than importing
 * QuizModule / LeaderboardModule) because both of those call into this one.
 */
@Module({
  imports: [
    ContentModule,
    MongooseModule.forFeature([
      { name: StudyDay.name, schema: StudyDaySchema },
      { name: UserStats.name, schema: UserStatsSchema },
      { name: TopicStats.name, schema: TopicStatsSchema },
      { name: QuestionStats.name, schema: QuestionStatsSchema },
      { name: PointsEntry.name, schema: PointsEntrySchema },
      { name: IntegrityFlag.name, schema: IntegrityFlagSchema },
      { name: JobRun.name, schema: JobRunSchema },
      { name: QotdDay.name, schema: QotdDaySchema },
      { name: QotdAnswer.name, schema: QotdAnswerSchema },
      { name: LeaderboardWeek.name, schema: LeaderboardWeekSchema },
      { name: QuizAttempt.name, schema: QuizAttemptSchema },
    ]),
  ],
  controllers: [StudyController],
  providers: [StudyService, QotdService, StudyJobsService],
  exports: [StudyService, QotdService, StudyJobsService, MongooseModule],
})
export class StudyModule {}
