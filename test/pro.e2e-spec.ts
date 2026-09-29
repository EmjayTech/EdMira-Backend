import request from 'supertest';
import { seedSampleContent } from '../src/seed/seed-sample-content';
import { GooglePlayClient, GoogleSubscription } from '../src/subscription/google-play.client';
import { SubscriptionService } from '../src/subscription/subscription.service';
import { UsersRepository } from '../src/users/user.repository';
import { FakeEmailService, startInMemoryApp } from './support/in-memory-app';

/**
 * EdMira Pro: the free-plan limits, what Pro unlocks, mock exams, and Google
 * Play purchase verification (Google's API is stubbed).
 */

jest.setTimeout(120_000);

const RTDN_SECRET = 'rtdn-test-secret';

let server: Awaited<ReturnType<typeof startInMemoryApp>>;
let http: () => ReturnType<typeof request>;
let mail: FakeEmailService;
let google: GooglePlayClient;

const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function registerStudent(email: string) {
  await http()
    .post(api('/auth/signup'))
    .send({
      firstName: 'Ada',
      lastName: 'Obi',
      username: email.split('@')[0],
      email,
      password: 'Str0ng!Pass',
      userType: 'STUDENT',
      countryCode: '+234',
      phoneNumber: '8012345678',
      studentProfile: {
        institution: 'University of Lagos',
        faculty: 'Faculty of Clinical Sciences',
        department: 'Medicine & Surgery (MBBS)',
        levelType: 'Undergraduate',
        level: '300 Level',
      },
    })
    .expect(201);
  const res = await http().post(api('/auth/verify')).send({ email, code: mail.lastCode(email) }).expect(201);
  const user = await server.app.get(UsersRepository).findByEmail(email);
  return { token: res.body.accessToken as string, userId: String(user._id) };
}

/** Takes one quiz on `topicId` (answers everything with option 0). */
async function takeQuiz(token: string, topicId: string, startedAt: string) {
  const questions = await http().get(api(`/topics/${topicId}/questions`)).set(auth(token)).expect(200);
  const answers = questions.body.map((q: any) => ({ questionId: q.id, selectedIndex: 0 }));
  return http().post(api('/quiz-attempts')).set(auth(token)).send({ topicId, startedAt, answers }).expect(201);
}

const playSubscription = (overrides: Partial<GoogleSubscription> = {}): GoogleSubscription => ({
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
  latestOrderId: 'GPA.1234-5678',
  lineItems: [
    {
      productId: 'edmira_pro',
      expiryTime: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      autoRenewingPlan: { autoRenewEnabled: true },
      offerDetails: { basePlanId: 'monthly' },
    },
  ],
  ...overrides,
});

let topics: string[];
let courseId: string;

beforeAll(async () => {
  process.env.GOOGLE_PLAY_RTDN_SECRET = RTDN_SECRET;
  server = await startInMemoryApp();
  mail = server.mail;
  http = () => request(server.app.getHttpServer());
  google = server.app.get(GooglePlayClient);
  await seedSampleContent(server.connection);

  const { token } = await registerStudent('browse@uni.edu');
  const courses = (await http().get(api('/courses')).set(auth(token)).expect(200)).body;
  const anatomy = courses.find((c: any) => c.title === 'Anatomy');
  courseId = anatomy.id;
  topics = anatomy.topics.map((t: any) => t.id);
});

afterAll(async () => {
  await server?.stop();
});

describe('free plan', () => {
  let student: { token: string; userId: string };
  let attemptId: string;

  beforeAll(async () => {
    student = await registerStudent('free@uni.edu');
  });

  it('starts on the free plan with 3 quizzes a day', async () => {
    const res = await http().get(api('/subscription')).set(auth(student.token)).expect(200);
    expect(res.body).toMatchObject({
      plan: 'free',
      isPro: false,
      expiresAt: null,
      limits: { dailyQuizLimit: 3, quizzesToday: 0, quizzesLeft: 3 },
      features: { unlimitedQuizzes: false, explanations: false, offlineDownloads: false, mockExams: false },
    });
  });

  it('allows 3 quizzes, then asks for Pro', async () => {
    for (const [i, topicId] of topics.slice(0, 3).entries()) {
      const res = await takeQuiz(student.token, topicId, `2026-09-29T0${i}:00:00.000Z`);
      attemptId = res.body.id;
    }
    const status = await http().get(api('/subscription')).set(auth(student.token)).expect(200);
    expect(status.body.limits).toMatchObject({ quizzesToday: 3, quizzesLeft: 0 });

    const blocked = await http().get(api(`/topics/${topics[0]}/questions`)).set(auth(student.token)).expect(403);
    expect(blocked.body).toMatchObject({ code: 'PRO_REQUIRED', feature: 'unlimitedQuizzes' });
    expect(blocked.body.message).toMatch(/3 free quizzes/);

    // Submitting directly doesn't get round the limit…
    await http()
      .post(api('/quiz-attempts'))
      .set(auth(student.token))
      .send({ topicId: topics[0], startedAt: '2026-09-29T09:00:00.000Z', answers: [] })
      .expect(400); // (validation: at least one answer)
    const direct = await http()
      .post(api('/quiz-attempts'))
      .set(auth(student.token))
      .send({
        topicId: topics[0],
        startedAt: '2026-09-29T09:00:00.000Z',
        answers: [{ questionId: '64b000000000000000000000', selectedIndex: 0 }],
      })
      .expect(403);
    expect(direct.body.code).toBe('PRO_REQUIRED');
  });

  it('shows the right answer but locks explanations', async () => {
    const review = await http().get(api(`/quiz-attempts/${attemptId}`)).set(auth(student.token)).expect(200);
    for (const q of review.body.questions) {
      expect(q).toHaveProperty('answerIndex');
      expect(q.explanation).toBeUndefined();
      expect(q.explanationLocked).toBe(true);
    }
  });

  it('keeps notes PDFs and mock exams for Pro', async () => {
    const notes = await http().get(api(`/topics/${topics[0]}/notes`)).set(auth(student.token)).expect(403);
    expect(notes.body).toMatchObject({ code: 'PRO_REQUIRED', feature: 'offlineDownloads' });
    await http().get(api(`/courses/${courseId}/notes`)).set(auth(student.token)).expect(403);

    const mock = await http().post(api('/mock-exams')).set(auth(student.token)).send({ courseId }).expect(403);
    expect(mock.body).toMatchObject({ code: 'PRO_REQUIRED', feature: 'mockExams' });
  });
});

describe('Pro (granted)', () => {
  let student: { token: string; userId: string };
  let examId: string;
  let examQuestions: any[];

  beforeAll(async () => {
    student = await registerStudent('granted@uni.edu');
    await server.app.get(SubscriptionService).grant(student.userId, 30, 'e2e');
  });

  it('reports Pro with no quiz limit', async () => {
    const res = await http().get(api('/subscription')).set(auth(student.token)).expect(200);
    expect(res.body).toMatchObject({
      plan: 'pro',
      isPro: true,
      source: 'grant',
      limits: { dailyQuizLimit: null, quizzesLeft: null },
      features: { unlimitedQuizzes: true, explanations: true, offlineDownloads: true, mockExams: true },
    });
  });

  it('has unlimited quizzes with explanations', async () => {
    let last: any;
    for (let i = 0; i < 4; i++) {
      last = await takeQuiz(student.token, topics[i % topics.length], `2026-09-29T1${i}:00:00.000Z`);
    }
    const review = await http().get(api(`/quiz-attempts/${last.body.id}`)).set(auth(student.token)).expect(200);
    expect(review.body.questions.some((q: any) => typeof q.explanation === 'string')).toBe(true);
    expect(review.body.questions.every((q: any) => q.explanationLocked === false)).toBe(true);
  });

  it('downloads notes', async () => {
    const link = await http().get(api(`/topics/${topics[0]}/notes`)).set(auth(student.token)).expect(200);
    expect(link.body.mimeType).toBe('application/pdf');
  });

  it('starts a timed mock exam of mixed questions without answers', async () => {
    const res = await http()
      .post(api('/mock-exams'))
      .set(auth(student.token))
      .send({ courseId, questionCount: 10 })
      .expect(201);
    expect(res.body).toMatchObject({ courseId, courseTitle: 'Anatomy', total: 10, durationSeconds: 720, score: null });
    expect(new Date(res.body.endsAt).getTime() - new Date(res.body.startedAt).getTime()).toBe(720_000);
    expect(new Set(res.body.questions.map((q: any) => q.topicId)).size).toBeGreaterThan(1);
    for (const q of res.body.questions) {
      expect(q).not.toHaveProperty('answerIndex');
      expect(q).not.toHaveProperty('explanation');
    }
    examId = res.body.id;
    examQuestions = res.body.questions;
  });

  it('rejects odd sizes and answers from outside the exam', async () => {
    await http().post(api('/mock-exams')).set(auth(student.token)).send({ courseId, questionCount: 7 }).expect(400);
    const res = await http()
      .post(api(`/mock-exams/${examId}/submit`))
      .set(auth(student.token))
      .send({ answers: [{ questionId: '64b000000000000000000000', selectedIndex: 0 }] })
      .expect(400);
    expect(res.body.message).toMatch(/aren’t in this exam/);
  });

  it('grades a submission (unanswered = skipped), idempotently', async () => {
    const answers = examQuestions.slice(0, 8).map(q => ({ questionId: q.id, selectedIndex: 0 }));
    const res = await http().post(api(`/mock-exams/${examId}/submit`)).set(auth(student.token)).send({ answers }).expect(201);
    expect(res.body).toMatchObject({ id: examId, total: 10, answeredCount: 8, late: false });
    expect(res.body.score).toBe(Math.round((res.body.correctCount / 10) * 100));

    const again = await http()
      .post(api(`/mock-exams/${examId}/submit`))
      .set(auth(student.token))
      .send({ answers: [] })
      .expect(201);
    expect(again.body).toEqual(res.body);
  });

  it('lists and reviews mock exams — for their owner only', async () => {
    const list = await http().get(api('/mock-exams')).set(auth(student.token)).expect(200);
    expect(list.body.map((e: any) => e.id)).toEqual([examId]);
    const review = await http().get(api(`/mock-exams/${examId}`)).set(auth(student.token)).expect(200);
    expect(review.body.questions.map((q: any) => q.id)).toEqual(examQuestions.map(q => q.id));
    expect(review.body.questions[0]).toHaveProperty('answerIndex');

    const other = await registerStudent('nosy@uni.edu');
    await http().get(api(`/mock-exams/${examId}`)).set(auth(other.token)).expect(404);
  });

  it('goes back to free when the grant ends', async () => {
    await server.app.get(SubscriptionService).revokeGrants(student.userId);
    const res = await http().get(api('/subscription')).set(auth(student.token)).expect(200);
    expect(res.body.plan).toBe('free');
  });
});

describe('Google Play purchases', () => {
  let student: { token: string; userId: string };
  let getSubscription: jest.SpyInstance;
  let acknowledge: jest.SpyInstance;

  beforeAll(async () => {
    student = await registerStudent('buyer@uni.edu');
    getSubscription = jest.spyOn(google, 'getSubscription');
    acknowledge = jest.spyOn(google, 'acknowledge').mockResolvedValue(true);
  });

  const verify = (token: string, body: object) =>
    http().post(api('/subscription/google/verify')).set(auth(token)).send(body);

  it('rejects other products and tokens Google doesn’t know', async () => {
    await verify(student.token, { productId: 'something_else', purchaseToken: 't' }).expect(400);
    getSubscription.mockResolvedValueOnce(null);
    const res = await verify(student.token, { productId: 'edmira_pro', purchaseToken: 'unknown' }).expect(400);
    expect(res.body.message).toMatch(/doesn’t recognise/);
  });

  it('refuses a purchase made for a different account', async () => {
    getSubscription.mockResolvedValueOnce(
      playSubscription({ externalAccountIdentifiers: { obfuscatedExternalAccountId: '64b000000000000000000000' } }),
    );
    await verify(student.token, { productId: 'edmira_pro', purchaseToken: 'tok-other' }).expect(403);
  });

  it('verifies, acknowledges and unlocks Pro', async () => {
    getSubscription.mockResolvedValueOnce(
      playSubscription({ externalAccountIdentifiers: { obfuscatedExternalAccountId: student.userId } }),
    );
    const res = await verify(student.token, { productId: 'edmira_pro', purchaseToken: 'tok-1' }).expect(200);
    expect(res.body).toMatchObject({
      plan: 'pro',
      source: 'google_play',
      productId: 'edmira_pro',
      basePlanId: 'monthly',
      willRenew: true,
      state: 'ACTIVE',
    });
    expect(acknowledge).toHaveBeenCalledWith('edmira_pro', 'tok-1');
  });

  it('won’t link the same purchase to a second account', async () => {
    const thief = await registerStudent('thief@uni.edu');
    getSubscription.mockResolvedValueOnce(playSubscription());
    await verify(thief.token, { productId: 'edmira_pro', purchaseToken: 'tok-1' }).expect(409);
  });

  it('follows Google notifications: cancelled keeps Pro until expiry, expired ends it', async () => {
    const notify = (secret: string) =>
      http()
        .post(api(`/subscription/google/notifications?secret=${secret}`))
        .send({
          message: {
            data: Buffer.from(
              JSON.stringify({ subscriptionNotification: { notificationType: 3, purchaseToken: 'tok-1', subscriptionId: 'edmira_pro' } }),
            ).toString('base64'),
          },
        });

    await notify('wrong').expect(403);

    getSubscription.mockResolvedValueOnce(
      playSubscription({
        subscriptionState: 'SUBSCRIPTION_STATE_CANCELED',
        acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
        lineItems: [{ ...playSubscription().lineItems[0], autoRenewingPlan: { autoRenewEnabled: false } }],
      }),
    );
    await notify(RTDN_SECRET).expect(200);
    let status = (await http().get(api('/subscription')).set(auth(student.token))).body;
    expect(status).toMatchObject({ plan: 'pro', state: 'CANCELED', willRenew: false });

    getSubscription.mockResolvedValueOnce(
      playSubscription({
        subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED',
        lineItems: [{ ...playSubscription().lineItems[0], expiryTime: new Date(Date.now() - 1000).toISOString() }],
      }),
    );
    await notify(RTDN_SECRET).expect(200);
    status = (await http().get(api('/subscription')).set(auth(student.token))).body;
    expect(status.plan).toBe('free');
  });

  it('replaces the old token on an upgrade', async () => {
    getSubscription.mockResolvedValueOnce(
      playSubscription({
        linkedPurchaseToken: 'tok-1',
        lineItems: [{ ...playSubscription().lineItems[0], offerDetails: { basePlanId: 'semester' } }],
      }),
    );
    const res = await verify(student.token, { productId: 'edmira_pro', purchaseToken: 'tok-2' }).expect(200);
    expect(res.body).toMatchObject({ plan: 'pro', basePlanId: 'semester' });
  });
});
