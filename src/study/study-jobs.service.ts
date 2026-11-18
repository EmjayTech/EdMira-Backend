import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { lagosDay, previousWeek, weekOf } from '../leaderboard/week';
import { JobRun, JobRunDocument } from './schemas/job-run.schema';
import { StudyService } from './study.service';

const TICK_MS = 10 * 60_000;
const LAGOS_OFFSET_MS = 60 * 60_000;
/** The nightly run starts from 00:10 Lagos time. */
const NIGHTLY_AFTER_MINUTES = 10;
const DAY_MS = 24 * 60 * 60_000;

/** Minutes since midnight, Lagos time. */
export const lagosMinutes = (now: Date) => Math.floor(((now.getTime() + LAGOS_OFFSET_MS) % DAY_MS) / 60_000);

/**
 * A job that runs at most once per run key. `runKey` returns null when it
 * isn't due yet (e.g. before 09:00), else the key for this run (e.g. the week).
 */
export interface ScheduledJob {
  name: string;
  runKey(now: Date): string | null;
  run(now: Date): Promise<Record<string, unknown>>;
}

/**
 * Scheduled jobs without a cron dependency (same "run if due" approach as the
 * AI news timer): every 10 minutes each server checks what's due, and a
 * unique job_runs row makes sure only one server runs it. A server that was
 * asleep at midnight (Render) catches up when it wakes.
 *
 * Off in tests and one-off scripts (STUDY_JOBS=off).
 */
@Injectable()
export class StudyJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StudyJobsService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly jobs: ScheduledJob[] = [
    {
      name: 'nightly',
      runKey: now => (lagosMinutes(now) >= NIGHTLY_AFTER_MINUTES ? lagosDay(now) : null),
      run: now => this.nightly(now),
    },
  ];

  constructor(
    @InjectModel(JobRun.name) private readonly runs: Model<JobRunDocument>,
    private readonly study: StudyService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.STUDY_JOBS === 'off') return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    setTimeout(() => void this.tick(), 60_000).unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Other modules add their jobs here (e.g. the Monday leaderboard close). */
  register(job: ScheduledJob) {
    this.jobs.push(job);
  }

  async tick(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      for (const job of this.jobs) {
        const key = job.runKey(now);
        if (key) await this.once(job.name, key, () => job.run(now));
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Safety net: score any attempt that missed scoring, recount this week's
   * (and last week's) totals from the ledger, and store fresh streaks.
   */
  async nightly(now = new Date()) {
    const repaired = await this.study.scoreUnscored(new Date(now.getTime() - 7 * DAY_MS));
    const week = weekOf(now);
    const thisWeek = await this.study.reconcileWeek(week);
    const lastWeek = await this.study.reconcileWeek(previousWeek(week));
    const streaks = await this.study.refreshRecentStreaks(now);
    return { repaired, thisWeek, lastWeek, streaks };
  }

  /** Runs `work` once per (job, runKey) across all servers; a failed run is retried next tick. */
  async once(job: string, runKey: string, work: () => Promise<Record<string, unknown>>) {
    try {
      await this.runs.create({ job, runKey, startedAt: new Date() });
    } catch (error) {
      if (error?.code === 11000) return; // already ran (or running) elsewhere
      throw error;
    }
    try {
      const result = await work();
      await this.runs.updateOne({ job, runKey }, { $set: { finishedAt: new Date(), result } }).exec();
      this.logger.log(`${job} ${runKey}: ${JSON.stringify(result)}`);
    } catch (error) {
      this.logger.error(`${job} ${runKey} failed: ${error?.message ?? error}`);
      await this.runs.deleteOne({ job, runKey }).exec();
    }
  }
}
