import request from 'supertest';
import { Types } from 'mongoose';
import { seedSampleContent } from '../src/seed/seed-sample-content';
import { StudyService } from '../src/study/study.service';
import { lagosDay } from '../src/leaderboard/week';
import { startInMemoryApp } from './support/in-memory-app';

/**
 * Part A: study days, streaks + freezes, weekly goal, points (ledger, caps,
 * anti-farming), Question of the Day and the Home summary — against a real
 * (in-memory, replica-set) MongoDB, so transactions run as on Atlas.
 */

jest.setTimeout(180_000);

let server: Awaited<ReturnType<typeof startInMemoryApp>>;
const http = () => request(server.app.getHttpServer());
const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const db = () => server.connection;
const study = () => server.app.get(StudyService);

/** An instant given as Lagos wall-clock time, e.g. lagos('2026-11-12T23:59'). */
const lagos = (local: string) => new Date(`${local}:00+01:00`);

let seq = 0;
async function join(level = '100 Level', department = 'Physiology', institution = 'University of Lagos') {
  const username = `s${++seq}_${Date.now() % 100000}`;
  const email = `${username}@uni.edu`;
  await http()
    .post(api('/auth/signup'))
    .send({
      firstName: 'Bola', lastName: 'Ade', username, email, password: 'Str0ng!Pass', userType: 'STUDENT',
      studentProfile: { institution, faculty: 'Faculty of Basic Medical Sciences', department, levelType: 'Undergraduate', level },
    })
    .expect(201);
  const res = await http().post(api('/auth/verify')).send({ email, code: server.mail.lastCode(email) }).expect(201);
  const user = await db().collection('users').findOne({ email });
  return { token: res.body.accessToken as string, id: user!._id as Types.ObjectId, username };
}

let topics: any[];
const questionsOf = (topic: any) =>
  db().collection('questions').find({ topicId: topic._id, status: 'published' }).sort({ _id: 1 }).toArray();

/** Stores an attempt as it would have been submitted at `submittedAt` (scored later). */
async function rawAttempt(userId: Types.ObjectId, topic: any, right: number, submittedAt: Date, secondsPerQuestion = 20) {
  const qs = await questionsOf(topic);
  const answers = qs.map((q, i) => ({
    questionId: q._id,
    selectedIndex: i < right ? q.answerIndex : (q.answerIndex + 1) % q.options.length,
    correct: i < right,
  }));
  const correct = Math.min(right, qs.length);
  const { insertedId } = await db().collection('quizattempts').insertOne({
    studentId: userId, topicId: topic._id, courseId: topic.courseId, topicTitle: topic.title, courseTitle: 'Course',
    startedAt: new Date(submittedAt.getTime() - qs.length * secondsPerQuestion * 1000), submittedAt,
    total: qs.length, correctCount: correct, answeredCount: qs.length, score: Math.round((correct / qs.length) * 100), answers,
  });
  return insertedId;
}

/** Submit through the API, like the app. */
async function take(token: string, topic: any, right: number) {
  const qs = await questionsOf(topic);
  const answers = qs.map((q, i) => ({ questionId: String(q._id), selectedIndex: i < right ? q.answerIndex : (q.answerIndex + 1) % q.options.length }));
  return http()
    .post(api('/quiz-attempts'))
    .set(auth(token))
    .send({ topicId: String(topic._id), startedAt: new Date(Date.now() - 10 * 60_000).toISOString(), answers })
    .expect(201);
}

const ledgerOf = (userId: Types.ObjectId) => db().collection("points_ledger").find({ userId }).toArray() as Promise<any[]>;
const sum = (rows: { points?: number }[]) => rows.reduce((t, r) => t + (r.points ?? 0), 0);

beforeAll(async () => {
  server = await startInMemoryApp();
  await seedSampleContent(server.connection);
  topics = await db().collection('topics').find({ status: 'published' }).sort({ _id: 1 }).toArray();
  expect(topics.length).toBeGreaterThanOrEqual(12);
});

afterAll(async () => {
  await server?.stop();
});

describe('study days, streaks and points', () => {
  it('a quiz at 23:59 and one at 00:01 (Lagos) are two study days', async () => {
    const a = await join();
    await rawAttempt(a.id, topics[0], 4, lagos('2026-11-12T23:59'));
    await rawAttempt(a.id, topics[1], 4, lagos('2026-11-13T00:01'));
    await study().scoreUnscored();

    const days = await db().collection('study_days').find({ userId: a.id }).sort({ day: 1 }).toArray();
    expect(days.map(d => [d.day, d.studied, d.quizzesCompleted, d.points])).toEqual([
      ['2026-11-12', true, 1, 40 + 5 + 20],
      ['2026-11-13', true, 1, 40 + 5 + 20],
    ]);
    expect((await ledgerOf(a.id)).filter(r => r.sourceType === 'study_day')).toHaveLength(2);
    expect((await study().streakFor(a.id, lagos('2026-11-13T12:00'))).current).toBe(2);
  });

  it('caps a day at 400 points', async () => {
    const b = await join();
    for (let i = 0; i < 12; i++) await rawAttempt(b.id, topics[i], 5, lagos(`2026-11-10T10:${String(10 + i)}`));
    await study().scoreUnscored();
    const day = await db().collection('study_days').findOne({ userId: b.id, day: '2026-11-10' });
    expect(day!.points).toBe(400);
    expect(sum(await ledgerOf(b.id))).toBe(400);
    const week = await db().collection('leaderboard_weeks').findOne({ studentId: b.id, week: '2026-11-09' });
    expect(week).toMatchObject({ points: 400, quizzes: 12, activeDays: 1, correct: 60 });
    const attempts = await db().collection('quizattempts').find({ studentId: b.id }).toArray();
    expect(sum(attempts.map(x => ({ points: x.points })))).toBe(400);
  });

  it('limits points for repeating the same questions', async () => {
    const c = await join();
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await rawAttempt(c.id, topics[0], 5, lagos(`2026-11-11T09:${10 + i * 10}`)));
    await study().scoreUnscored();
    const answerPoints = await Promise.all(
      ids.map(async id => (await db().collection('points_ledger').findOne({ sourceType: 'quiz_answers', sourceId: String(id) }))?.points ?? 0),
    );
    // 1st and 2nd: +10 each; 3rd: already right twice → +2 each; 4th: over 3 tries today → nothing.
    expect(answerPoints).toEqual([50, 50, 10, 0]);
  });

  it('starts a new week on Monday 00:00 Lagos', async () => {
    const d = await join();
    await rawAttempt(d.id, topics[2], 5, lagos('2026-11-08T23:30')); // Sunday
    await rawAttempt(d.id, topics[3], 5, lagos('2026-11-09T00:30')); // Monday
    await study().scoreUnscored();
    const weeks = await db().collection('leaderboard_weeks').find({ studentId: d.id }).sort({ week: 1 }).toArray();
    expect(weeks.map(w => [w.week, w.points, w.activeDays])).toEqual([
      ['2026-11-02', 75, 1],
      ['2026-11-09', 75, 1],
    ]);
    expect((await study().streakFor(d.id, lagos('2026-11-09T08:00'))).current).toBe(2);
  });

  it('a freeze covers one missed day; two missed days end the streak', async () => {
    const e = await join();
    for (const day of ['2026-11-02', '2026-11-03', '2026-11-05']) await rawAttempt(e.id, topics[4], 5, lagos(`${day}T18:00`));
    await study().scoreUnscored();
    expect(await study().streakFor(e.id, lagos('2026-11-05T20:00'))).toMatchObject({ current: 3, frozenDays: ['2026-11-04'], freezeAvailable: false });
    expect((await study().streakFor(e.id, lagos('2026-11-08T09:00'))).current).toBe(0);
  });

  it('gives a too-fast quiz 0 points and flags it for review, without a study day', async () => {
    const f = await join();
    const id = await rawAttempt(f.id, topics[5], 5, lagos('2026-11-11T12:00'), 1);
    await study().scoreUnscored();
    expect(await ledgerOf(f.id)).toEqual([]);
    expect(await db().collection('study_days').findOne({ userId: f.id })).toBeNull();
    expect(await db().collection('integrity_flags').findOne({ kind: 'too_fast_quiz', sourceId: String(id) })).toMatchObject({ status: 'open' });
    expect(await db().collection('quizattempts').findOne({ _id: id })).toMatchObject({ points: 0, scoredAt: expect.any(Date) });
  });

  it('never scores an attempt twice', async () => {
    const before = await db().collection('points_ledger').countDocuments();
    expect(await study().scoreUnscored()).toEqual({ found: 0, scored: 0 });
    const any = await db().collection('quizattempts').findOne({});
    expect(await study().recordQuiz(any!._id, undefined)).toBeNull();
    expect(await db().collection('points_ledger').countDocuments()).toBe(before);
  });

  it('a rebuild from scratch reaches the same totals', async () => {
    const snapshot = async () =>
      (await db().collection('leaderboard_weeks').find({}).toArray())
        .map(w => `${w.week}:${w.studentId}:${w.points}:${w.activeDays}:${w.quizzes}:${w.correct}`)
        .sort();
    const before = await snapshot();
    const daysBefore = await db().collection('study_days').countDocuments();
    await study().rebuildAll();
    expect(await snapshot()).toEqual(before);
    expect(await db().collection('study_days').countDocuments()).toBe(daysBefore);
  });
});

describe('Home summary, weekly goal and Question of the Day', () => {
  let h: Awaited<ReturnType<typeof join>>;
  let i: Awaited<ReturnType<typeof join>>;

  beforeAll(async () => {
    h = await join('100 Level', 'Physiology');
    i = await join('100 Level', 'Physiology');
  });

  it('gives a new student a complete, empty-state summary', async () => {
    const res = (await http().get(api('/home/summary')).set(auth(h.token)).expect(200)).body;
    expect(res).toMatchObject({
      greetingName: 'Bola',
      username: h.username,
      level: '100 Level',
      department: 'Physiology',
      school: 'UNILAG',
      streak: { current: 0, longest: 0, freezeAvailable: true, savedByFreeze: false },
      weeklyGoal: { goalDays: 3, doneDays: 0 },
      continueLearning: { isNew: true, progressPct: 0 },
      focusArea: null,
      leaderboardTeaser: null,
      failed: [],
    });
    expect(res.weeklyGoal.days).toHaveLength(7);
    expect(res.weeklyGoal.days.filter((d: any) => d.isToday)).toHaveLength(1);
    expect(res.qotd.question.options.length).toBeGreaterThanOrEqual(2);
    expect(res.qotd.answer).toBeNull();
    // No personal data beyond the student's own greeting, and never the QOTD answer.
    const json = JSON.stringify(res);
    for (const leak of ['answerIndex', 'explanation', '@uni.edu', 'Ade']) expect(json).not.toContain(leak);
  });

  it('refreshes right after a quiz (cache cleared) with streak, goal, continue, focus area and rank', async () => {
    const submitted = await take(h.token, topics[0], 1); // 20% → a focus area
    expect(submitted.body.pointsResult).toMatchObject({ points: 10 + 5 + 20, studyDay: true, streak: 1, tooFast: false });

    const res = (await http().get(api('/home/summary')).set(auth(h.token)).expect(200)).body;
    expect(res.streak.current).toBe(1);
    expect(res.weeklyGoal).toMatchObject({ doneDays: 1, studiedToday: true });
    expect(res.continueLearning).toMatchObject({ isNew: false, topicId: String(topics[0]._id), progressPct: 20 });
    expect(res.focusArea).toMatchObject({ count: 1, topTopic: { id: String(topics[0]._id), avgPct: 20 } });
    expect(res.leaderboardTeaser).toMatchObject({ scope: 'school', school: 'UNILAG', pointsThisWeek: 35, rank: expect.any(Number) });
  });

  it('a "Retry weak questions" run is graded but earns no points and leaves the topic average alone', async () => {
    const qs = await questionsOf(topics[0]);
    const missed = qs.slice(1).map(q => ({ questionId: String(q._id), selectedIndex: q.answerIndex }));
    const res = await http()
      .post(api('/quiz-attempts'))
      .set(auth(h.token))
      .send({ topicId: String(topics[0]._id), startedAt: new Date(Date.now() - 5 * 60_000).toISOString(), answers: missed, retry: true })
      .expect(201);
    expect(res.body).toMatchObject({ score: 100, retry: true, pointsAwarded: 0, pointsResult: { points: 0 } });

    const home = (await http().get(api('/home/summary')).set(auth(h.token)).expect(200)).body;
    expect(home.focusArea).toMatchObject({ topTopic: { id: String(topics[0]._id), avgPct: 20 } });
    expect(home.leaderboardTeaser).toMatchObject({ pointsThisWeek: 35 });

    // A 100% retry isn't a mastered topic either.
    const me = (await http().get(api('/me/profile')).set(auth(h.token)).expect(200)).body;
    expect((me.data ?? me).progress.topicsMastered).toBe(0);
  });

  it('lets students set a weekly goal of 1–7 days', async () => {
    await http().patch(api('/me/study-goal')).set(auth(h.token)).send({ weeklyDays: 5 }).expect(200, { weeklyDays: 5 });
    await http().patch(api('/me/study-goal')).set(auth(h.token)).send({ weeklyDays: 0 }).expect(400);
    await http().patch(api('/me/study-goal')).set(auth(h.token)).send({ weeklyDays: 8 }).expect(400);
    const res = (await http().get(api('/home/summary')).set(auth(h.token)).expect(200)).body;
    expect(res.weeklyGoal.goalDays).toBe(5);
  });

  it('gives everyone in a group the same question, without the answer', async () => {
    const first = (await http().get(api('/qotd')).set(auth(h.token)).expect(200)).body;
    const again = (await http().get(api('/qotd')).set(auth(h.token)).expect(200)).body;
    const classmate = (await http().get(api('/qotd')).set(auth(i.token)).expect(200)).body;
    expect(again.question.id).toBe(first.question.id);
    expect(classmate.question.id).toBe(first.question.id);
    expect(first).toMatchObject({ day: lagosDay(new Date()), answer: null, answeredCount: null });
    expect(JSON.stringify(first)).not.toMatch(/answerIndex|explanation/);
    const stored = await db().collection('qotd_days').findOne({ day: first.day });
    expect(stored!.group).toBe('ld:100 Level|Physiology');
  });

  it('grades the answer on the server, once a day', async () => {
    const q = (await http().get(api('/qotd')).set(auth(h.token))).body.question;
    const doc = await db().collection('questions').findOne({ _id: new Types.ObjectId(q.id) });
    const res = (await http().post(api('/qotd/answer')).set(auth(h.token)).send({ questionId: q.id, selectedIndex: doc!.answerIndex }).expect(200)).body;
    expect(res).toMatchObject({ awarded: 15, alreadyAnswered: false, answer: { correct: true, answerIndex: doc!.answerIndex, points: 15 } });

    // Sent again (e.g. an offline retry, even with another option): the stored result, no new points.
    const retry = (await http().post(api('/qotd/answer')).set(auth(h.token)).send({ questionId: q.id, selectedIndex: (doc!.answerIndex + 1) % doc!.options.length }).expect(200)).body;
    expect(retry).toMatchObject({ awarded: 0, alreadyAnswered: true, answer: { correct: true } });
    expect((await ledgerOf(h.id)).filter(r => r.sourceType === 'qotd')).toHaveLength(1);
    const after = (await http().get(api('/qotd')).set(auth(h.token))).body;
    expect(after.answer).toMatchObject({ correct: true, explanation: doc!.explanation });
  });

  it('+5 for a wrong answer, and a stale question gets 409', async () => {
    const q = (await http().get(api('/qotd')).set(auth(i.token))).body.question;
    const doc = await db().collection('questions').findOne({ _id: new Types.ObjectId(q.id) });
    const conflict = await http().post(api('/qotd/answer')).set(auth(i.token)).send({ questionId: String(new Types.ObjectId()), selectedIndex: 0 }).expect(409);
    expect(conflict.body.code).toBe('QOTD_CHANGED');
    await http().post(api('/qotd/answer')).set(auth(i.token)).send({ questionId: q.id, selectedIndex: 99 }).expect(400);
    const wrong = (doc!.answerIndex + 1) % doc!.options.length;
    const res = (await http().post(api('/qotd/answer')).set(auth(i.token)).send({ questionId: q.id, selectedIndex: wrong }).expect(200)).body;
    expect(res).toMatchObject({ awarded: 5, answer: { correct: false, selectedIndex: wrong, answerIndex: doc!.answerIndex } });
  });

  it('answering only the QOTD makes a study day (but no +20 bonus)', async () => {
    const j = await join('100 Level', 'Physiology');
    const q = (await http().get(api('/qotd')).set(auth(j.token))).body.question;
    await http().post(api('/qotd/answer')).set(auth(j.token)).send({ questionId: q.id, selectedIndex: 0 }).expect(200);
    const res = (await http().get(api('/home/summary')).set(auth(j.token)).expect(200)).body;
    expect(res.streak.current).toBe(1);
    expect(res.weeklyGoal.doneDays).toBe(1);
    expect(res.qotd.answer).not.toBeNull();
    expect((await ledgerOf(j.id)).map(r => r.sourceType)).toEqual(['qotd']);
  });
});

describe('admin: pinning the Question of the Day', () => {
  const PASSWORD = 'Staff!2345';
  const tokens: Record<string, string> = {};
  const login = async (email: string) => (await http().post(api('/auth/login')).send({ email, password: PASSWORD }).expect(201)).body.accessToken as string;

  beforeAll(async () => {
    await server.createStaff('reviewer@edmira.com', 'reviewer', PASSWORD, 'Rita Reviewer');
    await server.createStaff('creator@edmira.com', 'creator', PASSWORD, 'Chidi Creator');
    tokens.reviewer = await login('reviewer@edmira.com');
    tokens.creator = await login('creator@edmira.com');
  });

  it('pins a question for a group, which students then get', async () => {
    const day = lagosDay(new Date());
    const group = 'ld:300 Level|Anatomy';
    const question = await db().collection('questions').findOne({ status: 'published' }, { sort: { _id: -1 } });
    const body = { day, group, questionId: String(question!._id) };

    await http().put(api('/admin/qotd')).set(auth(tokens.creator)).send(body).expect(403);
    await http().put(api('/admin/qotd')).set(auth(tokens.reviewer)).send({ ...body, day: '2020-01-01' }).expect(400);
    await http().put(api('/admin/qotd')).set(auth(tokens.reviewer)).send({ ...body, group: 'l:999 Level' }).expect(400);
    const pinned = (await http().put(api('/admin/qotd')).set(auth(tokens.reviewer)).send(body).expect(200)).body;
    expect(pinned).toMatchObject({ group, questionId: body.questionId, pinned: true, pinnedBy: 'Rita Reviewer' });

    const k = await join('300 Level', 'Anatomy');
    const seen = (await http().get(api('/qotd')).set(auth(k.token)).expect(200)).body;
    expect(seen.question.id).toBe(body.questionId);

    // Once a student has answered, it can't be changed.
    await http().post(api('/qotd/answer')).set(auth(k.token)).send({ questionId: body.questionId, selectedIndex: 0 }).expect(200);
    await http().put(api('/admin/qotd')).set(auth(tokens.reviewer)).send(body).expect(409);
    await http().delete(api('/admin/qotd')).query({ day, group }).set(auth(tokens.reviewer)).expect(409);

    const list = (await http().get(api('/admin/qotd')).query({ day }).set(auth(tokens.reviewer)).expect(200)).body;
    expect(list.find((d: any) => d.group === group)).toMatchObject({ pinned: true, answeredCount: 1 });
    expect(await db().collection('auditentries').findOne({ entity: 'qotd', action: 'pinned' })).toBeTruthy();
  });
});
