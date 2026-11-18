import request from 'supertest';
import { Types } from 'mongoose';
import { FakePaystackApi, PAYSTACK_API } from '../src/billing/paystack-api';
import { FakePlayApi, PLAY_API, PlaySubscription } from '../src/billing/play-api';
import { billingAccountId } from '../src/plans/billing-account';
import { startInMemoryApp } from './support/in-memory-app';

/**
 * Payments → Pro: Google Play purchases verified with Google (fake here) and
 * bound to the buyer's account, Play notifications (renew, cancel, refund),
 * restore, and Paystack payments confirmed by a signed webhook.
 */

jest.setTimeout(120_000);
process.env.PLAY_RTDN_TOKEN = 'rtdn-secret';

let server: Awaited<ReturnType<typeof startInMemoryApp>>;
const http = () => request(server.app.getHttpServer());
const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let play: FakePlayApi;
let paystack: FakePaystackApi;
let admin: string;

let seq = 0;
async function join() {
  const username = `b${++seq}_${Date.now() % 100000}`;
  const email = `${username}@uni.edu`;
  await http()
    .post(api('/auth/signup'))
    .send({
      firstName: 'Ada', lastName: 'Obi', username, email, password: 'Str0ng!Pass', userType: 'STUDENT',
      studentProfile: { institution: 'University of Lagos', faculty: 'Faculty of Basic Medical Sciences', department: 'Physiology', levelType: 'Undergraduate', level: '100 Level' },
    })
    .expect(201);
  const res = await http().post(api('/auth/verify')).send({ email, code: server.mail.lastCode(email) }).expect(201);
  const user = await server.connection.collection('users').findOne({ email });
  const id = String(user!._id as Types.ObjectId);
  // Past the trial, so Pro can only come from a purchase.
  await server.connection.collection('users').updateOne({ _id: user!._id }, { $set: { trialStartedAt: new Date(Date.now() - 5 * 86_400_000), trialEndsAt: new Date(Date.now() - 2 * 86_400_000) } });
  return { token: res.body.accessToken as string, id };
}

const sub = (userId: string, over: Partial<PlaySubscription> = {}, days = 30, basePlanId = 'monthly'): PlaySubscription => ({
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
  externalAccountIdentifiers: { obfuscatedExternalAccountId: billingAccountId(userId) },
  lineItems: [{ productId: 'edmira_pro', expiryTime: new Date(Date.now() + days * 86_400_000).toISOString(), autoRenewingPlan: { autoRenewEnabled: true }, offerDetails: { basePlanId } }],
  ...over,
});
const verify = (token: string, productId: string, purchaseToken: string) =>
  http().post(api('/me/plan/play/verify')).set(auth(token)).send({ productId, purchaseToken });
const notify = (data: object, token = 'rtdn-secret') =>
  http().post(api('/billing/play/notifications')).query({ token }).send({ message: { data: Buffer.from(JSON.stringify(data)).toString('base64') } });
const plan = (token: string) => http().get(api('/me/plan')).set(auth(token)).expect(200).then(r => r.body);

beforeAll(async () => {
  server = await startInMemoryApp();
  play = server.app.get(PLAY_API);
  paystack = server.app.get(PAYSTACK_API);
  await server.createStaff('billing-admin@edmira.com', 'admin', 'Staff!2345', 'Bill Admin');
  admin = (await http().post(api('/auth/login')).send({ email: 'billing-admin@edmira.com', password: 'Staff!2345' }).expect(201)).body.accessToken;
  await http().put(api('/admin/plans')).set(auth(admin)).send({ enabled: true }).expect(200);
});

afterAll(async () => {
  await server?.stop();
});

describe('Google Play', () => {
  it('verifies a subscription with Google, grants Pro until the period ends and acknowledges it', async () => {
    const s = await join();
    expect((await plan(s.token)).plan).toBe('free');
    play.subs.set('tok-month', sub(s.id));
    const res = (await verify(s.token, 'edmira_pro', 'tok-month').expect(200)).body;
    expect(res).toMatchObject({ status: 'active', planId: 'month', consumable: false });
    expect(res.plan).toMatchObject({ plan: 'pro', source: 'play', store: 'play' });
    expect(play.acknowledged).toContain('tok-month');
    // Sent again (app restart): same result, no duplicate.
    await verify(s.token, 'edmira_pro', 'tok-month').expect(200);
    const grants = (await http().get(api(`/admin/students/${s.id}/plan`)).set(auth(admin)).expect(200)).body.entitlements;
    expect(grants.filter((g: any) => g.source === 'play')).toHaveLength(1);
    expect(grants[0]).toMatchObject({ planId: 'month', amountNaira: 15000, status: 'active' });
  });

  it('refuses a purchase token from another account, or one Google doesn’t know', async () => {
    const owner = await join();
    const thief = await join();
    play.subs.set('tok-owned', sub(owner.id));
    await verify(owner.token, 'edmira_pro', 'tok-owned').expect(200);
    const stolen = await verify(thief.token, 'edmira_pro', 'tok-owned').expect(403);
    expect(stolen.body.code).toBe('PURCHASE_OTHER_ACCOUNT');
    // Bought by someone else's account id from the start.
    play.subs.set('tok-foreign', sub(owner.id));
    expect((await verify(thief.token, 'edmira_pro', 'tok-foreign').expect(403)).body.code).toBe('PURCHASE_OTHER_ACCOUNT');
    expect((await verify(thief.token, 'edmira_pro', 'tok-made-up').expect(400)).body.code).toBe('PURCHASE_NOT_FOUND');
    expect((await verify(thief.token, 'netflix', 'x').expect(400)).body.code).toBe('UNKNOWN_PRODUCT');
    expect((await plan(thief.token)).plan).toBe('free');
  });

  it('gives a day pass 24 hours (added after any Pro already running), consumable', async () => {
    const s = await join();
    play.products.set(`edmira_pro_day:tok-day`, { purchaseState: 0, acknowledgementState: 0, obfuscatedExternalAccountId: billingAccountId(s.id), purchaseTimeMillis: String(Date.now()) });
    const res = (await verify(s.token, 'edmira_pro_day', 'tok-day').expect(200)).body;
    expect(res).toMatchObject({ status: 'active', planId: 'day', consumable: true });
    const hours = (Date.parse(res.plan.proExpiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
    play.products.set(`edmira_pro_day:tok-day2`, { purchaseState: 0, acknowledgementState: 0, obfuscatedExternalAccountId: billingAccountId(s.id) });
    const second = (await verify(s.token, 'edmira_pro_day', 'tok-day2').expect(200)).body;
    expect((Date.parse(second.plan.proExpiresAt) - Date.now()) / 3_600_000).toBeGreaterThan(47.9);
  });

  it('waits on a pending payment (no Pro yet)', async () => {
    const s = await join();
    play.subs.set('tok-pending', sub(s.id, { subscriptionState: 'SUBSCRIPTION_STATE_PENDING' }));
    expect((await verify(s.token, 'edmira_pro', 'tok-pending').expect(200)).body).toMatchObject({ status: 'pending', plan: { plan: 'free' } });
  });

  it('follows Google’s notifications: cancel (Pro until the end), expiry, refund', async () => {
    const s = await join();
    play.subs.set('tok-life', sub(s.id, {}, 7, 'weekly'));
    expect((await verify(s.token, 'edmira_pro', 'tok-life').expect(200)).body.planId).toBe('week');

    await notify({ testNotification: { version: '1.0' } }, 'wrong').expect(404);

    play.subs.set('tok-life', sub(s.id, { subscriptionState: 'SUBSCRIPTION_STATE_CANCELED', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' }, 3, 'weekly'));
    expect((await notify({ subscriptionNotification: { notificationType: 3, purchaseToken: 'tok-life', subscriptionId: 'edmira_pro' } }).expect(200)).body.status).toBe('cancelled');
    expect((await plan(s.token)).plan).toBe('pro');

    play.subs.set('tok-life', sub(s.id, { subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' }, -1, 'weekly'));
    await notify({ subscriptionNotification: { notificationType: 13, purchaseToken: 'tok-life', subscriptionId: 'edmira_pro' } }).expect(200);
    expect((await plan(s.token)).plan).toBe('free');

    play.subs.set('tok-refund', sub(s.id));
    await verify(s.token, 'edmira_pro', 'tok-refund').expect(200);
    expect((await plan(s.token)).plan).toBe('pro');
    expect((await notify({ voidedPurchaseNotification: { purchaseToken: 'tok-refund' } }).expect(200)).body.revoked).toBe(true);
    expect((await plan(s.token)).plan).toBe('free');

    // Unknown tokens are left for the app's own verify call.
    expect((await notify({ subscriptionNotification: { notificationType: 4, purchaseToken: 'tok-new', subscriptionId: 'edmira_pro' } }).expect(200)).body.ignored).toBe('unknown token');
  });

  it('restores purchases on a new phone', async () => {
    const s = await join();
    play.subs.set('tok-restore', sub(s.id, {}, 365, 'yearly'));
    const res = (await http().post(api('/me/plan/play/restore')).set(auth(s.token)).send({ purchases: [{ productId: 'edmira_pro', purchaseToken: 'tok-restore' }, { productId: 'edmira_pro', purchaseToken: 'nope' }] }).expect(200)).body;
    expect(res).toMatchObject({ restored: 1, errors: ['PURCHASE_NOT_FOUND'], plan: { plan: 'pro', source: 'play' } });
  });
});

describe('Paystack (web)', () => {
  const webhook = (body: object, signature?: string) => {
    const raw = JSON.stringify(body);
    return http()
      .post(api('/billing/paystack/webhook'))
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature ?? FakePaystackApi.sign(raw))
      .send(raw);
  };

  it('starts a payment, then a signed webhook (re-checked with Paystack) grants the plan once', async () => {
    const s = await join();
    const init = (await http().post(api('/me/plan/paystack/initialize')).set(auth(s.token)).send({ planId: 'month' }).expect(200)).body;
    expect(init).toMatchObject({ amountNaira: 15000, authorizationUrl: expect.stringContaining(init.reference) });

    await webhook({ event: 'charge.success', data: { reference: init.reference } }, 'bad-signature').expect(401);
    // Paystack hasn't confirmed it yet → nothing granted.
    paystack.transactions.set(init.reference, { status: 'ongoing', reference: init.reference, amount: 1_500_000, currency: 'NGN' });
    expect((await http().get(api(`/me/plan/paystack/verify/${init.reference}`)).set(auth(s.token)).expect(200)).body.status).toBe('pending');

    paystack.transactions.set(init.reference, { status: 'success', reference: init.reference, amount: 1_500_000, currency: 'NGN' });
    expect((await webhook({ event: 'charge.success', data: { reference: init.reference } }).expect(200)).body.status).toBe('paid');
    await webhook({ event: 'charge.success', data: { reference: init.reference } }).expect(200);
    const p = await plan(s.token);
    expect(p).toMatchObject({ plan: 'pro', source: 'paystack' });
    expect((Date.parse(p.proExpiresAt) - Date.now()) / 86_400_000).toBeGreaterThan(29.9);
    const grants = (await http().get(api(`/admin/students/${s.id}/plan`)).set(auth(admin)).expect(200)).body.entitlements;
    expect(grants.filter((g: any) => g.source === 'paystack')).toHaveLength(1);

    // Refunded → Pro taken back.
    await webhook({ event: 'refund.processed', data: { transaction_reference: init.reference } }).expect(200);
    expect((await plan(s.token)).plan).toBe('free');
  });

  it('never grants if the amount paid differs, and keeps other students’ payments private', async () => {
    const s = await join();
    const other = await join();
    const init = (await http().post(api('/me/plan/paystack/initialize')).set(auth(s.token)).send({ planId: 'year' }).expect(200)).body;
    paystack.transactions.set(init.reference, { status: 'success', reference: init.reference, amount: 100, currency: 'NGN' });
    expect((await webhook({ event: 'charge.success', data: { reference: init.reference } }).expect(200)).body.status).toBe('failed');
    expect((await plan(s.token)).plan).toBe('free');
    await http().get(api(`/me/plan/paystack/verify/${init.reference}`)).set(auth(other.token)).expect(404);
    await http().post(api('/me/plan/paystack/initialize')).set(auth(s.token)).send({ planId: 'lifetime' }).expect(400);
  });
});

describe('admin numbers', () => {
  it('counts students per plan, active subscriptions, purchases and revenue, and trial conversion', async () => {
    const res = (await http().get(api('/admin/plans/stats')).set(auth(admin)).expect(200)).body;
    expect(res.students.total).toBeGreaterThan(0);
    expect(res.students.pro + res.students.trial + res.students.free).toBe(res.students.total);
    expect(res.activeSubscriptions.total).toBeGreaterThanOrEqual(2);
    expect(res.purchases.count).toBeGreaterThanOrEqual(5);
    expect(res.purchases.revenueNaira).toBeGreaterThan(0);
    expect(res.purchases.byPlan.some((r: any) => r.planId === 'month' && r.source === 'play')).toBe(true);
    expect(res.purchases.refunds).toBeGreaterThanOrEqual(2);
    // Every test student's trial ended in the range, and several paid → a conversion rate.
    expect(res.trials.ended).toBeGreaterThan(0);
    expect(res.trials.converted).toBeGreaterThan(0);
    expect(res.trials.conversionPercent).toBeGreaterThan(0);
    const list = (await http().get(api('/admin/students')).set(auth(admin)).expect(200)).body;
    expect(list.some((x: any) => x.plan === 'pro' && x.proSource === 'play')).toBe(true);
    await http().get(api('/admin/plans/stats')).query({ from: '2026-12-01', to: '2026-11-01' }).set(auth(admin)).expect(400);
  });
});
