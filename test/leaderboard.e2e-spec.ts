import request from 'supertest';
import { Types } from 'mongoose';
import { seedSampleContent } from '../src/seed/seed-sample-content';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service';
import { LeaderboardJobsService } from '../src/leaderboard/leaderboard-jobs.service';
import { addDays, lagosDay, previousWeek, weekOf } from '../src/leaderboard/week';
import { startInMemoryApp } from './support/in-memory-app';

/**
 * Part C: the redesigned leaderboard (GET /leaderboard and friends), the
 * weekly close, inbox messages, anti-cheat flags and the admin tools.
 * Board rows are written directly where a test needs exact numbers; the
 * scoring itself is covered by study.e2e-spec.ts.
 */

jest.setTimeout(180_000);

let server: Awaited<ReturnType<typeof startInMemoryApp>>;
const http = () => request(server.app.getHttpServer());
const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const db = () => server.connection;
const lb = () => server.app.get(LeaderboardService);
const jobs = () => server.app.get(LeaderboardJobsService);

const WEEK = weekOf(new Date());
const LAST = previousWeek(WEEK);
const BENIN = 'University of Benin';
const JOS = 'University of Jos';

type Student = { token: string; id: Types.ObjectId; username: string };

async function join(username: string, { institution = BENIN, level = '200 Level', department = 'Physiology' } = {}): Promise<Student> {
  const email = `${username}@lb.test`;
  await http()
    .post(api('/auth/signup'))
    .send({
      firstName: 'Real', lastName: 'Name', username, email, password: 'Str0ng!Pass', userType: 'STUDENT', phoneNumber: '8099999999', countryCode: '+234',
      studentProfile: { institution, faculty: 'Faculty of Basic Medical Sciences', department, levelType: 'Undergraduate', level },
    })
    .expect(201);
  const res = await http().post(api('/auth/verify')).send({ email, code: server.mail.lastCode(email) }).expect(201);
  const user = await db().collection('users').findOne({ email });
  return { token: res.body.accessToken, id: user!._id as Types.ObjectId, username };
}

/** A board row with exact numbers. */
async function row(
  s: Student,
  points: number,
  { activeDays = 1, correct = 0, reachedAt = new Date('2026-01-01T00:00:00Z'), week = WEEK, institution = BENIN, level = '200 Level', department = 'Physiology' } = {},
) {
  await db().collection('leaderboard_weeks').updateOne(
    { week, studentId: s.id },
    { $set: { points, activeDays, correct, quizzes: 1, improvements: 0, reachedAt, institution, level, department } },
    { upsert: true },
  );
}

const board = async (s: Student, query: Record<string, string | number> = {}) =>
  (await http().get(api('/leaderboard')).query(query).set(auth(s.token)).expect(200)).body;

let a: Student, b: Student, c: Student, d: Student, e: Student;

beforeAll(async () => {
  server = await startInMemoryApp();
  await seedSampleContent(server.connection);
  [a, b, c, d] = await Promise.all([join('amaka'), join('bayo'), join('chioma'), join('dapo')]);
  e = await join('efe', { institution: JOS, level: '300 Level', department: 'Anatomy' });

  // Same points: more study days wins; then more correct answers; then whoever got there first.
  await row(a, 100, { activeDays: 2, correct: 30 });
  await row(b, 100, { activeDays: 3, correct: 10, reachedAt: new Date('2026-01-02T00:00:00Z') });
  await row(c, 100, { activeDays: 3, correct: 20 });
  await row(d, 90, { activeDays: 4, correct: 50 });
  await row(e, 500, { institution: JOS, level: '300 Level', department: 'Anatomy' });
});

afterAll(async () => {
  await server?.stop();
});

describe('ranking', () => {
  it('ranks by points, then study days, then correct answers, then who got there first', async () => {
    const res = await board(a, { scope: 'school' });
    expect(res.entries.map((x: any) => [x.rank, x.username])).toEqual([
      [1, 'chioma'],
      [2, 'bayo'],
      [3, 'amaka'],
      [4, 'dapo'],
    ]);
    expect(res).toMatchObject({ scope: 'school', period: 'this_week', week_start: WEEK, week_end: addDays(WEEK, 6), total_ranked: 4 });
    expect(Date.parse(res.resets_at)).toBeGreaterThan(Date.now());
  });

  it('shows only public details: username, initials, school, level, points, study days', async () => {
    const res = await board(a, { scope: 'all' });
    expect(res.entries[0]).toEqual({
      rank: 1, username: 'efe', initials: 'EF', avatar_url: null, avatar_preset: null, anonymous: false, school_short: expect.any(String),
      level: '300 Level', points: 500, study_days: 1, is_me: false, is_winner: false,
    });
    const json = JSON.stringify(res);
    for (const secret of ['@lb.test', 'Real', 'Name', '8099999999', 'studentId', String(a.id)]) expect(json).not.toContain(secret);
  });

  it('gives your own position even when you are not on the page', async () => {
    const res = await board(d, { scope: 'school', limit: 2 });
    expect(res.entries).toHaveLength(2);
    expect(res.next_cursor).toBe('2');
    expect(res.me).toMatchObject({ rank: 4, points: 90, study_days: 4, points_to_next_rank: 11, next_rank_username: 'amaka', percentile: 100, hidden: false });
    const page2 = await board(d, { scope: 'school', limit: 2, cursor: res.next_cursor });
    expect(page2.entries.map((x: any) => x.rank)).toEqual([3, 4]);
    expect(page2.next_cursor).toBeNull();
  });

  it('filters by school, level, department and classmates; All of EdMira has everyone', async () => {
    expect((await board(e, { scope: 'school' })).entries.map((x: any) => x.username)).toEqual(['efe']);
    expect((await board(e, { scope: 'level' })).entries.map((x: any) => x.username)).toEqual(['efe']);
    expect((await board(a, { scope: 'department' })).total_ranked).toBe(4);
    expect((await board(a, { scope: 'course' })).total_ranked).toBe(4);
    expect((await board(a, { scope: 'all' })).total_ranked).toBe(5);
  });

  it('never lets a student ask for another school’s board', async () => {
    await http().get(api('/leaderboard')).query({ scope: 'school', institution: JOS }).set(auth(a.token)).expect(400);
    await http().get(api('/leaderboard')).query({ scope: 'everyone' }).set(auth(a.token)).expect(400);
    await http().get(api('/leaderboard')).expect(401);
  });

  it('shows friends (accepted connections) only, and hides blocked students from each other', async () => {
    const pair = [String(a.id), String(e.id)].sort().join(':');
    await db().collection('connections').insertOne({ requesterId: a.id, recipientId: e.id, pairKey: pair, livePair: pair, status: 'accepted', createdAt: new Date() });
    expect((await board(a, { scope: 'friends' })).entries.map((x: any) => x.username)).toEqual(['efe', 'amaka']);

    await db().collection('blocks').insertOne({ blockerId: e.id, blockedId: a.id, createdAt: new Date() });
    expect((await board(a, { scope: 'friends' })).entries.map((x: any) => x.username)).toEqual(['amaka']);
    const all = await board(a, { scope: 'all' });
    expect(all.entries[0]).toMatchObject({ username: null, anonymous: true, initials: '?' });
    await db().collection('blocks').deleteMany({});
  });

  it('shows a fresh score straight away (the page cache is cleared when points are earned)', async () => {
    expect((await board(d, { scope: 'school' })).me.rank).toBe(4);
    const topic = await db().collection('topics').findOne({ status: 'published' });
    const qs = await db().collection('questions').find({ topicId: topic!._id, status: 'published' }).toArray();
    await http()
      .post(api('/quiz-attempts'))
      .set(auth(d.token))
      .send({ topicId: String(topic!._id), startedAt: new Date(Date.now() - 10 * 60_000).toISOString(), answers: qs.map(q => ({ questionId: String(q._id), selectedIndex: q.answerIndex })) })
      .expect(201);
    const after = await board(d, { scope: 'school' });
    expect(after.me.points).toBeGreaterThan(90);
    expect(after.entries[0].username).toBe('dapo');
  });
});

describe('privacy', () => {
  it('leaves opted-out, excluded and suspended students off other boards; they still see their own rank', async () => {
    await http().patch(api('/auth/privacy')).set(auth(b.token)).send({ showOnLeaderboard: false }).expect(200);
    const seenByA = await board(a, { scope: 'school' });
    expect(seenByA.entries.map((x: any) => x.username)).not.toContain('bayo');
    const seenByB = await board(b, { scope: 'school' });
    expect(seenByB.me).toMatchObject({ hidden: true, rank: expect.any(Number), points: 100 });
    expect(seenByB.entries.map((x: any) => x.username)).not.toContain('bayo');
    await http().patch(api('/auth/privacy')).set(auth(b.token)).send({ showOnLeaderboard: true }).expect(200);

    await db().collection('users').updateOne({ _id: c.id }, { $set: { status: 'suspended' } });
    lb().forgetHidden();
    expect((await board(a, { scope: 'school' })).entries.map((x: any) => x.username)).not.toContain('chioma');
    await db().collection('users').updateOne({ _id: c.id }, { $set: { status: 'active' } });
    lb().forgetHidden();
  });
});

describe('Schools board', () => {
  it('ranks by average points per active student, only schools with 5+ active students', async () => {
    const extra = await Promise.all(['f1', 'f2', 'f3', 'f4'].map(n => join(`jos_${n}`, { institution: JOS })));
    for (const s of extra) await row(s, 100, { institution: JOS });
    let res = (await http().get(api('/leaderboard/schools')).set(auth(e.token)).expect(200)).body;
    expect(res.min_active_students).toBe(5);
    expect(res.schools).toEqual([
      expect.objectContaining({ rank: 1, school_name: JOS, active_students: 5, total_points: 900, avg_points: 180, is_my_school: true }),
    ]);
    // Benin has only 4 active students.
    expect(res.schools.find((s: any) => s.school_name === BENIN)).toBeUndefined();
    res = (await http().get(api('/leaderboard/schools')).set(auth(a.token)).expect(200)).body;
    expect(res.schools[0].is_my_school).toBe(false);
  });
});

describe('closing the week (Monday 00:00 Lagos)', () => {
  beforeAll(async () => {
    await row(a, 300, { week: LAST, activeDays: 5 });
    await row(b, 200, { week: LAST, activeDays: 4 });
    await row(e, 250, { week: LAST, institution: JOS, level: '300 Level', department: 'Anatomy' });
    await db().collection('users').updateOne({ _id: d.id }, { $set: { 'privacy.muteLeaderboardNotifications': true } });
    await row(d, 50, { week: LAST });
    // Last week's rows have no ledger behind them here; keep reconcile from wiping them.
    await db().collection('points_ledger').insertMany(
      [
        [a, 300],
        [b, 200],
        [e, 250],
        [d, 50],
      ].map(([s, p]) => ({
        userId: (s as Student).id, occurredAt: new Date(), day: LAST, week: LAST, sourceType: 'adjustment',
        sourceId: `test:${(s as Student).username}`, points: p as number, requested: p as number,
      })),
    );
    await db().collection('study_days').insertMany(
      [a, b, e, d].map(s => ({ userId: s.id, day: LAST, week: LAST, studied: true, quizzesCompleted: 1, correctAnswers: 0, questionsAnswered: 5, points: 0 })),
    );
  });

  it('saves the top 10 of every board once', async () => {
    const first = await jobs().closeWeek(LAST);
    expect(first.saved).toBeGreaterThan(0);
    await jobs().closeWeek(LAST); // re-running changes nothing
    const winners = await db().collection('leaderboard_winners').find({ week: LAST, scopeType: 'all' }).sort({ rank: 1 }).toArray();
    expect(winners.map(w => [w.rank, w.username])).toEqual([
      [1, 'amaka'],
      [2, 'efe'],
      [3, 'bayo'],
      [4, 'dapo'],
    ]);
    const school = await db().collection('leaderboard_winners').find({ week: LAST, scopeType: 'school', scopeId: BENIN }).toArray();
    expect(school).toHaveLength(3);
  });

  it('marks last week’s #1 as the winner', async () => {
    const res = await board(b, { scope: 'school', period: 'last_week' });
    expect(res.entries[0]).toMatchObject({ username: 'amaka', is_winner: true });
    expect(res.entries[1].is_winner).toBe(false);
    expect(res.week_start).toBe(LAST);
  });

  it('tells every ranked student their school rank (unless muted)', async () => {
    const result = await jobs().sendWeeklyResults(LAST);
    expect(result.sent).toBe(3);
    const inbox = (await http().get(api('/notifications')).set(auth(b.token)).expect(200)).body;
    const items = Array.isArray(inbox) ? inbox : inbox.items;
    expect(items.find((n: any) => n.type === 'leaderboard_weekly')).toMatchObject({ data: { rank: 2, week: LAST } });
    expect(await db().collection('notifications').countDocuments({ userId: d.id, type: 'leaderboard_weekly' })).toBe(0);
  });

  it('lists your own rank for the last weeks', async () => {
    const res = (await http().get(api('/leaderboard/history')).query({ weeks: 3 }).set(auth(a.token)).expect(200)).body;
    expect(res.weeks).toHaveLength(3);
    expect(res.weeks[1]).toMatchObject({ week_start: LAST, rank: 1, points: 300, scope: 'school' });
  });
});

describe('notifications and anti-cheat', () => {
  it('tells a top-10 student when someone passes them, once a day', async () => {
    const g = await join('gbenga');
    const h = await join('hauwa');
    await row(h, 1000, { activeDays: 6 });
    await row(g, 1010, { activeDays: 6 });
    await db().collection('notifications').deleteMany({ type: 'leaderboard_overtaken' });
    await jobs().notifyOvertaken({ userId: String(g.id), week: WEEK, day: lagosDay(new Date()), points: 20 });
    expect(await db().collection('notifications').findOne({ userId: h.id, type: 'leaderboard_overtaken' })).toMatchObject({ fromId: g.id });
    await jobs().notifyOvertaken({ userId: String(g.id), week: WEEK, day: lagosDay(new Date()), points: 20 });
    expect(await db().collection('notifications').countDocuments({ userId: h.id, type: 'leaderboard_overtaken' })).toBe(1);
  });

  it('flags point bursts and near-perfect volume for review', async () => {
    const day = lagosDay(new Date());
    await db().collection('points_ledger').insertOne({ userId: a.id, occurredAt: new Date(), day, week: WEEK, sourceType: 'adjustment', sourceId: 'burst', points: 350, requested: 350 });
    await db().collection('study_days').updateOne({ userId: a.id, day }, { $set: { week: WEEK, questionsAnswered: 220, correctAnswers: 215, studied: true } }, { upsert: true });
    await jobs().checkAnomalies({ userId: String(a.id), week: WEEK, day, points: 10 });
    const kinds = (await db().collection('integrity_flags').find({ userId: a.id }).toArray()).map(f => f.kind).sort();
    expect(kinds).toEqual(['high_accuracy', 'points_burst']);
  });

  it('flags 3+ accounts from one network in the same school top 20', async () => {
    const topic = await db().collection('topics').findOne({ status: 'published' });
    for (const s of [a, b, c]) {
      await db().collection('quizattempts').insertOne({
        studentId: s.id, topicId: topic!._id, courseId: topic!.courseId, topicTitle: 't', courseTitle: 'c', startedAt: new Date(Date.now() - 600_000),
        submittedAt: new Date(), total: 1, correctCount: 1, answeredCount: 1, score: 100, answers: [], ipHash: 'same-network', scoredAt: new Date(),
      });
    }
    const res = await jobs().checkSharedNetworks(WEEK);
    expect(res.flagged).toBe(1);
    const flag = await db().collection('integrity_flags').findOne({ kind: 'shared_network' });
    expect(flag!.detail.usernames.sort()).toEqual(['amaka', 'bayo', 'chioma']);
  });

  it('never stores the raw network address of a quiz', async () => {
    const attempt = await db().collection('quizattempts').findOne({ studentId: d.id, ipHash: { $exists: true } });
    expect(attempt!.ipHash).toMatch(/^[a-f0-9]{24}$/);
    expect(JSON.stringify(attempt)).not.toMatch(/127\.0\.0\.1|::1|::ffff/);
  });
});

describe('admin', () => {
  const PASSWORD = 'Staff!2345';
  let admin: string;
  let creator: string;
  const as = (token: string) => ({
    get: (p: string) => http().get(api(p)).set(auth(token)),
    post: (p: string, body?: object) => http().post(api(p)).set(auth(token)).send(body),
    patch: (p: string, body: object) => http().patch(api(p)).set(auth(token)).send(body),
    put: (p: string, body: object) => http().put(api(p)).set(auth(token)).send(body),
  });

  beforeAll(async () => {
    await server.createStaff('admin@lb.test', 'admin', PASSWORD, 'Ada Admin');
    await server.createStaff('creator@lb.test', 'creator', PASSWORD, 'Chidi Creator');
    admin = (await http().post(api('/auth/login')).send({ email: 'admin@lb.test', password: PASSWORD }).expect(201)).body.accessToken;
    creator = (await http().post(api('/auth/login')).send({ email: 'creator@lb.test', password: PASSWORD }).expect(201)).body.accessToken;
  });

  it('only admins manage leaderboards', async () => {
    await as(creator).get('/admin/leaderboards/flags').expect(403);
    await as(creator).get('/admin/settings').expect(403);
    await as(creator).patch(`/admin/students/${a.id}/leaderboard`, { excluded: true, reason: 'x' }).expect(403);
  });

  it('searches the board by username, with names for prizes', async () => {
    const res = (await as(admin).get('/admin/leaderboards').query({ q: 'am' }).expect(200)).body;
    expect(res.entries.map((x: any) => x.username)).toEqual(['amaka']);
    expect(res.entries[0]).toMatchObject({ name: 'Real Name', excluded: false });
  });

  it('excludes a student (with a reason) and returns them, in the Activity log', async () => {
    await as(admin).patch(`/admin/students/${a.id}/leaderboard`, { excluded: true }).expect(400);
    await as(admin).patch(`/admin/students/${a.id}/leaderboard`, { excluded: true, reason: 'Answer sharing' }).expect(200);
    expect((await board(b, { scope: 'school' })).entries.map((x: any) => x.username)).not.toContain('amaka');
    expect((await board(a, { scope: 'school' })).me.hidden).toBe(true);
    await as(admin).patch(`/admin/students/${a.id}/leaderboard`, { excluded: false }).expect(200);
    expect((await board(b, { scope: 'school' })).entries.map((x: any) => x.username)).toContain('amaka');
    expect(await db().collection('auditentries').findOne({ action: 'leaderboard_excluded' })).toMatchObject({ summary: expect.stringContaining('Answer sharing') });
  });

  it('resets a student’s week to 0 with a ledger adjustment', async () => {
    await db().collection('points_ledger').insertOne({ userId: c.id, occurredAt: new Date(), day: lagosDay(new Date()), week: WEEK, sourceType: 'quiz_answers', sourceId: 'c-quiz', points: 100, requested: 100 });
    await db().collection('study_days').updateOne({ userId: c.id, day: lagosDay(new Date()) }, { $set: { week: WEEK, studied: true } }, { upsert: true });
    const res = (await as(admin).post(`/admin/students/${c.id}/leaderboard/reset`, { reason: 'Shared device' }).expect(201)).body;
    expect(res.removed).toBe(100);
    const rowAfter = await db().collection('leaderboard_weeks').findOne({ week: WEEK, studentId: c.id });
    expect(rowAfter!.points).toBe(0);
    expect(await db().collection('points_ledger').findOne({ userId: c.id, sourceType: 'adjustment' })).toMatchObject({ points: -100 });
  });

  it('works the flags queue', async () => {
    const flags = (await as(admin).get('/admin/leaderboards/flags').expect(200)).body;
    const burst = flags.find((f: any) => f.kind === 'points_burst');
    expect(burst.student).toMatchObject({ username: 'amaka' });
    await as(admin).post(`/admin/leaderboards/flags/${burst.id}`, { action: 'dismiss', reason: 'Exam week' }).expect(201);
    await as(admin).post(`/admin/leaderboards/flags/${burst.id}`, { action: 'dismiss' }).expect(400);
    const closed = (await as(admin).get('/admin/leaderboards/flags').query({ status: 'closed' }).expect(200)).body;
    expect(closed.find((f: any) => f.id === burst.id)).toMatchObject({ status: 'dismissed', resolution: { action: 'dismiss', by: 'Ada Admin' } });
  });

  it('changes points values within safe ranges, and new quizzes use them', async () => {
    await as(admin).put('/admin/settings', { points: { correctAnswer: 9999 } }).expect(400);
    await as(admin).put('/admin/settings', { points: { nonsense: 1 } }).expect(400);
    const res = (await as(admin).put('/admin/settings', { points: { correctAnswer: 12 }, leaderboard: { minActiveStudents: 3 } }).expect(200)).body;
    expect(res.points.correctAnswer).toBe(12);
    expect(res.defaults.points.correctAnswer).toBe(10);
    const schools = (await http().get(api('/leaderboard/schools')).set(auth(a.token)).expect(200)).body;
    expect(schools.min_active_students).toBe(3);
    await as(admin).put('/admin/settings', { points: { correctAnswer: 10 }, leaderboard: { minActiveStudents: 5 } }).expect(200);
  });

  it('lists saved winners and insights', async () => {
    const winners = (await as(admin).get('/admin/leaderboards/saved-winners').query({ week: LAST, scope: 'all' }).expect(200)).body;
    expect(winners.winners[0]).toMatchObject({ rank: 1, username: 'amaka', student: { name: 'Real Name' } });
    const insights = (await as(admin).get('/admin/leaderboards/insights').expect(200)).body;
    expect(insights[0]).toMatchObject({ week: LAST, onBoard: expect.any(Number) });
  });
});
