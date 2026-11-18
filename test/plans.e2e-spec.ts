import request from 'supertest';
import { Types } from 'mongoose';
import { seedSampleContent } from '../src/seed/seed-sample-content';
import { PlansService } from '../src/plans/plans.service';
import { startInMemoryApp } from './support/in-memory-app';

/**
 * Free vs Pro: off until go-live, Founding Tester month for existing
 * accounts, a 3-day trial (once per person) for new ones, the daily MCQ
 * limit, feature locks, modals once, emails, admin grants and settings.
 */

jest.setTimeout(120_000);

let server: Awaited<ReturnType<typeof startInMemoryApp>>;
const http = () => request(server.app.getHttpServer());
const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const db = () => server.connection;
const plans = () => server.app.get(PlansService);

let seq = 0;
async function join(extra: Record<string, unknown> = {}) {
  const username = `p${++seq}_${Date.now() % 100000}`;
  const email = `${username}@uni.edu`;
  await http()
    .post(api('/auth/signup'))
    .send({
      firstName: 'Bola', lastName: 'Ade', username, email, password: 'Str0ng!Pass', userType: 'STUDENT',
      studentProfile: { institution: 'University of Lagos', faculty: 'Faculty of Basic Medical Sciences', department: 'Physiology', levelType: 'Undergraduate', level: '100 Level' },
      ...extra,
    })
    .expect(201);
  const res = await http().post(api('/auth/verify')).send({ email, code: server.mail.lastCode(email) }).expect(201);
  const user = await db().collection('users').findOne({ email });
  return { token: res.body.accessToken as string, id: user!._id as Types.ObjectId, username, email };
}

const plan = (token: string) => http().get(api('/me/plan')).set(auth(token)).expect(200).then(r => r.body);
const asAdmin = (method: 'get' | 'put' | 'post' | 'delete', path: string) => http()[method](api(path)).set(auth(admin));
const setPlans = (body: object) => asAdmin('put', '/admin/plans').send(body).expect(200);
const endTrial = (id: Types.ObjectId) =>
  db().collection('users').updateOne({ _id: id }, { $set: { trialEndsAt: new Date(Date.now() - 60_000), trialStartedAt: new Date(Date.now() - 4 * 86_400_000) } });

let admin: string;
let topic: any;
let questions: any[];
let founder: Awaited<ReturnType<typeof join>>;

beforeAll(async () => {
  server = await startInMemoryApp();
  await seedSampleContent(server.connection);
  await server.createStaff('plans-admin@edmira.com', 'admin', 'Staff!2345', 'Ada Admin');
  admin = (await http().post(api('/auth/login')).send({ email: 'plans-admin@edmira.com', password: 'Staff!2345' }).expect(201)).body.accessToken;
  // The topic with the most questions, with extended notes for the lock test.
  const topics = await db().collection('topics').find({ status: 'published' }).toArray();
  const counts = await Promise.all(topics.map(t => db().collection('questions').countDocuments({ topicId: t._id, status: 'published' })));
  topic = topics[counts.indexOf(Math.max(...counts))];
  questions = await db().collection('questions').find({ topicId: topic._id, status: 'published' }).toArray();
  await db().collection('topics').updateOne(
    { _id: topic._id },
    { $set: { extended: [{ heading: 'Deeper mechanisms', body: 'Pro text' }], clinical: [{ heading: 'At the bedside', body: 'Pro case' }] } },
  );
  founder = await join(); // signs up before go-live
});

afterAll(async () => {
  await server?.stop();
});

const answer = (n: number, from = 0) =>
  questions.slice(from, from + n).map(q => ({ questionId: String(q._id), selectedIndex: q.answerIndex }));
const submit = (token: string, answers: object[]) =>
  http().post(api('/quiz-attempts')).set(auth(token)).send({ topicId: String(topic._id), startedAt: new Date(Date.now() - Math.random() * 1e7).toISOString(), answers });

describe('before go-live', () => {
  it('everything is open, no trial starts and no limit applies', async () => {
    const p = await plan(founder.token);
    expect(p).toMatchObject({ enabled: false, plan: 'pro', source: 'open', notice: null });
    expect(p.daily.limit).toBeNull();
    expect(Object.values(p.unlocked).every(Boolean)).toBe(true);
    const u = await db().collection('users').findOne({ _id: founder.id });
    expect(u?.trialStartedAt).toBeUndefined();
  });

  it('shows the plans with savings, and admins can preview the Founding Testers', async () => {
    const p = await plan(founder.token);
    const byId = Object.fromEntries(p.plans.map((x: any) => [x.id, x]));
    expect(byId.day).toMatchObject({ priceNaira: 1000, kind: 'one_time', savesPercent: null });
    expect(byId.month).toMatchObject({ priceNaira: 15000, highlight: 'popular', savesPercent: 25 }); // vs 4 weeks
    expect(byId.year).toMatchObject({ priceNaira: 70000, highlight: 'best_value', savesPercent: 61 }); // vs 12 months
    const preview = (await asAdmin('get', '/admin/plans/founding-testers').expect(200)).body;
    expect(preview.students.map((s: any) => s.username)).toContain(founder.username);
  });

  it('validates admin settings and keeps students out', async () => {
    await http().put(api('/admin/plans')).set(auth(founder.token)).send({ freeDailyMcqs: 5 }).expect(403);
    await asAdmin('put', '/admin/plans').send({ freeDailyMcqs: -1 }).expect(400);
    await asAdmin('put', '/admin/plans').send({ locks: { videos: 'maybe' } }).expect(400);
    await asAdmin('put', '/admin/plans').send({ catalog: [{ id: 'x', label: 'X', priceNaira: 10, days: 1, kind: 'one_time', playProductId: 'p' }] }).expect(400);
  });
});

describe('after go-live', () => {
  beforeAll(async () => {
    await new Promise(r => setTimeout(r, 1100)); // go-live strictly after the founder's sign-up
    const cfg = (await setPlans({ enabled: true, freeDailyMcqs: 5, proDailyMcqs: 8 })).body;
    expect(cfg.goLiveAt).toEqual(expect.any(String));
  });

  it('gives accounts from before go-live the Founding Tester month, once, with its modal and email', async () => {
    const applied = (await asAdmin('post', '/admin/plans/founding-testers/apply').expect(201)).body;
    expect(applied.count).toBeGreaterThanOrEqual(1);
    const p = await plan(founder.token);
    expect(p).toMatchObject({ enabled: true, plan: 'pro', source: 'founding_tester', notice: 'founding_welcome' });
    const days = (Date.parse(p.proExpiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30);
    await http().post(api('/me/plan/notices/founding_welcome')).set(auth(founder.token)).expect(200);
    expect((await plan(founder.token)).notice).toBeNull();
    await plans().hourly();
    expect(server.mail.sent.filter(m => m.to === founder.email && m.kind === 'plan:founding_welcome')).toHaveLength(1);
    await plans().hourly();
    expect(server.mail.sent.filter(m => m.to === founder.email && m.kind === 'plan:founding_welcome')).toHaveLength(1);
  });

  it('starts a 3-day trial for new accounts, with the welcome modal and email', async () => {
    const s = await join({ phoneNumber: '8031234567', countryCode: '+234' });
    const p = await plan(s.token);
    expect(p).toMatchObject({ plan: 'trial', source: 'trial', notice: 'trial_welcome', trialDenied: false });
    const hours = (Date.parse(p.trialEndsAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThanOrEqual(72);
    expect(p.daily).toMatchObject({ limit: 8, used: 0, remaining: 8 });
    await new Promise(r => setTimeout(r, 50));
    expect(server.mail.sent.some(m => m.to === s.email && m.kind === 'plan:trial_welcome')).toBe(true);
    // 24 hours left → reminder modal (after the welcome) and email.
    await http().post(api('/me/plan/notices/trial_welcome')).set(auth(s.token)).expect(200);
    await db().collection('users').updateOne({ _id: s.id }, { $set: { trialEndsAt: new Date(Date.now() + 20 * 3_600_000) } });
    expect((await plan(s.token)).notice).toBe('trial_24h');
    await plans().hourly();
    expect(server.mail.sent.some(m => m.to === s.email && m.kind === 'plan:trial_24h')).toBe(true);
  });

  it('gives one trial per person: same phone number on a new account → Free', async () => {
    const again = await join({ phoneNumber: '08031234567', countryCode: '+234' });
    const p = await plan(again.token);
    expect(p).toMatchObject({ plan: 'free', trialDenied: true, notice: null });
  });

  it('after the trial: Free, the trial-ended modal and email, locks with a teaser', async () => {
    const s = await join();
    await plan(s.token);
    await endTrial(s.id);
    const p = await plan(s.token);
    expect(p).toMatchObject({ plan: 'free', notice: 'trial_ended' });
    expect(p.unlocked).toMatchObject({ extended_notes: false, explanations: false, create_challenge: false });
    await plans().hourly();
    expect(server.mail.sent.some(m => m.to === s.email && m.kind === 'plan:trial_ended')).toBe(true);

    // Extended notes → locked headings only.
    const t = (await http().get(api(`/topics/${topic._id}`)).set(auth(s.token)).expect(200)).body.topic;
    expect(t.extended).toBeUndefined();
    expect(t.clinical).toBeUndefined();
    expect(t.locked).toEqual({ feature: 'extended_notes', extended: ['Deeper mechanisms'], clinical: ['At the bedside'] });
    // Pro features answer 403 PRO_REQUIRED with the feature (the app opens the upgrade screen).
    const pdf = await http().get(api(`/topics/${topic._id}/notes`)).set(auth(s.token)).expect(403);
    expect(pdf.body).toMatchObject({ code: 'PRO_REQUIRED', feature: 'downloads' });
    const retry = await http().get(api(`/topics/${topic._id}/questions`)).query({ ids: String(questions[0]._id) }).set(auth(s.token)).expect(403);
    expect(retry.body.feature).toBe('retry_weak');
    const ch = await http().post(api('/challenges')).set(auth(s.token)).send({ topicId: String(topic._id) }).expect(403);
    expect(ch.body.feature).toBe('create_challenge');
    const g = await http().post(api('/groups')).set(auth(s.token)).send({ name: 'Physio crew' }).expect(403);
    expect(g.body.feature).toBe('create_group');

    // Review: right/wrong and the correct option, no explanations.
    const attempt = (await submit(s.token, answer(2)).expect(201)).body;
    const review = (await http().get(api(`/quiz-attempts/${attempt.id}`)).set(auth(s.token)).expect(200)).body;
    expect(review.explanationsLocked).toBe(true);
    expect(review.questions[0].answerIndex).toEqual(expect.any(Number));
    expect(review.questions[0].explanation).toBeUndefined();

    // Pro (trial) students get everything.
    const t2 = (await http().get(api(`/topics/${topic._id}`)).set(auth(founder.token)).expect(200)).body.topic;
    expect(t2.extended).toHaveLength(1);
  });

  it('enforces the daily MCQ limit on the server, counting only answered questions', async () => {
    const s = await join();
    await plan(s.token);
    await endTrial(s.id); // Free: 5 a day in this test
    const set = (await http().get(api(`/topics/${topic._id}/questions`)).set(auth(s.token)).expect(200)).body;
    expect(set.length).toBeLessThanOrEqual(5);

    // 3 answered + 2 skipped → 3 used.
    const skipped = questions.slice(3, 5).map(q => ({ questionId: String(q._id), selectedIndex: null }));
    await submit(s.token, [...answer(3), ...skipped]).expect(201);
    expect((await plan(s.token)).daily).toMatchObject({ limit: 5, used: 3, remaining: 2 });
    expect((await http().get(api(`/topics/${topic._id}/questions`)).set(auth(s.token)).expect(200)).body.length).toBeLessThanOrEqual(2);

    // 4 more answered → only 2 counted and graded, the rest reported over the limit.
    const over = (await submit(s.token, answer(4)).expect(201)).body;
    expect(over).toMatchObject({ total: 2, overLimit: 2 });
    const limit = await http().get(api(`/topics/${topic._id}/questions`)).set(auth(s.token)).expect(403);
    expect(limit.body).toMatchObject({ code: 'MCQ_LIMIT', limit: 5, used: 5, plan: 'free' });
    const blocked = await submit(s.token, answer(1)).expect(403);
    expect(blocked.body.code).toBe('MCQ_LIMIT');

    // The Question of the Day doesn't count and still works.
    const qotd = (await http().get(api('/qotd')).set(auth(s.token)).expect(200)).body;
    const q = qotd.question ?? qotd.qotd?.question;
    expect(q?.id).toEqual(expect.any(String));
    await http().post(api('/qotd/answer')).set(auth(s.token)).send({ questionId: q.id, selectedIndex: 0 }).expect(200);
    expect((await plan(s.token)).daily.used).toBe(5);
  });

  it('lets admins grant Pro until a date and take it back (logged)', async () => {
    const s = await join();
    await plan(s.token);
    await endTrial(s.id);
    const until = new Date(Date.now() + 10 * 86_400_000).toISOString();
    await http().post(api(`/admin/students/${s.id}/pro`)).set(auth(founder.token)).send({ until }).expect(403);
    const granted = (await asAdmin('post', `/admin/students/${s.id}/pro`).send({ until, note: 'Ambassador' }).expect(201)).body;
    expect(granted.plan).toMatchObject({ plan: 'pro', source: 'grant' });
    expect((await plan(s.token)).plan).toBe('pro');
    const grantId = granted.entitlements[0].id;
    const back = (await asAdmin('delete', `/admin/pro-grants/${grantId}`).send({}).expect(200)).body;
    expect(back.plan.plan).toBe('free');
    const log = (await asAdmin('get', '/admin/audit-log').expect(200)).body.map((e: any) => e.summary);
    expect(log.some((x: string) => x.startsWith(`Gave @${s.username} Pro until`))).toBe(true);
  });

  it('features moved to Free in admin unlock at once', async () => {
    const s = await join();
    await plan(s.token);
    await endTrial(s.id);
    await setPlans({ locks: { extended_notes: 'free' } });
    const t = (await http().get(api(`/topics/${topic._id}`)).set(auth(s.token)).expect(200)).body.topic;
    expect(t.extended).toHaveLength(1);
    await setPlans({ locks: { extended_notes: 'pro' } });
  });

  it('rejects unknown notices', async () => {
    await http().post(api('/me/plan/notices/nope')).set(auth(founder.token)).expect(400);
  });
});
