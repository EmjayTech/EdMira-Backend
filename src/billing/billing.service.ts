import { HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Model, Types } from 'mongoose';
import { AnalyticsService } from '../analytics/analytics.service';
import { billingAccountId } from '../plans/billing-account';
import type { PlanOffer } from '../plans/plan-config';
import { PlansService } from '../plans/plans.service';
import { User, UserDocument } from '../users/model/user.model';
import { PAYSTACK_API, PaystackApi } from './paystack-api';
import { PLAY_API, PlayApi, PlaySubscription } from './play-api';
import { PaymentIntent, PaymentIntentDocument } from './schemas/payment-intent.schema';

const DAY_MS = 86_400_000;

const fail = (status: HttpStatus, code: string, message: string) => new HttpException({ statusCode: status, code, message }, status);

/** Play subscription states that give access (grace period keeps access while Google retries the card). */
const ACCESS_STATES = new Set(['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD']);
/** Cancelled but paid up: Pro until the period ends. */
const RUNNING_OUT = new Set(['SUBSCRIPTION_STATE_CANCELED']);

/**
 * Turns verified store payments into Pro. The server never trusts the app:
 * every Play purchase is checked with Google (and must carry this account's
 * id), every Paystack payment with Paystack, before anything is granted.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(PLAY_API) private readonly play: PlayApi,
    @Inject(PAYSTACK_API) private readonly paystack: PaystackApi,
    @InjectModel(PaymentIntent.name) private readonly intents: Model<PaymentIntentDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly plans: PlansService,
    private readonly analytics: AnalyticsService,
  ) {}

  // ── Google Play ────────────────────────────────────────────────────────────

  /**
   * The app bought something on Play: verify it with Google, grant Pro and
   * acknowledge it (Google refunds unacknowledged purchases after 3 days).
   */
  async verifyPlay(userId: string, productId: string, purchaseToken: string) {
    if (!this.play.configured) throw fail(HttpStatus.SERVICE_UNAVAILABLE, 'BILLING_UNAVAILABLE', "Purchases aren't set up on this server yet.");
    const cfg = await this.plans.config();
    const offers = cfg.catalog.filter(o => o.playProductId === productId);
    if (!offers.length) throw fail(HttpStatus.BAD_REQUEST, 'UNKNOWN_PRODUCT', 'That product is not an EdMira plan.');

    const existing = await this.plans.entitlementByRef('play', purchaseToken);
    if (existing && String(existing.userId) !== userId) {
      throw fail(HttpStatus.FORBIDDEN, 'PURCHASE_OTHER_ACCOUNT', 'This purchase belongs to another EdMira account.');
    }

    const oneTime = offers.find(o => o.kind === 'one_time');
    const result = oneTime ? await this.syncOneTime(userId, oneTime, purchaseToken, !!existing) : await this.syncSubscription(userId, offers, purchaseToken, !!existing);
    return { ...result, plan: await this.plans.summary(userId) };
  }

  /** Restore purchases: verify every purchase the store still holds for this phone. */
  async restorePlay(userId: string, purchases: { productId: string; purchaseToken: string }[]) {
    let restored = 0;
    const errors: string[] = [];
    for (const p of purchases.slice(0, 20)) {
      try {
        const r = await this.verifyPlay(userId, p.productId, p.purchaseToken);
        if (r.status === 'active' || r.status === 'cancelled') restored++;
      } catch (error) {
        errors.push((error as { response?: { code?: string } })?.response?.code ?? 'ERROR');
      }
    }
    return { restored, errors, plan: await this.plans.summary(userId) };
  }

  private async syncOneTime(userId: string, offer: PlanOffer, token: string, known: boolean) {
    const p = await this.fetchOrFail(() => this.play.getProduct(offer.playProductId, token));
    if (p.purchaseState === 2) return { status: 'pending' as const };
    if (p.purchaseState !== 0) throw fail(HttpStatus.BAD_REQUEST, 'PURCHASE_NOT_VALID', 'This purchase was cancelled or refunded.');
    this.assertAccount(userId, p.obfuscatedExternalAccountId);
    if (!known) {
      // A day pass adds 24 hours to any Pro the student already has.
      const user = await this.users.findById(userId).select('proExpiresAt').lean().exec();
      const from = Math.max(Date.now(), user?.proExpiresAt?.getTime() ?? 0);
      await this.plans.grant(userId, 'play', new Date(from + offer.days * DAY_MS), {
        ref: token,
        planId: offer.id,
        amountKobo: offer.priceNaira * 100,
        autoRenewing: false,
        startsAt: new Date(Number(p.purchaseTimeMillis) || Date.now()),
      });
      this.analytics.track('purchase_completed', userId, { detail: offer.id });
    }
    if (p.acknowledgementState !== 1) await this.play.acknowledgeProduct(offer.playProductId, token).catch(e => this.logger.warn(`ack failed: ${e.message}`));
    return { status: 'active' as const, planId: offer.id, consumable: true };
  }

  private async syncSubscription(userId: string, offers: PlanOffer[], token: string, known: boolean) {
    const s = await this.fetchOrFail(() => this.play.getSubscription(token));
    if (s.subscriptionState === 'SUBSCRIPTION_STATE_PENDING') return { status: 'pending' as const };
    this.assertAccount(userId, s.externalAccountIdentifiers?.obfuscatedExternalAccountId);
    const result = await this.applySubscription(userId, offers, token, s);
    if (!known && result.status === 'active') this.analytics.track('purchase_completed', userId, { detail: result.planId });
    if (s.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING' && result.status === 'active') {
      await this.play.acknowledgeSubscription(s.lineItems?.[0]?.productId ?? offers[0].playProductId, token).catch(e => this.logger.warn(`ack failed: ${e.message}`));
    }
    return { ...result, consumable: false };
  }

  /** Mirrors a Play subscription's state onto its entitlement. */
  private async applySubscription(userId: string, offers: PlanOffer[], token: string, s: PlaySubscription) {
    const line = s.lineItems?.[0];
    const offer = offers.find(o => o.playBasePlanId && o.playBasePlanId === line?.offerDetails?.basePlanId) ?? offers.find(o => o.kind === 'subscription') ?? offers[0];
    const expiry = line?.expiryTime ? new Date(line.expiryTime) : new Date();
    const status = ACCESS_STATES.has(s.subscriptionState) ? 'active' : RUNNING_OUT.has(s.subscriptionState) ? 'cancelled' : 'revoked';
    // On hold / paused / expired: no access, whatever the last expiry said.
    const expiresAt = status === 'revoked' ? new Date(Math.min(expiry.getTime(), Date.now())) : expiry;
    await this.plans.grant(userId, 'play', expiresAt, {
      ref: token,
      planId: offer.id,
      amountKobo: offer.priceNaira * 100,
      autoRenewing: !!line?.autoRenewingPlan?.autoRenewEnabled,
      status,
    });
    // Re-subscribing / changing plan replaces the old purchase token.
    if (s.linkedPurchaseToken) await this.plans.revokeByRef('play', s.linkedPurchaseToken, 'Replaced by a newer purchase');
    return { status, planId: offer.id };
  }

  /**
   * Real-time developer notifications (Pub/Sub push): renewals, cancellations,
   * holds, refunds. Only purchases the app already registered are updated.
   */
  async handlePlayNotification(body: { message?: { data?: string } }) {
    const raw = body?.message?.data;
    if (!raw) return { ok: true, ignored: 'no data' };
    let n: {
      subscriptionNotification?: { notificationType?: number; purchaseToken?: string; subscriptionId?: string };
      voidedPurchaseNotification?: { purchaseToken?: string };
      testNotification?: object;
    };
    try {
      n = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      return { ok: true, ignored: 'bad data' };
    }
    if (n.testNotification) return { ok: true, test: true };

    if (n.voidedPurchaseNotification?.purchaseToken) {
      const e = await this.plans.revokeByRef('play', n.voidedPurchaseNotification.purchaseToken, 'Refunded / voided on Google Play');
      return { ok: true, revoked: !!e };
    }

    const sub = n.subscriptionNotification;
    if (sub?.purchaseToken) {
      const known = await this.plans.entitlementByRef('play', sub.purchaseToken);
      if (!known) return { ok: true, ignored: 'unknown token' }; // the app's verify call will register it
      const userId = String(known.userId);
      const cfg = await this.plans.config();
      const offers = cfg.catalog.filter(o => o.playProductId === (sub.subscriptionId ?? ''));
      const s = await this.play.getSubscription(sub.purchaseToken);
      const result = await this.applySubscription(userId, offers.length ? offers : cfg.catalog.filter(o => o.kind === 'subscription'), sub.purchaseToken, s);
      // 3 = SUBSCRIPTION_CANCELED (auto-renew turned off).
      if (sub.notificationType === 3) this.analytics.track('subscription_cancelled', userId, { detail: result.planId });
      return { ok: true, status: result.status };
    }
    return { ok: true, ignored: 'not a subscription event' };
  }

  private assertAccount(userId: string, obfuscated: string | undefined) {
    // Purchases made by this app always carry the buyer's account id.
    if (!obfuscated || obfuscated !== billingAccountId(userId)) {
      throw fail(HttpStatus.FORBIDDEN, 'PURCHASE_OTHER_ACCOUNT', 'This purchase belongs to another EdMira account.');
    }
  }

  private async fetchOrFail<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404 || status === 400 || status === 410) throw fail(HttpStatus.BAD_REQUEST, 'PURCHASE_NOT_FOUND', "We couldn't find this purchase on Google Play.");
      throw fail(HttpStatus.BAD_GATEWAY, 'STORE_UNAVAILABLE', "Google Play didn't answer. Your purchase is safe; we'll try again.");
    }
  }

  // ── Paystack (web) ─────────────────────────────────────────────────────────

  /** Starts a Paystack payment for one plan period (renewals come with the web app). */
  async paystackInitialize(userId: string, planId: string) {
    if (!this.paystack.configured) throw fail(HttpStatus.SERVICE_UNAVAILABLE, 'BILLING_UNAVAILABLE', "Card payments aren't set up on this server yet.");
    const cfg = await this.plans.config();
    const offer = cfg.catalog.find(o => o.id === planId && o.active);
    if (!offer) throw fail(HttpStatus.BAD_REQUEST, 'UNKNOWN_PLAN', 'Pick one of the plans shown.');
    const user = await this.users.findById(userId).select('email').lean().exec();
    if (!user?.email) throw new NotFoundException();
    const reference = `edm_${randomUUID().replace(/-/g, '')}`;
    const amountKobo = offer.priceNaira * 100;
    await this.intents.create({ reference, userId: new Types.ObjectId(userId), planId: offer.id, days: offer.days, amountKobo });
    const { authorizationUrl, accessCode } = await this.paystack.initialize({
      email: user.email,
      amountKobo,
      reference,
      callbackUrl: process.env.PAYSTACK_CALLBACK_URL || undefined,
      metadata: { planId: offer.id, account: billingAccountId(userId) },
    });
    return { reference, authorizationUrl, accessCode, amountNaira: offer.priceNaira };
  }

  /** After checkout (or if the webhook is late): confirm with Paystack and grant. */
  async paystackVerify(userId: string, reference: string) {
    const intent = await this.intents.findOne({ reference }).lean().exec();
    if (!intent || String(intent.userId) !== userId) throw new NotFoundException('Payment not found.');
    const status = await this.settlePaystack(reference);
    return { status, plan: await this.plans.summary(userId) };
  }

  /** Signed webhook from Paystack. Always re-checks the transaction with Paystack's API. */
  async paystackWebhook(rawBody: Buffer | undefined, signature: string | undefined, body: { event?: string; data?: { reference?: string; transaction_reference?: string } }) {
    if (!rawBody || !this.paystack.validSignature(rawBody, signature)) throw fail(HttpStatus.UNAUTHORIZED, 'BAD_SIGNATURE', 'Invalid signature.');
    if (body?.event === 'charge.success' && body.data?.reference) return { ok: true, status: await this.settlePaystack(body.data.reference) };
    if (body?.event === 'refund.processed') {
      const ref = body.data?.transaction_reference ?? body.data?.reference;
      if (ref) {
        await this.intents.updateOne({ reference: ref }, { $set: { status: 'refunded' } }).exec();
        await this.plans.revokeByRef('paystack', ref, 'Refunded on Paystack');
      }
      return { ok: true };
    }
    return { ok: true, ignored: body?.event ?? 'unknown' };
  }

  private async settlePaystack(reference: string): Promise<'paid' | 'pending' | 'failed'> {
    const intent = await this.intents.findOne({ reference }).exec();
    if (!intent) return 'failed';
    if (intent.status === 'paid') return 'paid';
    const tx = await this.paystack.verify(reference);
    if (tx.status !== 'success') {
      if (['failed', 'abandoned', 'reversed'].includes(tx.status)) await this.intents.updateOne({ _id: intent._id, status: 'pending' }, { $set: { status: 'failed' } }).exec();
      return tx.status === 'pending' || tx.status === 'ongoing' ? 'pending' : 'failed';
    }
    if (tx.amount !== intent.amountKobo || tx.currency !== 'NGN') {
      this.logger.error(`Paystack ${reference}: paid ${tx.amount} ${tx.currency}, expected ${intent.amountKobo} NGN`);
      return 'failed';
    }
    // Exactly once, even if the webhook and the app's verify race.
    const claimed = await this.intents.findOneAndUpdate({ _id: intent._id, status: { $ne: 'paid' } }, { $set: { status: 'paid', paidAt: new Date() } }).exec();
    if (!claimed) return 'paid';
    const userId = String(intent.userId);
    const user = await this.users.findById(userId).select('proExpiresAt').lean().exec();
    const from = Math.max(Date.now(), user?.proExpiresAt?.getTime() ?? 0);
    await this.plans.grant(userId, 'paystack', new Date(from + intent.days * DAY_MS), { ref: reference, planId: intent.planId, amountKobo: intent.amountKobo, autoRenewing: false });
    this.analytics.track('purchase_completed', userId, { detail: intent.planId });
    return 'paid';
  }
}
