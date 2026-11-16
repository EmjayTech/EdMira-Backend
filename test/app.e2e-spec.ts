import * as bcrypt from 'bcrypt';
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
    expect(res.body).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Incorrect email/username or password.' });
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

  it('logs in with the username instead of the email, in any letter case', async () => {
    for (const identifier of ['ada', 'ADA', '  Ada ', email]) {
      const res = await http()
        .post(api('/auth/login'))
        .send({ identifier, password: 'Str0ng!Pass' })
        .expect(201);
      expect(res.body).toMatchObject({ accessToken: expect.any(String) });
    }
    const wrong = await http()
      .post(api('/auth/login'))
      .send({ identifier: 'ada', password: 'nope' })
      .expect(401);
    const unknown = await http().post(api('/auth/login')).send({ identifier: 'nobody', password: 'Str0ng!Pass' }).expect(401);
    // An unknown account gets exactly the same reply as a wrong password.
    expect(unknown.body).toEqual(wrong.body);
    await http().post(api('/auth/login')).send({ password: 'Str0ng!Pass' }).expect(400);
  });

  it('refuses a username that is taken (in any case) or badly formed', async () => {
    const taken = await http()
      .post(api('/auth/signup'))
      .send(signupBody('ada2@uni.edu', { username: 'ADA' }))
      .expect(409);
    expect(taken.body.message).toMatch(/username is already taken/);

    for (const [username, code] of [
      ['ad', 'USERNAME_INVALID'],
      ['ada obi', 'USERNAME_INVALID'],
      ['ada@uni', 'USERNAME_INVALID'],
      ['x'.repeat(21), 'USERNAME_INVALID'],
      ['.ada', 'USERNAME_INVALID'],
      ['Support', 'USERNAME_RESERVED'],
      ['edmira_team', 'USERNAME_RESERVED'],
      ['b1tch', 'USERNAME_OFFENSIVE'],
    ]) {
      const res = await http().post(api('/auth/signup')).send(signupBody('ada3@uni.edu', { username })).expect(400);
      expect(res.body.code).toBe(code);
    }
  });

  it('still logs in older accounts that share a username — the password decides', async () => {
    const users = server.connection.collection('users');
    const legacy = (email: string, password: string) =>
      bcrypt.hash(password, 4).then(hash =>
        users.insertOne({ email, username: 'twin', password: hash, isVerified: true, userType: 'STUDENT' }),
      );
    await legacy('twin1@uni.edu', 'Tw1n!One');
    await legacy('twin2@uni.edu', 'Tw1n!Two');
    await legacy('twin3@uni.edu', 'Tw1n!Two');

    const one = await http().post(api('/auth/login')).send({ identifier: 'twin', password: 'Tw1n!One' }).expect(201);
    const profile = await http().get(api('/auth/profile')).set(auth(one.body.accessToken)).expect(200);
    expect(profile.body.email).toBe('twin1@uni.edu');

    // One password opens two of them: we can't tell which is meant, so the
    // usual error — those students can still log in with their email.
    const both = await http().post(api('/auth/login')).send({ identifier: 'twin', password: 'Tw1n!Two' }).expect(401);
    expect(both.body.code).toBe('INVALID_CREDENTIALS');
    await http().post(api('/auth/login')).send({ email: 'twin2@uni.edu', password: 'Tw1n!Two' }).expect(201);
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

describe('usernames', () => {
  const email = 'femi@uni.edu';
  let token: string;

  beforeAll(async () => {
    await http().post(api('/auth/signup')).send(signupBody(email, { username: 'Femi_K' })).expect(201);
    const res = await http().post(api('/auth/verify')).send({ email, code: mail.lastCode(email) }).expect(201);
    token = res.body.accessToken;
    expect(res.body.user).toMatchObject({ username: 'Femi_K', usernameChangeAvailableAt: null });
    expect(res.body.user).not.toHaveProperty('usernameLower');
  });

  it('answers the live availability check', async () => {
    const check = async (username: string) =>
      (await http().get(api('/auth/username-available')).query({ username }).expect(200)).body;
    expect(await check('femi_k')).toEqual({ available: false, reason: 'taken' });
    expect(await check('brand_new')).toEqual({ available: true });
    expect(await check('admin')).toEqual({ available: false, reason: 'reserved' });
    expect(await check('a b')).toEqual({ available: false, reason: 'invalid' });
  });

  it('emails a reset code when the student types their username, with a reply that reveals nothing', async () => {
    const known = await http().post(api('/auth/forgot-password')).send({ identifier: 'FEMI_K' }).expect(201);
    const unknown = await http().post(api('/auth/forgot-password')).send({ identifier: 'no_such_user' }).expect(201);
    expect(known.body).toEqual(unknown.body);
    // Asking again within the 60 s cooldown gets the same reply too (no "please wait" that would reveal the account).
    const again = await http().post(api('/auth/forgot-password')).send({ identifier: 'femi_k' }).expect(201);
    expect(again.body).toEqual(unknown.body);
    const code = mail.lastCode(email);
    expect(mail.sent.at(-1)).toMatchObject({ to: email, kind: 'reset' });

    const wrongAccount = await http()
      .post(api('/auth/reset-password'))
      .send({ identifier: 'no_such_user', code, newPassword: 'N3w!Femi1' })
      .expect(400);
    expect(wrongAccount.body.message).toBe('That code is invalid or has expired.');

    await http().post(api('/auth/reset-password')).send({ identifier: 'femi_k', code, newPassword: 'N3w!Femi1' }).expect(201);
    await http().post(api('/auth/login')).send({ identifier: 'Femi_K', password: 'N3w!Femi1' }).expect(201);
  });

  it('changes the username once every 30 days and reserves the old one', async () => {
    const res = await http().patch(api('/auth/username')).set(auth(token)).send({ username: 'femi.k' }).expect(200);
    expect(res.body.username).toBe('femi.k');
    expect(new Date(res.body.usernameChangeAvailableAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    // Log in with the new name; the old one no longer works for him…
    await http().post(api('/auth/login')).send({ identifier: 'FEMI.K', password: 'N3w!Femi1' }).expect(201);
    await http().post(api('/auth/login')).send({ identifier: 'femi_k', password: 'N3w!Femi1' }).expect(401);
    // …and nobody else can take it for 30 days.
    const taken = await http().post(api('/auth/signup')).send(signupBody('copycat@uni.edu', { username: 'femi_k' })).expect(409);
    expect(taken.body.code).toBe('USERNAME_TAKEN');

    const tooSoon = await http().patch(api('/auth/username')).set(auth(token)).send({ username: 'femi_again' }).expect(400);
    expect(tooSoon.body).toMatchObject({ code: 'USERNAME_CHANGE_TOO_SOON', nextChangeAt: expect.any(String) });
    // Changing only the letter case is always allowed.
    await http().patch(api('/auth/username')).set(auth(token)).send({ username: 'Femi.K' }).expect(200);
    await http().patch(api('/auth/username')).send({ username: 'x_y_z' }).expect(401);
  });

  it('locks out an identifier after 5 failed logins from the same IP', async () => {
    for (let i = 0; i < 5; i++) {
      await http().post(api('/auth/login')).send({ identifier: 'locked_test', password: 'nope' }).expect(401);
    }
    const res = await http().post(api('/auth/login')).send({ identifier: 'locked_test', password: 'nope' }).expect(429);
    expect(res.body).toMatchObject({ code: 'LOGIN_LOCKED', retryAfterSeconds: expect.any(Number) });
  });

  it('records username logins for analytics, without personal data', async () => {
    const events = await server.connection.collection('analytics_events').find({ name: 'login_with_username' }).toArray();
    expect(events.length).toBeGreaterThan(0);
    expect(Object.keys(events[0]).sort()).toEqual(['__v', '_id', 'createdAt', 'name', 'userId']);
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

describe('leaderboards', () => {
  const profile = (institution: string) => ({
    institution,
    faculty: 'Faculty of Clinical Sciences',
    department: 'Medicine & Surgery (MBBS)',
    levelType: 'Undergraduate',
    level: '500 Level',
  });
  const join = async (email: string, institution: string) => {
    await http().post(api('/auth/signup')).send(signupBody(email, { studentProfile: profile(institution) })).expect(201);
    const res = await http().post(api('/auth/verify')).send({ email, code: mail.lastCode(email) }).expect(201);
    return res.body.accessToken as string;
  };
  let kemi: string, tolu: string, zara: string;
  let topicId: string;
  /** Published questions in the topic (an earlier test unpublishes one). */
  let n: number;

  /** Submit a quiz on `topicId` with `right` correct answers. */
  const take = async (token: string, right: number, startedAt = new Date(Date.now() - 10 * 60_000)) => {
    const questions = await server.connection
      .collection('questions')
      .find({ topicId: new Types.ObjectId(topicId), status: 'published' })
      .toArray();
    const answers = questions.map((q, i) => ({
      questionId: String(q._id),
      selectedIndex: i < right ? q.answerIndex : (q.answerIndex + 1) % q.options.length,
    }));
    return http().post(api('/quiz-attempts')).set(auth(token)).send({ topicId, startedAt: startedAt.toISOString(), answers }).expect(201);
  };
  const board = async (token: string, scope: string) =>
    (await http().get(api('/leaderboards')).query({ scope }).set(auth(token)).expect(200)).body;

  beforeAll(async () => {
    kemi = await join('kemi@ui.edu.ng', 'University of Ibadan');
    tolu = await join('tolu@ui.edu.ng', 'University of Ibadan');
    zara = await join('zara@unilag.edu.ng', 'University of Lagos');
    const courses = (await http().get(api('/courses')).set(auth(kemi)).expect(200)).body;
    topicId = courses[0].topics[0].id;
    n = (await http().get(api(`/topics/${topicId}/questions`)).set(auth(kemi)).expect(200)).body.length;
    expect(n).toBeGreaterThanOrEqual(3);

    await take(kemi, n); // n correct + 2 completed + 2 active day
    await take(tolu, 3); // 3 + 2 + 2 = 7
    await take(zara, 1); // 1 + 2 + 2 = 5
  });

  it('ranks classmates ("My course" = same school, programme and level) with public details only', async () => {
    const res = await board(kemi, 'course');
    expect(res.entries.map((e: any) => [e.username, e.points])).toEqual([
      ['kemi', n + 4],
      ['tolu', 7],
    ]);
    expect(res.entries[0]).toEqual({ rank: 1, username: 'kemi', anonymous: false, school: 'UI', level: '500 Level', points: n + 4, isMe: true });
    expect(res.me).toMatchObject({ rank: 1, points: n + 4, nextTier: null });
    // Nothing personal anywhere in the response.
    const json = JSON.stringify(res);
    for (const secret of ['@ui.edu.ng', 'Ada', 'Obi', '8012345678', 'studentId']) expect(json).not.toContain(secret);
  });

  it('widens to the level and the whole school, and shows the gap to the next tier', async () => {
    const level = await board(zara, 'level');
    expect(level.entries.map((e: any) => e.username)).toEqual(['kemi', 'tolu', 'zara']);
    expect(level.me).toMatchObject({ rank: 3, points: 5, nextTier: { rank: 1, pointsNeeded: n + 4 - 5 + 1 } });
    expect((await board(zara, 'school')).entries.map((e: any) => e.username)).toEqual(['zara']);
    expect((await board(zara, 'all')).totalStudents).toBeGreaterThanOrEqual(3);
  });

  it('counts each question once a week and ignores quizzes tapped through too fast', async () => {
    await take(kemi, n); // same questions again: only the completed-quiz points
    await take(tolu, n, new Date(Date.now() - 2_000)); // n questions in 2 s → nothing
    const res = await board(kemi, 'course');
    expect(res.entries.map((e: any) => [e.username, e.points])).toEqual([
      ['kemi', n + 6],
      ['tolu', 7],
    ]);
  });

  it('shows students who opt out as "Anonymous student" to others — immediately', async () => {
    const updated = await http().patch(api('/auth/privacy')).set(auth(tolu)).send({ showOnLeaderboard: false }).expect(200);
    expect(updated.body.privacy).toEqual({ showOnLeaderboard: false });

    const seenByKemi = (await board(kemi, 'course')).entries[1];
    expect(seenByKemi).toMatchObject({ username: null, anonymous: true, points: 7, school: 'UI' });
    const seenByTolu = (await board(tolu, 'course')).entries[1];
    expect(seenByTolu).toMatchObject({ username: 'tolu', isMe: true });

    await http().patch(api('/auth/privacy')).set(auth(tolu)).send({ showOnLeaderboard: true }).expect(200);
    expect((await board(kemi, 'course')).entries[1].username).toBe('tolu');
  });

  it('compares schools by total and average points', async () => {
    const res = (await http().get(api('/leaderboards/schools')).set(auth(kemi)).expect(200)).body;
    const ui = res.schools.find((s: any) => s.school === 'UI');
    expect(ui).toMatchObject({ totalPoints: n + 6 + 7, students: 2, averagePoints: Math.round((n + 13) / 2) });
    expect(res.schools.find((s: any) => s.school === 'UNILAG')).toMatchObject({ students: 1 });
  });

  it('summarises streak, mastered topics and this week for share cards', async () => {
    const res = (await http().get(api('/me/progress-summary')).set(auth(kemi)).expect(200)).body;
    expect(res).toMatchObject({ streakDays: 1, topicsMastered: 1, weekPoints: n + 6, weekRank: expect.any(Number) });
  });

  it('rebuilds a week to the same totals (safe to re-run)', async () => {
    const { LeaderboardService } = await import('../src/leaderboard/leaderboard.service');
    const { weekOf } = await import('../src/leaderboard/week');
    await server.app.get(LeaderboardService).rebuildWeek(weekOf(new Date()));
    expect((await board(kemi, 'course')).entries.map((e: any) => e.points)).toEqual([n + 6, 7]);
  });

  it('moves the student to their new classmates when they change school in Edit profile', async () => {
    await http()
      .patch(api('/auth/profile'))
      .set(auth(zara))
      .send({ studentProfile: { institution: 'University of Ibadan' } })
      .expect(200);
    expect((await board(kemi, 'course')).entries.map((e: any) => e.username)).toEqual(['kemi', 'tolu', 'zara']);
  });

  it('accepts only known analytics events, without personal data', async () => {
    await http().post(api('/analytics/events')).set(auth(kemi)).send({ name: 'leaderboard_viewed', detail: 'course' }).expect(204);
    await http().post(api('/analytics/events')).set(auth(kemi)).send({ name: 'progress_card_shared', detail: 'quiz_score' }).expect(204);
    await http().post(api('/analytics/events')).set(auth(kemi)).send({ name: 'hack' }).expect(400);
    await http().post(api('/analytics/events')).set(auth(kemi)).send({ name: 'leaderboard_viewed', detail: 'kemi@ui.edu.ng' }).expect(400);
    await http().post(api('/analytics/events')).send({ name: 'leaderboard_viewed' }).expect(401);
    // Recorded in the background.
    await new Promise(r => setTimeout(r, 50));
    const events = await server.connection.collection('analytics_events').find({ name: 'progress_card_shared' }).toArray();
    expect(events[0].props).toEqual({ detail: 'quiz_score' });
  });
});
