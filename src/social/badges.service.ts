import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { LeaderboardWeek, LeaderboardWeekDocument } from '../leaderboard/leaderboard-week.schema';
import { MASTERY_SCORE } from '../leaderboard/leaderboard.service';
import { weekOf } from '../leaderboard/week';
import { StudyService } from '../study/study.service';
import { QuizAttempt, QuizAttemptDocument } from '../quiz/quiz-attempt.schema';
import { User, UserDocument } from '../users/model/user.model';
import { Badge, badgesFor } from './badges';
import { Challenge, ChallengeDocument } from './schemas/challenge.schema';

/** Works out a student's badges from their activity (rules: ./badges.ts). */
@Injectable()
export class BadgesService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(QuizAttempt.name) private readonly attempts: Model<QuizAttemptDocument>,
    @InjectModel(LeaderboardWeek.name) private readonly weeks: Model<LeaderboardWeekDocument>,
    @InjectModel(Challenge.name) private readonly challenges: Model<ChallengeDocument>,
    private readonly study: StudyService,
  ) {}

  async badgesOf(userId: Types.ObjectId | string): Promise<Badge[]> {
    const id = new Types.ObjectId(String(userId));
    const user = await this.users.findById(id).select('createdAt badgeOverrides role').lean().exec();
    if (!user || user.role) return [];
    const [longestStreak, mastered, weekly, wins] = await Promise.all([
      // Study days with streak freezes (study/streak.ts).
      this.study.longestStreak(id),
      this.attempts.aggregate<{ n: number }>([
        // "Retry weak questions" runs only hold the missed questions: not a mastery score.
        { $match: { studentId: id, retry: { $ne: true } } },
        { $group: { _id: '$topicId', best: { $max: '$score' } } },
        { $match: { best: { $gte: MASTERY_SCORE } } },
        { $count: 'n' },
      ]),
      this.everTop3(id),
      this.challenges.countDocuments({
        status: 'completed',
        $or: [
          { challengerId: id, winner: 'challenger' },
          { opponentId: id, winner: 'opponent' },
        ],
      }),
    ]);
    return badgesFor({
      createdAt: user.createdAt,
      longestStreak,
      topicsMastered: mastered[0]?.n ?? 0,
      weeklyTop3: weekly,
      challengeWins: wins,
      granted: user.badgeOverrides?.granted,
      revoked: user.badgeOverrides?.revoked,
    });
  }

  /** Finished a past week in the top 3 of All of EdMira. */
  private async everTop3(id: Types.ObjectId) {
    const current = weekOf(new Date());
    const mine = await this.weeks.find({ studentId: id, week: { $ne: current }, points: { $gt: 0 } }).select('week points reachedAt').lean().exec();
    for (const w of mine) {
      const ahead = await this.weeks.countDocuments({
        week: w.week,
        $or: [{ points: { $gt: w.points } }, { points: w.points, reachedAt: { $lt: w.reachedAt } }],
      });
      if (ahead < 3) return true;
    }
    return false;
  }
}
