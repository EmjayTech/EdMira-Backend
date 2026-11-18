import { HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'crypto';
import { Model, Types } from 'mongoose';
import { AnalyticsService } from '../analytics/analytics.service';
import { addDays, lagosDay } from '../leaderboard/week';
import { EmailService } from '../mailer/mailer.service';
import { AppSetting, AppSettingDocument } from '../settings/app-setting.schema';
import { User, UserDocument } from '../users/model/user.model';
import { DEFAULT_PLANS, PLAN_LIMITS, PRO_FEATURES, PlanOffer, PlansConfig, ProFeature, withSavings } from './plan-config';
import { planEmail } from './plan-emails';
import { billingAccountId } from './billing-account';
import { McqUsage, McqUsageDocument } from './schemas/mcq-usage.schema';
import { EntitlementSource, ProEntitlement, ProEntitlementDocument } from './schemas/pro-entitlement.schema';
import { TrialClaim, TrialClaimDocument } from './schemas/trial-claim.schema';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const CONFIG_TTL_MS = 30_000;

export type PlanName = 'free' | 'trial' | 'pro';
/** Modals the app shows once (tracked here so phone and web agree). */
export const PLAN_NOTICES = ['trial_welcome', 'trial_24h', 'trial_ended', 'founding_welcome', 'founding_ended'] as const;
export type PlanNotice = (typeof PLAN_NOTICES)[number];

type PlanUser = Pick<
  User,
  | 'email'
  | 'firstName'
  | 'role'
  | 'phone'
  | 'signupInstall'
  | 'trialStartedAt'
  | 'trialEndsAt'
  | 'trialDenied'
  | 'proExpiresAt'
  | 'proSource'
  | 'planNotices'
  | 'createdAt'
> & { _id: Types.ObjectId };
const PLAN_FIELDS =
  'email firstName role phone signupInstall trialStartedAt trialEndsAt trialDenied proExpiresAt proSource planNotices createdAt';

export interface PlanState {
  /** False until go-live: everything open, no limits shown. */
  enabled: boolean;
  plan: PlanName;
  /** trial | founding_tester | grant | play | paystack | staff | open */
  source: string | null;
  trialEndsAt: string | null;
  proExpiresAt: string | null;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Same person, different spelling: case, spaces and "+tags" don't make a new email. */
const normalEmail = (email: string) => {
  const [local = '', domain = ''] = email.trim().toLowerCase().split('@');
  return `${local.split('+')[0]}@${domain}`;
};

/**
 * Free vs Pro: who has what, the 3-day trial, Founding Testers, the daily
 * MCQ limit and the feature locks. The server decides; apps only display.
 */
@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);
  private cached?: { at: number; value: PlansConfig };

  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(AppSetting.name) private readonly settings: Model<AppSettingDocument>,
    @InjectModel(McqUsage.name) private readonly usage: Model<McqUsageDocument>,
    @InjectModel(TrialClaim.name) private readonly claims: Model<TrialClaimDocument>,
    @InjectModel(ProEntitlement.name) private readonly entitlements: Model<ProEntitlementDocument>,
    private readonly analytics: AnalyticsService,
    private readonly email: EmailService,
  ) {}

  // ── Settings ───────────────────────────────────────────────────────────────

  async config(): Promise<PlansConfig> {
    if (this.cached && Date.now() - this.cached.at < CONFIG_TTL_MS) return this.cached.value;
    const row = await this.settings.findOne({ key: 'plans' }).lean().exec();
    const saved = (row?.value ?? {}) as Partial<PlansConfig>;
    const value: PlansConfig = {
      ...DEFAULT_PLANS,
      ...saved,
      locks: { ...DEFAULT_PLANS.locks, ...(saved.locks ?? {}) },
      catalog: saved.catalog?.length ? saved.catalog : DEFAULT_PLANS.catalog,
    };
    this.cached = { at: Date.now(), value };
    return value;
  }

  /** Admin → Plans. Validates every value; switching on for the first time sets go-live. */
  async updateConfig(changes: Partial<PlansConfig>, staffName: string) {
    const current = await this.config();
    const next: PlansConfig = { ...current };
    for (const [key, [min, max]] of Object.entries(PLAN_LIMITS) as [keyof typeof PLAN_LIMITS, readonly [number, number]][]) {
      const v = changes[key];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(`${key} must be a whole number from ${min} to ${max}.`);
      next[key] = v;
    }
    if (changes.locks) {
      for (const [feature, level] of Object.entries(changes.locks)) {
        if (!(PRO_FEATURES as readonly string[]).includes(feature) || !['free', 'pro'].includes(level)) throw bad(`Unknown lock ${feature}=${level}.`);
        next.locks = { ...next.locks, [feature]: level };
      }
    }
    if (changes.catalog) next.catalog = validCatalog(changes.catalog);
    if (changes.enabled !== undefined) {
      next.enabled = !!changes.enabled;
      if (next.enabled && !next.goLiveAt) next.goLiveAt = new Date().toISOString();
    }
    if (next.freeDailyMcqs > next.proDailyMcqs) throw bad('The Free daily limit can’t be higher than Pro’s.');
    await this.settings.updateOne({ key: 'plans' }, { $set: { value: next, updatedBy: staffName } }, { upsert: true }).exec();
    this.cached = undefined;
    return next;
  }

  // ── Who has what ───────────────────────────────────────────────────────────

  private async load(userId: string): Promise<PlanUser> {
    const u = await this.users.findById(userId).select(PLAN_FIELDS).lean<PlanUser>().exec();
    if (!u) throw new NotFoundException();
    return u;
  }

  private stateOf(u: PlanUser, cfg: PlansConfig, now: Date): PlanState {
    const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);
    const base = { trialEndsAt: iso(u.trialEndsAt), proExpiresAt: iso(u.proExpiresAt) };
    if (!cfg.enabled) return { enabled: false, plan: 'pro', source: 'open', ...base };
    if (u.role) return { enabled: true, plan: 'pro', source: 'staff', ...base };
    if (u.proExpiresAt && u.proExpiresAt > now) return { enabled: true, plan: 'pro', source: u.proSource ?? 'grant', ...base };
    if (u.trialEndsAt && u.trialEndsAt > now) return { enabled: true, plan: 'trial', source: 'trial', ...base };
    return { enabled: true, plan: 'free', source: null, ...base };
  }

  /**
   * The student's plan, first starting their trial (new accounts) or their
   * Founding Tester month (accounts from before go-live) if that hasn't happened.
   */
  async state(userId: string, now = new Date()): Promise<{ user: PlanUser; cfg: PlansConfig; state: PlanState }> {
    const cfg = await this.config();
    let user = await this.load(userId);
    if (cfg.enabled && !user.role && !user.trialStartedAt && !user.trialDenied) {
      await this.begin(user, cfg, now);
      user = await this.load(userId);
    }
    return { user, cfg, state: this.stateOf(user, cfg, now) };
  }

  private async begin(u: PlanUser, cfg: PlansConfig, now: Date) {
    const created = u.createdAt ?? u._id.getTimestamp();
    const goLive = cfg.goLiveAt ? new Date(cfg.goLiveAt) : null;
    if (goLive && created < goLive) {
      // Founding Tester: a month of Pro from go-live (no separate trial).
      const claimed = await this.users
        .updateOne({ _id: u._id, trialStartedAt: { $exists: false }, trialDenied: { $exists: false } }, { $set: { trialDenied: 'founding_tester' } })
        .exec();
      if (claimed.modifiedCount) {
        await this.grant(String(u._id), 'founding_tester', new Date(goLive.getTime() + cfg.foundingDays * DAY_MS), { startsAt: goLive, note: 'Founding Tester month' });
        await this.claimKeys(u); // they've had their free Pro; a new account won't get a trial
      }
      return;
    }
    const taken = await this.claims.findOne({ key: { $in: this.keysOf(u) }, userId: { $ne: u._id } }).lean().exec();
    if (taken) {
      await this.users.updateOne({ _id: u._id, trialStartedAt: { $exists: false } }, { $set: { trialDenied: 'already_used' } }).exec();
      return;
    }
    const ends = new Date(now.getTime() + cfg.trialHours * HOUR_MS);
    const started = await this.users
      .updateOne({ _id: u._id, trialStartedAt: { $exists: false }, trialDenied: { $exists: false } }, { $set: { trialStartedAt: now, trialEndsAt: ends } })
      .exec();
    if (!started.modifiedCount) return;
    await this.claimKeys(u);
    this.analytics.track('trial_started', u._id);
    void this.sendOnce(String(u._id), 'trial_welcome', { trialEndsAt: ends });
  }

  private keysOf(u: PlanUser): string[] {
    const keys = [`email:${sha(normalEmail(u.email ?? ''))}`];
    const phone = `${u.phone?.countryCode ?? ''}${u.phone?.number ?? ''}`.replace(/\D/g, '');
    if (phone.length >= 7) keys.push(`phone:${sha(phone.replace(/^2340?/, '0'))}`);
    if (u.signupInstall) keys.push(`install:${u.signupInstall}`);
    return keys;
  }

  private async claimKeys(u: PlanUser) {
    for (const key of this.keysOf(u)) {
      await this.claims.updateOne({ key }, { $setOnInsert: { key, userId: u._id } }, { upsert: true }).exec().catch(() => undefined);
    }
  }

  /** Is this feature open to the student right now? */
  async canUse(userId: string, feature: ProFeature): Promise<boolean> {
    const { cfg, state } = await this.state(userId);
    return cfg.locks[feature] === 'free' || state.plan !== 'free';
  }

  /** Throws 403 PRO_REQUIRED (the app opens the upgrade screen) if locked. */
  async assertFeature(userId: string, feature: ProFeature) {
    if (!(await this.canUse(userId, feature))) {
      throw new HttpException({ statusCode: 403, code: 'PRO_REQUIRED', feature, message: 'This is part of EdMira Pro.' }, HttpStatus.FORBIDDEN);
    }
  }

  // ── Daily MCQ limit ────────────────────────────────────────────────────────

  async allowance(userId: string, now = new Date()) {
    const { cfg, state } = await this.state(userId, now);
    const day = lagosDay(now);
    const used = (await this.usage.findOne({ userId: new Types.ObjectId(userId), day }).lean().exec())?.answered ?? 0;
    const limit = !cfg.enabled ? null : state.plan === 'free' ? cfg.freeDailyMcqs : cfg.proDailyMcqs;
    return {
      limit,
      used,
      remaining: limit === null ? null : Math.max(0, limit - used),
      resetsAt: new Date(Date.parse(`${addDays(day, 1)}T00:00:00+01:00`)).toISOString(),
      plan: state.plan,
    };
  }

  /** 403 MCQ_LIMIT when nothing is left today (the app shows the upgrade screen). */
  limitReached(a: Awaited<ReturnType<PlansService['allowance']>>): never {
    throw new HttpException(
      {
        statusCode: 403,
        code: 'MCQ_LIMIT',
        limit: a.limit,
        used: a.used,
        plan: a.plan,
        resetsAt: a.resetsAt,
        message: a.plan === 'free' ? `You've used your ${a.limit} free questions today.` : `You've reached today's limit of ${a.limit} questions.`,
      },
      HttpStatus.FORBIDDEN,
    );
  }

  /**
   * Counts `answered` questions against today's limit, atomically. Returns how
   * many were allowed (the rest must not be graded).
   */
  async consume(userId: string, answered: number, now = new Date()): Promise<number> {
    if (answered <= 0) return 0;
    const { limit } = await this.allowance(userId, now);
    const userObjectId = new Types.ObjectId(userId);
    const day = lagosDay(now);
    for (let attempt = 0; attempt < 5; attempt++) {
      const used = (await this.usage.findOne({ userId: userObjectId, day }).lean().exec())?.answered ?? 0;
      const allowed = limit === null ? answered : Math.max(0, Math.min(answered, limit - used));
      if (!allowed) return 0;
      try {
        const res = await this.usage.updateOne({ userId: userObjectId, day, answered: used }, { $inc: { answered: allowed } }, { upsert: used === 0 }).exec();
        if (res.modifiedCount || res.upsertedCount) return allowed;
      } catch (error) {
        if ((error as { code?: number })?.code !== 11000) throw error; // two first answers raced; try again
      }
    }
    return 0;
  }

  // ── Pro from purchases, grants and the Founding Tester month ───────────────

  async grant(
    userId: string,
    source: EntitlementSource,
    expiresAt: Date,
    extra: {
      startsAt?: Date;
      planId?: string;
      ref?: string;
      note?: string;
      byName?: string;
      amountKobo?: number;
      autoRenewing?: boolean;
      status?: 'active' | 'cancelled' | 'revoked';
    } = {},
  ) {
    const { startsAt = new Date(), status = 'active', ...rest } = extra;
    const doc = rest.ref
      ? await this.entitlements
          .findOneAndUpdate(
            { source, ref: rest.ref },
            { $set: { userId: new Types.ObjectId(userId), source, startsAt, expiresAt, status, ...rest } },
            { upsert: true, new: true },
          )
          .exec()
      : await this.entitlements.create({ userId: new Types.ObjectId(userId), source, startsAt, expiresAt, status, ...rest });
    await this.recompute(userId);
    return doc;
  }

  async revoke(entitlementId: string, byName: string, note?: string) {
    const e = await this.entitlements.findByIdAndUpdate(entitlementId, { $set: { status: 'revoked', byName, ...(note ? { note } : {}) } }, { new: true }).exec();
    if (!e) throw new NotFoundException('That grant no longer exists.');
    await this.recompute(String(e.userId));
    return e;
  }

  /** proExpiresAt / proSource = the latest-ending active entitlement. */
  async recompute(userId: string) {
    const best = await this.entitlements
      .findOne({ userId: new Types.ObjectId(userId), status: { $in: ['active', 'cancelled'] } })
      .sort({ expiresAt: -1 })
      .lean()
      .exec();
    await this.users
      .updateOne({ _id: userId }, best ? { $set: { proExpiresAt: best.expiresAt, proSource: best.source } } : { $unset: { proExpiresAt: 1, proSource: 1 } })
      .exec();
  }

  entitlementByRef(source: EntitlementSource, ref: string) {
    return this.entitlements.findOne({ source, ref }).lean().exec();
  }

  async revokeByRef(source: EntitlementSource, ref: string, note: string) {
    const e = await this.entitlements.findOneAndUpdate({ source, ref }, { $set: { status: 'revoked', note } }, { new: true }).exec();
    if (e) await this.recompute(String(e.userId));
    return e;
  }

  entitlement(id: string) {
    return this.entitlements.findById(id).lean().exec();
  }

  entitlementsOf(userId: string) {
    return this.entitlements.find({ userId: new Types.ObjectId(userId) }).sort({ createdAt: -1 }).lean().exec();
  }

  // ── What the app shows ─────────────────────────────────────────────────────

  private noticeFor(u: PlanUser, state: PlanState, now: Date): PlanNotice | null {
    if (!state.enabled || state.source === 'staff') return null;
    const seen = u.planNotices ?? {};
    const founding = u.proSource === 'founding_tester';
    if (state.plan === 'pro' && founding && !seen.founding_welcome) return 'founding_welcome';
    if (state.plan === 'trial') {
      if (!seen.trial_welcome) return 'trial_welcome';
      if (u.trialEndsAt && u.trialEndsAt.getTime() - now.getTime() <= DAY_MS && !seen.trial_24h) return 'trial_24h';
    }
    if (state.plan === 'free') {
      if (u.trialEndsAt && u.trialEndsAt <= now && !seen.trial_ended) return 'trial_ended';
      if (founding && !seen.founding_ended) return 'founding_ended';
    }
    return null;
  }

  /** GET /me/plan — everything the app needs for chips, locks, modals and the upgrade screen. */
  async summary(userId: string, now = new Date()) {
    const { user, cfg, state } = await this.state(userId, now);
    const daily = await this.allowance(userId, now);
    const unlocked = Object.fromEntries(PRO_FEATURES.map(f => [f, cfg.locks[f] === 'free' || state.plan !== 'free'])) as Record<ProFeature, boolean>;
    return {
      ...state,
      trialDenied: user.trialDenied === 'already_used',
      daily,
      limits: { free: cfg.freeDailyMcqs, pro: cfg.proDailyMcqs },
      locks: cfg.locks,
      unlocked,
      notice: this.noticeFor(user, state, now),
      plans: withSavings(cfg.catalog).map(publicOffer),
      /** Sent with Play purchases (obfuscatedAccountId) so a purchase can only be claimed by this account. */
      billingAccountId: billingAccountId(userId),
      /** Pro from a store purchase: the app shows Manage subscription. */
      store: user.proSource === 'play' || user.proSource === 'paystack' ? user.proSource : null,
    };
  }

  async markNotice(userId: string, notice: PlanNotice) {
    await this.users.updateOne({ _id: userId, [`planNotices.${notice}`]: { $exists: false } }, { $set: { [`planNotices.${notice}`]: new Date() } }).exec();
    this.analytics.track('trial_modal_viewed', userId, { detail: notice });
    return { ok: true };
  }

  // ── Emails (welcome now; reminders from the hourly job) ────────────────────

  /** Sends a plan email at most once per key. */
  async sendOnce(userId: string, key: string, data: { trialEndsAt?: Date; proExpiresAt?: Date }) {
    const claimed = await this.users.findOneAndUpdate({ _id: userId, [`planEmails.${key}`]: { $exists: false } }, { $set: { [`planEmails.${key}`]: new Date() } }).select('email firstName').lean().exec();
    if (!claimed?.email) return false;
    try {
      const mail = planEmail(key, { firstName: claimed.firstName ?? '', ...data });
      if (!mail) return false;
      await this.email.sendPlanEmail(claimed.email, mail.subject, mail.html, key);
      return true;
    } catch (error) {
      this.logger.warn(`Plan email ${key} failed: ${(error as Error).message}`);
      await this.users.updateOne({ _id: userId }, { $unset: { [`planEmails.${key}`]: 1 } }).exec(); // retry next hour
      return false;
    }
  }

  /** Hourly: trial reminders/endings and Founding Tester emails. Batched so a run stays short. */
  async hourly(now = new Date()) {
    const cfg = await this.config();
    if (!cfg.enabled) return { skipped: 'plans off' };
    const BATCH = 300;
    const ids = async (filter: Record<string, unknown>) => (await this.users.find(filter).select('_id').limit(BATCH).lean().exec()).map(u => String(u._id));
    const notPro = { $or: [{ proExpiresAt: { $exists: false } }, { proExpiresAt: { $lte: now } }] };
    const counts: Record<string, number> = {};
    const run = async (key: string, filter: Record<string, unknown>, data: (id: string) => Promise<{ trialEndsAt?: Date; proExpiresAt?: Date }>) => {
      counts[key] = 0;
      for (const id of await ids({ ...filter, [`planEmails.${key}`]: { $exists: false } })) if (await this.sendOnce(id, key, await data(id))) counts[key]++;
    };
    const userDates = async (id: string) => {
      const u = await this.users.findById(id).select('trialEndsAt proExpiresAt').lean().exec();
      return { trialEndsAt: u?.trialEndsAt, proExpiresAt: u?.proExpiresAt };
    };
    await run('trial_24h', { trialEndsAt: { $gt: now, $lte: new Date(now.getTime() + DAY_MS) }, ...notPro }, userDates);
    // Trial over: also counts trial_ended for analytics (once per student, via the email claim).
    const ended = await ids({ trialEndsAt: { $lte: now, $gt: new Date(now.getTime() - 7 * DAY_MS) }, 'planEmails.trial_ended': { $exists: false }, ...notPro });
    counts.trial_ended = 0;
    for (const id of ended) {
      this.analytics.track('trial_ended', id);
      if (await this.sendOnce(id, 'trial_ended', {})) counts.trial_ended++;
    }
    const founding = { proSource: 'founding_tester' };
    await run('founding_welcome', { ...founding, proExpiresAt: { $gt: now } }, userDates);
    await run('founding_3d', { ...founding, proExpiresAt: { $gt: new Date(now.getTime() + DAY_MS), $lte: new Date(now.getTime() + 3 * DAY_MS) } }, userDates);
    await run('founding_1d', { ...founding, proExpiresAt: { $gt: now, $lte: new Date(now.getTime() + DAY_MS) } }, userDates);
    return counts;
  }

  // ── Admin numbers ──────────────────────────────────────────────────────────

  /**
   * Admin → Plans → Overview. Students per plan now, active store
   * subscriptions, purchases (count + naira) in the range, and trial → paid
   * conversion for trials that ended in the range.
   */
  async stats(from: Date, to: Date, now = new Date()) {
    const students = { role: { $exists: false } };
    const pro = { ...students, proExpiresAt: { $gt: now } };
    const [proCount, trialCount, total, bySourceRows] = await Promise.all([
      this.users.countDocuments(pro).exec(),
      this.users.countDocuments({ ...students, trialEndsAt: { $gt: now }, $or: [{ proExpiresAt: { $exists: false } }, { proExpiresAt: { $lte: now } }] }).exec(),
      this.users.countDocuments(students).exec(),
      this.users.aggregate<{ _id: string; n: number }>([{ $match: pro }, { $group: { _id: '$proSource', n: { $sum: 1 } } }]).exec(),
    ]);
    const paid = { source: { $in: ['play', 'paystack'] } };
    const [subscriptions, purchases, refunds] = await Promise.all([
      this.entitlements
        .aggregate<{ _id: string; n: number }>([
          { $match: { source: 'play', status: 'active', autoRenewing: true, expiresAt: { $gt: now } } },
          { $group: { _id: '$planId', n: { $sum: 1 } } },
        ])
        .exec(),
      this.entitlements
        .aggregate<{ _id: { planId: string; source: string }; n: number; kobo: number }>([
          { $match: { ...paid, createdAt: { $gte: from, $lt: to }, status: { $ne: 'revoked' } } },
          { $group: { _id: { planId: '$planId', source: '$source' }, n: { $sum: 1 }, kobo: { $sum: { $ifNull: ['$amountKobo', 0] } } } },
        ])
        .exec(),
      this.entitlements.countDocuments({ ...paid, status: 'revoked', updatedAt: { $gte: from, $lt: to } }).exec(),
    ]);
    // Conversion: trials that ended in the range, and how many of those people ever paid.
    const ended = await this.users
      .find({ ...students, trialEndsAt: { $gte: from, $lt: to, $lte: now } })
      .select('_id')
      .lean()
      .exec();
    const endedIds = ended.map(u => u._id);
    const converted = endedIds.length ? (await this.entitlements.distinct('userId', { ...paid, userId: { $in: endedIds } }).exec()).length : 0;
    const trialsStarted = await this.users.countDocuments({ ...students, trialStartedAt: { $gte: from, $lt: to } }).exec();
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      students: { total, pro: proCount, trial: trialCount, free: Math.max(0, total - proCount - trialCount) },
      proBySource: Object.fromEntries(bySourceRows.map(r => [r._id ?? 'unknown', r.n])),
      activeSubscriptions: {
        total: subscriptions.reduce((t, r) => t + r.n, 0),
        byPlan: Object.fromEntries(subscriptions.map(r => [r._id ?? 'unknown', r.n])),
      },
      purchases: {
        count: purchases.reduce((t, r) => t + r.n, 0),
        revenueNaira: purchases.reduce((t, r) => t + r.kobo, 0) / 100,
        byPlan: purchases.map(r => ({ planId: r._id.planId ?? 'unknown', source: r._id.source, count: r.n, revenueNaira: r.kobo / 100 })),
        refunds,
      },
      trials: {
        started: trialsStarted,
        ended: endedIds.length,
        converted,
        conversionPercent: endedIds.length ? Math.round((converted / endedIds.length) * 1000) / 10 : null,
      },
    };
  }

  // ── Founding Testers ───────────────────────────────────────────────────────

  /**
   * Accounts that will get the Founding Tester month (created before go-live,
   * not staff, not already processed). Dry run by default: lists who.
   */
  async foundingTesters(apply: boolean, goLive: Date) {
    const cfg = await this.config();
    const cutoff = new Types.ObjectId(Math.floor(goLive.getTime() / 1000));
    const rows = await this.users
      .find({ role: { $exists: false }, trialStartedAt: { $exists: false }, trialDenied: { $exists: false }, $or: [{ createdAt: { $lt: goLive } }, { createdAt: { $exists: false }, _id: { $lt: cutoff } }] })
      .select(PLAN_FIELDS + ' username')
      .lean<(PlanUser & { username?: string })[]>()
      .exec();
    if (apply) for (const u of rows) await this.begin(u, { ...cfg, goLiveAt: goLive.toISOString() }, new Date());
    return { count: rows.length, until: new Date(goLive.getTime() + cfg.foundingDays * DAY_MS).toISOString(), students: rows.map(u => ({ id: String(u._id), username: u.username ?? '', email: u.email })) };
  }
}

const bad = (message: string) => new HttpException({ statusCode: 400, message }, HttpStatus.BAD_REQUEST);

function validCatalog(catalog: PlanOffer[]): PlanOffer[] {
  if (!Array.isArray(catalog) || !catalog.length) throw bad('Add at least one plan.');
  const ids = new Set<string>();
  return catalog.map(p => {
    if (!/^[a-z0-9_-]{2,20}$/.test(p.id ?? '') || ids.has(p.id)) throw bad('Each plan needs a unique short id (letters, numbers, - or _).');
    ids.add(p.id);
    if (!Number.isInteger(p.priceNaira) || p.priceNaira < 25 || p.priceNaira > 610_000) throw bad(`${p.id}: price must be ₦25–₦610,000 (Google Play's naira range).`);
    if (!Number.isInteger(p.days) || p.days < 1 || p.days > 400) throw bad(`${p.id}: days must be 1–400.`);
    if (!['one_time', 'subscription'].includes(p.kind)) throw bad(`${p.id}: kind must be one_time or subscription.`);
    if (!p.playProductId?.trim()) throw bad(`${p.id}: add the Google Play product id.`);
    return {
      id: p.id,
      label: String(p.label ?? p.id).slice(0, 40),
      priceNaira: p.priceNaira,
      days: p.days,
      kind: p.kind,
      playProductId: p.playProductId.trim(),
      ...(p.playBasePlanId ? { playBasePlanId: p.playBasePlanId.trim() } : {}),
      highlight: p.highlight === 'popular' || p.highlight === 'best_value' ? p.highlight : null,
      active: p.active !== false,
    };
  });
}

const publicOffer = (p: ReturnType<typeof withSavings>[number]) => ({
  id: p.id,
  label: p.label,
  priceNaira: p.priceNaira,
  days: p.days,
  kind: p.kind,
  playProductId: p.playProductId,
  playBasePlanId: p.playBasePlanId ?? null,
  highlight: p.highlight ?? null,
  savesPercent: p.savesPercent,
  comparedWith: p.comparedWith,
});
