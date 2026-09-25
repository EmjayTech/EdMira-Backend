import request from 'supertest';
import { Types } from 'mongoose';
import { seedSampleContent } from '../src/seed/seed-sample-content';
import { FakeEmailService, startInMemoryApp } from './support/in-memory-app';

/**
 * The mobile app's whole journey, start to finish, against the real app
 * configuration and a real (in-memory) MongoDB. Request bodies mirror what
 * EdMira-MobileApp sends.
 */

jest.setTimeout(120_000);

let server: Awaited<ReturnType<typeof startInMemoryApp>>;
let http: () => ReturnType<typeof request>;
let mail: FakeEmailService;

const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Exactly what the app's RegistrationScreen sends. */
const signupBody = (email: string, overrides: Record<string, unknown> = {}) => ({
  firstName: 'Ada',
  lastName: 'Obi',
  username: email.split('@')[0],
  email,
  password: 'Str0ng!Pass',
  userType: 'STUDENT',
  countryCode: '+234',
  phoneNumber: '8012345678',
  studentProfile: {
    institution: 'Benue State University, Makurdi',
    faculty: 'Faculty of Clinical Sciences',
    department: 'Medicine & Surgery (MBBS)',
    levelType: 'Undergraduate',
    level: '300 Level',
  },
  referralCode: 'FRIEND1',
  ...overrides,
});

/** Sign up + verify; returns the tokens the app would store. */
async function registerStudent(email: string) {
  await http().post(api('/auth/signup')).send(signupBody(email)).expect(201);
  const res = await http()
    .post(api('/auth/verify'))
    .send({ email, code: mail.lastCode(email) })
    .expect(201);
  return res.body as { accessToken: string; refreshToken: string; user: any };
}

beforeAll(async () => {
  server = await startInMemoryApp();
  mail = server.mail;
  http = () => request(server.app.getHttpServer());
  await seedSampleContent(server.connection);
});

afterAll(async () => {
  await server?.stop();
});

describe('reference data', () => {
  it('serves sign-up lists without a token', async () => {
    const res = await http().get(api('/reference/academic-options')).expect(200);
    expect(res.body.departments).toContain('Medicine & Surgery (MBBS)');
    expect(res.body.institutions).toContainEqual({ name: 'University of Lagos', category: 'federal' });
    expect(res.body.programmes.map((p: any) => p.type)).toEqual(['Undergraduate', 'Postgraduate']);
  });

  it('accepts every option it offers at sign-up', async () => {
    const { body: options } = await http().get(api('/reference/academic-options'));
    const postgrad = options.programmes.find((p: any) => p.type === 'Postgraduate');
    for (const [i, department] of options.departments.entries()) {
      await http()
        .post(api('/auth/signup'))
        .send(
          signupBody(`dept${i}@uni.edu`, {
            studentProfile: {
              institution: options.institutions[i % options.institutions.length].name,
              faculty: options.faculties[i % options.faculties.length],
              department,
              levelType: 'Postgraduate',
              level: postgrad.levels[i % postgrad.levels.length],
            },
          }),
        )
        .expect(201);
    }
  });
});

describe('auth', () => {
  const email = 'ada@uni.edu';
  let tokens: { accessToken: string; refreshToken: string };

  it('signs up, rejects a wrong code, then verifies and logs straight in', async () => {
    await http().post(api('/auth/signup')).send(signupBody(email)).expect(201);

    const wrong = await http()
      .post(api('/auth/verify'))
      .send({ email, code: '000000' })
      .expect(400);
    expect(wrong.body.message).toMatch(/Invalid OTP/);

    const res = await http()
      .post(api('/auth/verify'))
      .send({ email, code: mail.lastCode(email) })
      .expect(201);
    expect(res.body).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String) });
    expect(res.body.user).not.toHaveProperty('password');
  });

  it('refuses a wrong password with a message the app can show', async () => {
    const res = await http()
      .post(api('/auth/login'))
      .send({ email, password: 'nope' })
      .expect(401);
    expect(res.body.message).toBe('Invalid credentials');
  });

  it('logs in and returns the full profile', async () => {
    const res = await http()
      .post(api('/auth/login'))
      .send({ email, password: 'Str0ng!Pass' })
      .expect(201);
    tokens = res.body;

    const profile = await http().get(api('/auth/profile')).set(auth(tokens.accessToken)).expect(200);
    expect(profile.body).toMatchObject({
      id: expect.any(String),
      email,
      firstName: 'Ada',
      userType: 'STUDENT',
      phone: { countryCode: '+234', number: '8012345678' },
      studentProfile: {
        institution: 'Benue State University, Makurdi',
        department: 'Medicine & Surgery (MBBS)',
        level: '300 Level',
        referralCode: 'FRIEND1',
      },
    });
    expect(profile.body).not.toHaveProperty('password');
    expect(profile.body).not.toHaveProperty('refreshToken');
  });

  it('never serves one student’s profile to another', async () => {
    const other = await registerStudent('bola@uni.edu');
    const mine = await http().get(api('/auth/profile')).set(auth(tokens.accessToken)).expect(200);
    const theirs = await http().get(api('/auth/profile')).set(auth(other.accessToken)).expect(200);
    expect(mine.body.email).toBe(email);
    expect(theirs.body.email).toBe('bola@uni.edu');
  });

  it('updates name and academic info (Edit profile)', async () => {
    const res = await http()
      .patch(api('/auth/profile'))
      .set(auth(tokens.accessToken))
      .send({
        firstName: 'Adaeze',
        lastName: 'Obi',
        studentProfile: { institution: 'University of Lagos', department: 'Anatomy', level: '400' },
      })
      .expect(200);
    expect(res.body).toMatchObject({
      firstName: 'Adaeze',
      studentProfile: { institution: 'University of Lagos', department: 'Anatomy', level: '400 Level' },
    });
    // Untouched fields survive a partial update.
    expect(res.body.studentProfile.faculty).toBe('Faculty of Clinical Sciences');

    await http()
      .patch(api('/auth/profile'))
      .set(auth(tokens.accessToken))
      .send({ studentProfile: { institution: 'Hogwarts' } })
      .expect(400);
  });

  it('resets a forgotten password with the emailed code', async () => {
    await http().post(api('/auth/forgot-password')).send({ email }).expect(201);
    await http()
      .post(api('/auth/reset-password'))
      .send({ email, code: mail.lastCode(email), newPassword: 'N3w!Password' })
      .expect(201);
    const res = await http()
      .post(api('/auth/login'))
      .send({ email, password: 'N3w!Password' })
      .expect(201);
    tokens = res.body;
  });

  it('refreshes tokens with the refresh token in the Authorization header', async () => {
    const old = tokens.refreshToken;
    // JWTs issued in the same second are identical; make sure the new one differs.
    await new Promise(resolve => setTimeout(resolve, 1100));
    const res = await http().post(api('/auth/refresh')).set(auth(old)).expect(200);
    expect(res.body).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String) });
    expect(res.body.refreshToken).not.toBe(old);
    tokens = res.body;

    // The old refresh token was rotated out and must no longer work.
    await http().post(api('/auth/refresh')).set(auth(old)).expect(401);
    await http().get(api('/auth/profile')).set(auth(tokens.accessToken)).expect(200);
  });

  it('logs out and revokes the access token', async () => {
    await http().post(api('/auth/logout')).set(auth(tokens.accessToken)).expect(200);
    await http().get(api('/auth/profile')).set(auth(tokens.accessToken)).expect(401);
  });
});

describe('learning', () => {
  let student: { accessToken: string };
  let other: { accessToken: string };
  let courses: any[];
  let topicId: string;
  let attemptId: string;
  let firstQuestionId: string;
  const startedAt = '2026-09-24T10:00:00.000Z';

  beforeAll(async () => {
    student = await registerStudent('chi@uni.edu');
    other = await registerStudent('dayo@uni.edu');
  });

  it('requires a token', async () => {
    await http().get(api('/courses')).expect(401);
  });

  it('lists only published courses, with ordered topics and no study material', async () => {
    const res = await http().get(api('/courses')).set(auth(student.accessToken)).expect(200);
    courses = res.body;
    expect(courses.map(c => c.title)).toEqual(['Anatomy', 'Biochemistry', 'Pharmacology', 'Physiology']);
    const anatomy = courses.find(c => c.title === 'Anatomy');
    const orders = anatomy.topics.map((t: any) => t.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(anatomy.topics[0]).not.toHaveProperty('material');
    topicId = anatomy.topics[0].id;

    await http().get(api(`/courses/${anatomy.id}`)).set(auth(student.accessToken)).expect(200);
  });

  it('opens a topic with its material, course and question count', async () => {
    const res = await http().get(api(`/topics/${topicId}`)).set(auth(student.accessToken)).expect(200);
    expect(res.body.topic.material.length).toBeGreaterThan(0);
    expect(res.body.course.title).toBe('Anatomy');
    expect(res.body.questionCount).toBe(5);
  });

  it('returns 404 for unknown or malformed ids', async () => {
    await http().get(api('/topics/not-an-id')).set(auth(student.accessToken)).expect(404);
    await http()
      .get(api('/topics/64b000000000000000000000'))
      .set(auth(student.accessToken))
      .expect(404);
  });

  it('serves quiz questions WITHOUT answers, then grades a submission on the server', async () => {
    const res = await http()
      .get(api(`/topics/${topicId}/questions`))
      .set(auth(student.accessToken))
      .expect(200);
    expect(res.body).toHaveLength(5);
    for (const question of res.body) {
      expect(question).not.toHaveProperty('answerIndex');
      expect(question).not.toHaveProperty('explanation');
      expect(question.options.length).toBeGreaterThanOrEqual(2);
    }
    firstQuestionId = res.body[0].id;

    // Answer everything with option 0 and skip the last one.
    const answers = res.body.map((q: any, i: number) => ({
      questionId: q.id,
      selectedIndex: i === res.body.length - 1 ? null : 0,
    }));
    const submit = await http()
      .post(api('/quiz-attempts'))
      .set(auth(student.accessToken))
      .send({ topicId, startedAt, answers })
      .expect(201);
    expect(submit.body).toMatchObject({
      topicId,
      courseTitle: 'Anatomy',
      total: 5,
      answeredCount: 4,
      score: Math.round((submit.body.correctCount / 5) * 100),
    });
    attemptId = submit.body.id;

    // Retrying the same run (e.g. flaky network) doesn't create a duplicate.
    const retry = await http()
      .post(api('/quiz-attempts'))
      .set(auth(student.accessToken))
      .send({ topicId, startedAt, answers })
      .expect(201);
    expect(retry.body.id).toBe(attemptId);
  });

  it('rejects answers to questions from another topic', async () => {
    const anatomy = courses.find(c => c.title === 'Anatomy');
    const res = await http()
      .post(api('/quiz-attempts'))
      .set(auth(student.accessToken))
      .send({
        topicId: anatomy.topics[1].id,
        startedAt: '2026-09-24T11:00:00.000Z',
        answers: [{ questionId: firstQuestionId, selectedIndex: 0 }],
      })
      .expect(400);
    expect(res.body.message).toMatch(/no longer available/);
  });

  it('lists attempts and reviews one with answers — for its owner only', async () => {
    const list = await http().get(api('/quiz-attempts')).set(auth(student.accessToken)).expect(200);
    expect(list.body.map((a: any) => a.id)).toEqual([attemptId]);

    const review = await http()
      .get(api(`/quiz-attempts/${attemptId}`))
      .set(auth(student.accessToken))
      .expect(200);
    expect(review.body.questions).toHaveLength(5);
    expect(review.body.questions[0].id).toBe(firstQuestionId);
    expect(review.body.questions[0]).toHaveProperty('answerIndex');
    expect(review.body.questions[0]).toHaveProperty('explanation');

    await http().get(api(`/quiz-attempts/${attemptId}`)).set(auth(other.accessToken)).expect(404);
    const othersList = await http().get(api('/quiz-attempts')).set(auth(other.accessToken)).expect(200);
    expect(othersList.body).toEqual([]);
  });

  it('searches published topics', async () => {
    const res = await http().get(api('/search?q=heart')).set(auth(student.accessToken)).expect(200);
    expect(res.body.topics.length).toBeGreaterThan(0);
    expect(res.body.topics[0].course).toHaveProperty('title');
    const empty = await http().get(api('/search?q=')).set(auth(student.accessToken)).expect(200);
    expect(empty.body.courses).toHaveLength(4);
  });

  it('hides a question as soon as it is unpublished', async () => {
    await server.connection
      .collection('questions')
      .updateOne({ _id: new Types.ObjectId(firstQuestionId) }, { $set: { status: 'in_review' } });
    const res = await http()
      .get(api(`/topics/${topicId}/questions`))
      .set(auth(student.accessToken))
      .expect(200);
    expect(res.body.map((q: any) => q.id)).not.toContain(firstQuestionId);
  });

  it('accepts question reports and feedback', async () => {
    await http()
      .post(api(`/questions/${firstQuestionId}/reports`))
      .set(auth(student.accessToken))
      .send({ topicId, reason: 'wrong_answer', note: 'Should be B' })
      .expect(201);
    await http()
      .post(api('/feedback'))
      .set(auth(student.accessToken))
      .send({ area: 'quizzes', rating: null, message: 'More renal questions please' })
      .expect(201);
    await http()
      .post(api('/feedback'))
      .set(auth(student.accessToken))
      .send({ area: 'quizzes', rating: 9, message: 'x' })
      .expect(400);

    const report = await server.connection.collection('questionreports').findOne({});
    expect(report).toMatchObject({ reason: 'wrong_answer', status: 'open' });
  });

  it('serves the latest news', async () => {
    const res = await http().get(api('/news?limit=3')).set(auth(student.accessToken)).expect(200);
    expect(res.body).toHaveLength(3);
    expect(new Date(res.body[0].publishedAt) >= new Date(res.body[1].publishedAt)).toBe(true);
    const one = await http()
      .get(api(`/news/${res.body[0].id}`))
      .set(auth(student.accessToken))
      .expect(200);
    expect(one.body.body.length).toBeGreaterThan(0);
  });
});
