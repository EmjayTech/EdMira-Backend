import { BadRequestException, Global, Injectable, Module } from '@nestjs/common';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DEFAULT_POINTS, PointsConfig } from '../study/points-config';
import { AppSetting, AppSettingDocument, AppSettingSchema } from './app-setting.schema';

export interface LeaderboardSettings {
  /** Schools board: a school needs this many active students that week. */
  minActiveStudents: number;
}

export const DEFAULT_LEADERBOARD: Readonly<LeaderboardSettings> = Object.freeze({ minActiveStudents: 5 });

/** Allowed range for each value, so a typo in the dashboard can't break scoring. */
const POINT_LIMITS: Record<keyof PointsConfig, [number, number]> = {
  correctAnswer: [0, 100],
  repeatCorrectAnswer: [0, 100],
  repeatAfterCorrect: [1, 20],
  attemptsPerQuestionPerDay: [1, 20],
  completedQuiz: [0, 200],
  minAnsweredForCompletedQuiz: [1, 50],
  studyDay: [0, 500],
  qotdCorrect: [0, 200],
  qotdWrong: [0, 200],
  focusImproved: [0, 500],
  focusThreshold: [1, 100],
  dailyCap: [10, 10_000],
  minSecondsPerQuestion: [0, 30],
  referral: [0, 500],
  referralLeaderboardPerWeek: [0, 100],
};
const LEADERBOARD_LIMITS: Record<keyof LeaderboardSettings, [number, number]> = { minActiveStudents: [1, 100] };

const CACHE_MS = 60_000;

/**
 * Points values, the daily cap and leaderboard rules, editable by admins
 * (Leaderboards → Settings) without a code change. Missing values use the
 * defaults in code. Read often, so cached for a minute per server.
 */
@Injectable()
export class SettingsService {
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(@InjectModel(AppSetting.name) private readonly settings: Model<AppSettingDocument>) {}

  async points(): Promise<PointsConfig> {
    return this.read('points', DEFAULT_POINTS);
  }

  async leaderboard(): Promise<LeaderboardSettings> {
    return this.read('leaderboard', DEFAULT_LEADERBOARD);
  }

  /** Everything, with defaults, for the dashboard. */
  async all() {
    return {
      points: await this.points(),
      leaderboard: await this.leaderboard(),
      defaults: { points: DEFAULT_POINTS, leaderboard: DEFAULT_LEADERBOARD },
    };
  }

  async update(
    changes: { points?: Partial<PointsConfig>; leaderboard?: Partial<LeaderboardSettings> },
    staffName: string,
  ) {
    if (changes.points) await this.write('points', changes.points, POINT_LIMITS, staffName);
    if (changes.leaderboard) await this.write('leaderboard', changes.leaderboard, LEADERBOARD_LIMITS, staffName);
    return this.all();
  }

  private async read<T extends object>(key: string, defaults: T): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
    const row = await this.settings.findOne({ key }).lean().exec();
    const value = { ...defaults, ...(row?.value ?? {}) } as T;
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  private async write(key: string, changes: Record<string, unknown>, limits: Record<string, [number, number]>, staffName: string) {
    const set: Record<string, number> = {};
    for (const [name, value] of Object.entries(changes)) {
      const range = limits[name];
      if (!range) throw new BadRequestException(`Unknown setting "${name}".`);
      if (typeof value !== 'number' || !Number.isFinite(value) || value < range[0] || value > range[1]) {
        throw new BadRequestException(`"${name}" must be a number from ${range[0]} to ${range[1]}.`);
      }
      set[`value.${name}`] = value;
    }
    await this.settings.updateOne({ key }, { $set: { ...set, updatedBy: staffName } }, { upsert: true }).exec();
    this.cache.delete(key);
  }
}

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: AppSetting.name, schema: AppSettingSchema }])],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
