import request from 'supertest';
import { Types } from 'mongoose';
import { seedSampleContent } from '../src/seed/seed-sample-content';
import { ReferralsService } from '../src/social/referrals.service';
import { StudyService } from '../src/study/study.service';
import { weekOf } from '../src/leaderboard/week';
import { startInMemoryApp } from './support/in-memory-app';

/**
 * Referral rewards: +10 to the inviter once the invited student completes a
 * first quiz (once ever), 5 a week on the leaderboard, held clusters,
 * admin approve / reject / reverse, the back-fill — on a real (in-memory,
 * replica-set) MongoDB.
 */

jest.setTimeout(180_000);

let server: Awaited<ReturnType<typeof startInMemoryApp>>;
const http = () => request(server.app.getHttpServer());
const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const db = () => server.connection;
const users = () => db().collection('users');
const ledger = () => db().collection('points_ledger');

let seq = 0;
let topics: any[];

/**
 * A verified student. Tests all run from 127.0.0.1, so the shared network is
 * forgotten after sign-up unless `keepNetwork` (the cluster tests).
 */
async function join(opts: { code?: string; installId?: string; keepNetwork?: boolean } = {}) {
  const username = `r${++seq}_${Date.now() % 100000}`;
  const email = `${username}@uni.edu`;
  await http()
    .post(api('/auth/signup'))
    .send({
      firstName: 'Bola', lastName: 'Ade', username, email, password: 'Str0ng!Pass', userType: 'STUDENT',
      studentProfile: { institution: 'University of Lagos', faculty: 'Faculty of Basic Medical Sciences', department: 'Physiology', levelType: 'Undergraduate', level: '200 Level' },
      ...(opts.code ? { referralCode: opts.code } : {}),
    })
    .expect(201);
  const verify = http().post(api('/auth/verify'));
  if (opts.installId) verify.set('X-Install-Id', opts.installId);
  const res = await verify.send({ email, code: server.mail.lastCode(email) }).expect(201);
  if (!opts.keepNetwork) await users().updateOne({ email }, { $unset: { signupNetwork: 1 } });
  const user = await users().findOne({ email });
  return { token: res.body.accessToken as string, id: user!._id as Types.ObjectId, username };
}

const questionsOf = (topic: any) => db().collection('questions').find({ topicId: topic._id, status: 'published' }).sort({ _id: 1 }).toArray();

/** A completed quiz (all questions answered, 20 s each). */
async function quiz(token: string, topic = topics[0], right = 3) {
  const qs = await questionsOf(topic);
  const answers = qs.map((q, i) => ({ questionId: String(q._id), selectedIndex: i < right ? q.answerIndex : (q.answerIndex + 1) % q.options.length }));
  return http()
    .post(api('/quiz-attempts'))
    .set(auth(token))
    .send({ topicId: String(topic._id), startedAt: new Date(Date.now() - 10 * 60_000 - seq * 1000).toISOString(), answers })
    .expect(201);
}

const mine = async (token: string) => (await http().get(api('/me/referrals')).set(auth(token)).expect(200)).body;
const weekPoints = async (id: Types.ObjectId) =>
  (await db().collection('leaderboard_weeks').findOne({ week: weekOf(new Date()), studentId: id }))?.points ?? 0;

beforeAll(async () => {
  server = await startInMemoryApp();
  await seedSampleContent(server.connection);
  topics = await db().collection('topics').find({ status: 'published' }).sort({ _id: 1 }).toArray();
});

afterAll(async () => {
  await server?.stop();
});

describe('referral rewards', () => {
  it('pending at sign-up; +10 to the inviter on the first completed quiz; never twice', async () => {
    const inviter = await join();
    const friend = await join({ code: inviter.username, installId: 'phone-friend-1' });

    expect(await mine(inviter.token)).toMatchObject({ joined: 1, pending: 1, rewarded: 0, pointsEarned: 0, rewardPoints: 10 });
    expect((await mine(inviter.token)).recent[0]).toMatchObject({ username: friend.username, status: 'pending' });
    // Hashes only — never the raw install id.
    const stored = await users().findOne({ _id: friend.id });
    expect(stored!.signupInstall).toMatch(/^[0-9a-f]{24}$/);
    expect(JSON.stringify(stored)).not.toContain('phone-friend-1');

    // A quiz with too few answers doesn't count yet.
    const qs = await questionsOf(topics[1]);
    await http()
      .post(api('/quiz-attempts'))
      .set(auth(friend.token))
      .send({ topicId: String(topics[1]._id), startedAt: new Date(Date.now() - 5 * 60_000).toISOString(), answers: qs.map((q, i) => ({ questionId: String(q._id), selectedIndex: i < 2 ? q.answerIndex : null })) })
      .expect(201);
    expect((await mine(inviter.token)).pointsEarned).toBe(0);

    await quiz(friend.token);
    await quiz(friend.token, topics[2]);
    const after = await mine(inviter.token);
    expect(after).toMatchObject({ joined: 1, pending: 0, rewarded: 1, pointsEarned: 10 });
    expect(after.recent[0]).toMatchObject({ username: friend.username, status: 'rewarded' });
    expect(after.lifetimePoints).toBe(10);
    expect(await weekPoints(inviter.id)).toBe(10);
    expect(await ledger().countDocuments({ sourceType: 'referral', sourceId: String(friend.id) })).toBe(1);

    const inbox = (await http().get(api('/notifications')).set(auth(inviter.token)).expect(200)).body;
    expect(inbox[0]).toMatchObject({ type: 'referral_rewarded', username: friend.username, data: { points: 10 } });
    // The inviter's own profile never carries review state or hashes.
    const profile = (await http().get(api('/auth/profile')).set(auth(friend.token)).expect(200)).body;
    for (const key of ['referral', 'signupNetwork', 'signupInstall', 'referredBy']) expect(profile).not.toHaveProperty(key);
  });

  it('a retry or a too-fast quiz never earns the reward', async () => {
    const inviter = await join();
    const friend = await join({ code: inviter.username, installId: 'phone-fast' });
    const qs = await questionsOf(topics[0]);
    const answers = qs.map(q => ({ questionId: String(q._id), selectedIndex: q.answerIndex }));
    await http().post(api('/quiz-attempts')).set(auth(friend.token)).send({ topicId: String(topics[0]._id), startedAt: new Date(Date.now() - 3000).toISOString(), answers }).expect(201);
    await http().post(api('/quiz-attempts')).set(auth(friend.token)).send({ topicId: String(topics[0]._id), startedAt: new Date(Date.now() - 600_000).toISOString(), answers, retry: true }).expect(201);
    expect(await mine(inviter.token)).toMatchObject({ pending: 1, pointsEarned: 0 });
  });

  it('only 5 referral rewards a week count on the leaderboard; all count as lifetime points', async () => {
    const inviter = await join();
    const friends = [];
    for (let i = 0; i < 6; i++) friends.push(await join({ code: inviter.username, installId: `cap-phone-${i}` }));
    for (const f of friends) await quiz(f.token);
    expect(await mine(inviter.token)).toMatchObject({ rewarded: 6, pointsEarned: 60, lifetimePoints: 60 });
    expect(await weekPoints(inviter.id)).toBe(50);
    expect(await ledger().countDocuments({ userId: inviter.id, sourceType: 'referral', leaderboard: false })).toBe(1);

    // The nightly recount agrees.
    await server.app.get(StudyService).reconcileWeek(weekOf(new Date()));
    expect(await weekPoints(inviter.id)).toBe(50);
  });

  it('holds sign-ups from one phone for review; admins approve, reject or reverse (with an audit entry)', async () => {
    const inviter = await join();
    const a = await join({ code: inviter.username, installId: 'one-phone' });
    const b = await join({ code: inviter.username, installId: 'one-phone' });
    expect((await users().findOne({ _id: a.id }))!.referral.status).toBe('held');
    expect((await users().findOne({ _id: b.id }))!.referral.status).toBe('held');
    expect(await db().collection('integrity_flags').countDocuments({ kind: 'referral_cluster', userId: inviter.id })).toBe(1);

    await quiz(a.token);
    await quiz(b.token);
    // Held: shown to the inviter as pending, no points.
    expect(await mine(inviter.token)).toMatchObject({ joined: 2, pending: 2, pointsEarned: 0 });

    await server.createStaff('admin@ref.test', 'admin', 'Staff!2345', 'Ada Admin');
    const admin = (await http().post(api('/auth/login')).send({ email: 'admin@ref.test', password: 'Staff!2345' }).expect(201)).body.accessToken;
    const as = (p: string, body: object) => http().post(api(p)).set(auth(admin)).send(body);

    const list = (await http().get(api(`/admin/referrals/students/${inviter.id}`)).set(auth(admin)).expect(200)).body;
    expect(list.referrals).toHaveLength(2);
    expect(list.referrals[0]).toMatchObject({ status: 'held', sharedInstall: true, quizzes: 1 });

    // Students can't do this.
    await http().post(api(`/admin/referrals/${a.id}/action`)).set(auth(inviter.token)).send({ action: 'approve' }).expect(403);

    expect((await as(`/admin/referrals/${a.id}/action`, { action: 'approve' }).expect(201)).body).toEqual({ status: 'rewarded' });
    await as(`/admin/referrals/${b.id}/action`, { action: 'reject' }).expect(400); // a reason is needed
    expect((await as(`/admin/referrals/${b.id}/action`, { action: 'reject', reason: 'Same phone as a' }).expect(201)).body).toEqual({ status: 'rejected' });
    expect(await mine(inviter.token)).toMatchObject({ rewarded: 1, pending: 0, pointsEarned: 10 });
    expect(await weekPoints(inviter.id)).toBe(10);

    // A duplicate account found later: the reward comes back off.
    expect((await as(`/admin/referrals/${a.id}/action`, { action: 'reverse', reason: 'Duplicate account' }).expect(201)).body).toEqual({ status: 'reversed' });
    expect(await mine(inviter.token)).toMatchObject({ rewarded: 0, pointsEarned: 0 });
    expect(await weekPoints(inviter.id)).toBe(0);
    expect(await db().collection('auditentries').countDocuments({ action: { $in: ['referral_approve', 'referral_reject', 'referral_reverse'] } })).toBe(3);
  });

  it('banning an invited student takes the reward back', async () => {
    const inviter = await join();
    const friend = await join({ code: inviter.username, installId: 'ban-phone' });
    await quiz(friend.token);
    expect((await mine(inviter.token)).pointsEarned).toBe(10);
    await server.app.get(ReferralsService).reverse(friend.id, 'Invited account banned', 'Moderator');
    await server.app.get(ReferralsService).reverse(friend.id, 'Invited account banned', 'Moderator'); // twice is fine
    expect((await mine(inviter.token)).pointsEarned).toBe(0);
    expect(await weekPoints(inviter.id)).toBe(0);
  });

  it('blocks self-referral from the same phone, and the rebuild keeps rewards', async () => {
    const inviter = await join({ installId: 'my-own-phone' });
    const alt = await join({ code: inviter.username, installId: 'my-own-phone' });
    expect((await users().findOne({ _id: alt.id }))!.referredBy).toBeUndefined();

    const friend = await join({ code: inviter.username, installId: 'friend-rebuild' });
    await quiz(friend.token);
    await server.app.get(StudyService).rebuildAll();
    expect(await mine(inviter.token)).toMatchObject({ rewarded: 1, pointsEarned: 10 });
    expect(await ledger().countDocuments({ sourceType: 'referral', sourceId: String(friend.id) })).toBe(1);
  });

  it('back-fills referrals from before rewards as lifetime points only, once', async () => {
    const inviter = await join();
    const old = await join({ code: inviter.username, installId: 'old-friend' });
    const notYet = await join({ code: inviter.username, installId: 'old-friend-2' });
    await quiz(old.token);
    // Pretend both referrals predate the feature (no reward, no status).
    await ledger().deleteMany({ sourceId: String(old.id) });
    await users().updateMany({ _id: { $in: [old.id, notYet.id] } }, { $unset: { referral: 1 } });
    await server.app.get(StudyService).reconcileWeek(weekOf(new Date()));

    const service = server.app.get(ReferralsService);
    expect(await service.backfill()).toEqual({ checked: 2, rewarded: 1 });
    expect(await service.backfill()).toEqual({ checked: 0, rewarded: 0 });
    expect(await mine(inviter.token)).toMatchObject({ rewarded: 1, pending: 1, pointsEarned: 10, lifetimePoints: 10 });
    expect(await weekPoints(inviter.id)).toBe(0);
  });
});
