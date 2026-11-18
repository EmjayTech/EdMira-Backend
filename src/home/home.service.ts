import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { InjectModel } from '@nestjs/mongoose';
import { Cache } from 'cache-manager';
import { Model, Types } from 'mongoose';
import { ContentStatus } from '../common/enum/content-status.enum';
import { ContentService } from '../content/content.service';
import { Course, CourseDocument } from '../content/schemas/course.schema';
import { Topic, TopicDocument } from '../content/schemas/topic.schema';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { User, UserDocument } from '../users/model/user.model';
import { QotdService } from '../study/qotd/qotd.service';
import { TopicStats, TopicStatsDocument } from '../study/schemas/topic-stats.schema';
import { homeCacheKey, StudyService } from '../study/study.service';
import { schoolShortName } from '../reference/school-short-names';

/** Cached per student; cleared when they submit a quiz, answer the QOTD or change their goal. */
export const HOME_CACHE_MS = 60_000;
/** Same rule as the app's Focus Areas (progressMath.ts WEAK_TOPIC_THRESHOLD). */
const FOCUS_THRESHOLD = 60;
const PUBLISHED = ContentStatus.PUBLISHED;

type Section = 'streak' | 'weeklyGoal' | 'continueLearning' | 'focusArea' | 'qotd' | 'leaderboardTeaser';

/**
 * GET /home/summary: everything the new Home needs in one request. Each
 * section is loaded on its own; one failing returns null for that section and
 * its name in `failed`, so the app can show that card's error state only.
 */
@Injectable()
export class HomeService {
  private readonly logger = new Logger(HomeService.name);

  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(TopicStats.name) private readonly topicStats: Model<TopicStatsDocument>,
    @InjectModel(Topic.name) private readonly topics: Model<TopicDocument>,
    @InjectModel(Course.name) private readonly courses: Model<CourseDocument>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly study: StudyService,
    private readonly qotd: QotdService,
    private readonly leaderboards: LeaderboardService,
    private readonly content: ContentService,
  ) {}

  async summary(userId: string) {
    const key = homeCacheKey(userId);
    const cached = await this.cache.get(key).catch(() => undefined);
    if (cached) return cached;
    const fresh = await this.build(userId);
    await this.cache.set(key, fresh, HOME_CACHE_MS).catch(() => undefined);
    return fresh;
  }

  private async build(userId: string) {
    const user = await this.users.findById(userId).select('firstName username studentProfile').lean().exec();
    const failed: Section[] = [];
    const safe = async <T>(section: Section, load: () => Promise<T>): Promise<T | null> => {
      try {
        return await load();
      } catch (error) {
        this.logger.warn(`Home ${section} failed for ${userId}: ${error?.message ?? error}`);
        failed.push(section);
        return null;
      }
    };

    const [streak, weeklyGoal, continueLearning, focusArea, qotd, leaderboardTeaser] = await Promise.all([
      safe('streak', async () => {
        const s = await this.study.streakFor(userId);
        return { current: s.current, longest: s.longest, freezeAvailable: s.freezeAvailable, savedByFreeze: s.savedByFreeze };
      }),
      safe('weeklyGoal', () => this.study.weekFor(userId)),
      safe('continueLearning', () => this.continueLearning(userId, user?.studentProfile)),
      safe('focusArea', () => this.focusArea(userId)),
      safe('qotd', () => this.qotd.today(userId)),
      safe('leaderboardTeaser', () => this.leaderboards.teaser(userId)),
    ]);

    return {
      // No "preferred name" field exists yet, so the first name.
      greetingName: user?.firstName?.trim() || null,
      username: user?.username ?? null,
      level: user?.studentProfile?.level ?? null,
      department: user?.studentProfile?.department ?? null,
      /** Short school name, e.g. "UNILAG" (for "Your school" chips). */
      school: user?.studentProfile?.institution ? schoolShortName(user.studentProfile.institution) || null : null,
      streak,
      weeklyGoal,
      continueLearning,
      focusArea,
      qotd,
      leaderboardTeaser,
      failed,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * The most recently practised topic that's still published (`isNew:
   * false`), or for a student with no history the first topic of their
   * first course (`isNew: true`).
   */
  private async continueLearning(userId: string, profile?: { level?: string; department?: string; institution?: string }) {
    const recent = await this.topicStats
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ lastAt: -1 })
      .limit(5)
      .lean()
      .exec();
    for (const r of recent) {
      const topic = await this.topics.findOne({ _id: r.topicId, status: PUBLISHED }).select('title courseId').lean().exec();
      const course = topic && (await this.courses.findOne({ _id: topic.courseId, status: PUBLISHED }).lean().exec());
      if (!topic || !course) continue;
      return {
        isNew: false,
        courseId: String(course._id),
        courseCode: course.code ?? course.shortName ?? '',
        ...(course.icon ? { courseIcon: course.icon } : {}),
        courseTitle: course.title,
        courseColor: course.color ?? null,
        topicId: String(topic._id),
        topicTitle: topic.title,
        progressPct: r.best,
        lastScore: r.last,
      };
    }

    const courses = await this.content.listCourses(
      profile && { level: profile.level, department: profile.department, institution: profile.institution },
    );
    const course = courses.find(c => c.forYou) ?? courses[0];
    const topic = course?.topics[0];
    if (!course || !topic) return null;
    return {
      isNew: true,
      courseId: course.id,
      courseCode: ('code' in course && course.code) || ('shortName' in course && course.shortName) || '',
      ...('icon' in course && course.icon ? { courseIcon: course.icon } : {}),
      courseTitle: course.title,
      courseColor: course.color ?? null,
      topicId: topic.id,
      topicTitle: topic.title,
      progressPct: 0,
      lastScore: null,
    };
  }

  /** Topics averaging under 60%, weakest first (null when there are none). */
  private async focusArea(userId: string) {
    const query = { userId: new Types.ObjectId(userId), average: { $lt: FOCUS_THRESHOLD } };
    const [count, weakest] = await Promise.all([
      this.topicStats.countDocuments(query).exec(),
      this.topicStats.findOne(query).sort({ average: 1, lastAt: -1 }).lean().exec(),
    ]);
    if (!count || !weakest) return null;
    const course = await this.courses.findById(weakest.courseId).select('code shortName').lean().exec();
    return {
      count,
      threshold: FOCUS_THRESHOLD,
      topTopic: {
        id: String(weakest.topicId),
        title: weakest.topicTitle,
        courseTitle: weakest.courseTitle,
        courseCode: course?.code ?? course?.shortName ?? '',
        avgPct: weakest.average,
      },
    };
  }
}
