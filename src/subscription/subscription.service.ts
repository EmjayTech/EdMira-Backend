import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { QuizAttempt, QuizAttemptDocument } from '../quiz/quiz-attempt.schema';
import { GooglePlayClient, GoogleSubscription } from './google-play.client';
import {
  DEFAULT_FREE_DAILY_QUIZ_LIMIT,
  PRO_PRODUCT_IDS,
  PRO_REQUIRED,
  ProFeature,
  startOfLagosDay,
} from './pro.constants';
import {
  ENTITLED_STATES,
  Subscription,
  SubscriptionDocument,
  SubscriptionSource,
  SubscriptionState,
} from './subscription.schema';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Error thrown when a free student reaches a Pro feature; the app shows the paywall. */
export const proRequired = (feature: ProFeature, message: string) =>
  new ForbiddenException({ statusCode: 403, error: 'Forbidden', code: PRO_REQUIRED, feature, message });

/** "SUBSCRIPTION_STATE_IN_GRACE_PERIOD" → IN_GRACE_PERIOD */
const toState = (googleState?: string): SubscriptionState => {
  const state = (googleState ?? '').replace(/^SUBSCRIPTION_STATE_/, '') as SubscriptionState;
  return Object.values(SubscriptionState).includes(state) ? state : SubscriptionState.PENDING;
};

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);
  private readonly dailyQuizLimit: number;

  constructor(
    @InjectModel(Subscription.name) private readonly subscriptions: Model<SubscriptionDocument>,
    @InjectModel(QuizAttempt.name) private readonly attempts: Model<QuizAttemptDocument>,
    private readonly google: GooglePlayClient,
    config: ConfigService,
  ) {
    const limit = Number(config.get('FREE_DAILY_QUIZ_LIMIT'));
    this.dailyQuizLimit = Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_FREE_DAILY_QUIZ_LIMIT;
  }

  // ── Entitlement ────────────────────────────────────────────────────────────

  /** The entitlement that currently makes this student Pro (latest expiry), if any. */
  private activeEntitlement(userId: string) {
    return this.subscriptions
      .findOne({
        userId: new Types.ObjectId(userId),
        state: { $in: ENTITLED_STATES },
        expiresAt: { $gt: new Date() },
      })
      .sort({ expiresAt: -1 })
      .exec();
  }

  async isPro(userId: string) {
    return !!(await this.activeEntitlement(userId));
  }

  async assertPro(userId: string, feature: ProFeature, message: string) {
    if (!(await this.isPro(userId))) throw proRequired(feature, message);
  }

  private quizzesToday(userId: string) {
    return this.attempts.countDocuments({
      studentId: new Types.ObjectId(userId),
      submittedAt: { $gte: startOfLagosDay() },
    });
  }

  /**
   * Free students may take `dailyQuizLimit` quizzes a day (Nigerian time).
   * Checked when a quiz starts and again when it's submitted.
   */
  async assertCanTakeQuiz(userId: string) {
    if (await this.isPro(userId)) return;
    if ((await this.quizzesToday(userId)) >= this.dailyQuizLimit) {
      throw proRequired(
        ProFeature.UNLIMITED_QUIZZES,
        `You’ve used your ${this.dailyQuizLimit} free quizzes for today. Go Pro for unlimited quizzes, or come back tomorrow.`,
      );
    }
  }

  /** GET /subscription — what the app needs to show plan, badge and limits. */
  async status(userId: string) {
    const [entitlement, quizzesToday] = await Promise.all([
      this.activeEntitlement(userId),
      this.quizzesToday(userId),
    ]);
    const isPro = !!entitlement;
    return {
      plan: isPro ? 'pro' : 'free',
      isPro,
      source: entitlement?.source ?? null,
      productId: entitlement?.productId ?? null,
      basePlanId: entitlement?.basePlanId ?? null,
      expiresAt: entitlement?.expiresAt.toISOString() ?? null,
      willRenew: entitlement?.autoRenewing ?? false,
      state: entitlement?.state ?? null,
      limits: {
        dailyQuizLimit: isPro ? null : this.dailyQuizLimit,
        quizzesToday,
        quizzesLeft: isPro ? null : Math.max(0, this.dailyQuizLimit - quizzesToday),
        resetsAt: new Date(startOfLagosDay().getTime() + DAY_MS).toISOString(),
      },
      features: Object.fromEntries(Object.values(ProFeature).map(f => [f, isPro])),
    };
  }

  // ── Google Play ────────────────────────────────────────────────────────────

  /** Copies Google's view of a subscription onto our record. */
  private apply(record: SubscriptionDocument, google: GoogleSubscription) {
    const line =
      google.lineItems?.find(l => PRO_PRODUCT_IDS.includes(l.productId)) ?? google.lineItems?.[0];
    record.set({
      state: toState(google.subscriptionState),
      expiresAt: line?.expiryTime ? new Date(line.expiryTime) : new Date(0),
      productId: line?.productId,
      basePlanId: line?.offerDetails?.basePlanId,
      autoRenewing: !!line?.autoRenewingPlan?.autoRenewEnabled,
      latestOrderId: google.latestOrderId,
      testPurchase: !!google.testPurchase,
      lastVerifiedAt: new Date(),
    });
  }

  /**
   * POST /subscription/google/verify — the app sends every Pro purchase (new
   * or restored). Google is the source of truth; the token is bound to the
   * first EdMira account that verifies it.
   */
  async verifyGooglePurchase(userId: string, productId: string, purchaseToken: string) {
    if (!PRO_PRODUCT_IDS.includes(productId)) {
      throw new BadRequestException('That isn’t an EdMira Pro product.');
    }
    const google = await this.google.getSubscription(purchaseToken);
    if (!google) throw new BadRequestException('Google Play doesn’t recognise this purchase.');

    const owner = google.externalAccountIdentifiers?.obfuscatedExternalAccountId;
    if (owner && owner !== userId) {
      throw new ForbiddenException('This purchase belongs to a different EdMira account.');
    }

    let record = await this.subscriptions.findOne({ purchaseToken }).exec();
    if (record && String(record.userId) !== userId) {
      throw new ConflictException('This purchase is already linked to another EdMira account.');
    }
    record ??= new this.subscriptions({
      userId: new Types.ObjectId(userId),
      source: SubscriptionSource.GOOGLE_PLAY,
      purchaseToken,
    });
    this.apply(record, google);
    await record.save();

    // An upgrade/downgrade replaces the old token; stop it granting Pro twice.
    if (google.linkedPurchaseToken) {
      await this.subscriptions
        .updateOne({ purchaseToken: google.linkedPurchaseToken }, { state: SubscriptionState.REPLACED })
        .exec();
    }

    if (google.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING' && record.productId) {
      await this.google.acknowledge(record.productId, purchaseToken);
    }
    return this.status(userId);
  }

  /**
   * Google Play Real-time Developer Notifications (Pub/Sub push). Renewals,
   * cancellations, holds and refunds all arrive here; we re-read the
   * subscription from Google rather than trusting the message.
   */
  async handleGoogleNotification(body: any) {
    let payload: any;
    try {
      payload = JSON.parse(Buffer.from(body?.message?.data ?? '', 'base64').toString('utf8'));
    } catch {
      return { ok: true };
    }
    const token = payload?.subscriptionNotification?.purchaseToken;
    if (!token) return { ok: true }; // test / one-time-product notifications

    const record = await this.subscriptions.findOne({ purchaseToken: token }).exec();
    // Unknown token: the app hasn't verified it yet and will do so itself.
    if (!record) return { ok: true };

    const google = await this.google.getSubscription(token);
    if (google) {
      this.apply(record, google);
    } else {
      record.set({ state: SubscriptionState.EXPIRED, lastVerifiedAt: new Date() });
    }
    await record.save();
    this.logger.log(`Play notification ${payload.subscriptionNotification.notificationType} → ${record.state}`);
    return { ok: true };
  }

  // ── Grants ─────────────────────────────────────────────────────────────────

  /** Gives a student Pro for `days` (used by `yarn pro` and school deals). */
  async grant(userId: string, days: number, note?: string) {
    return this.subscriptions.create({
      userId: new Types.ObjectId(userId),
      source: SubscriptionSource.GRANT,
      state: SubscriptionState.ACTIVE,
      expiresAt: new Date(Date.now() + days * DAY_MS),
      note,
    });
  }

  /** Ends every manual grant for a student (Play subscriptions are left to Google). */
  async revokeGrants(userId: string) {
    await this.subscriptions
      .updateMany(
        { userId: new Types.ObjectId(userId), source: SubscriptionSource.GRANT },
        { state: SubscriptionState.EXPIRED, expiresAt: new Date() },
      )
      .exec();
  }
}
