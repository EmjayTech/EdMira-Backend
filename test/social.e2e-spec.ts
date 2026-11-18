import request from 'supertest';
import { Types } from 'mongoose';
import { seedSampleContent } from '../src/seed/seed-sample-content';
import { FakeEmailService, startInMemoryApp } from './support/in-memory-app';

/**
 * Find classmates, connection requests, block & report, moderation.
 * Safety-critical: authorisation (incl. IDOR attempts), limits, silent
 * declines and blocks, privacy settings, and that nothing personal leaks.
 */

jest.setTimeout(120_000);

let server: Awaited<ReturnType<typeof startInMemoryApp>>;
let http: () => ReturnType<typeof request>;
let mail: FakeEmailService;

const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const PASSWORD = 'Str0ng!Pass';

const profile = (institution = 'University of Lagos') => ({
  institution,
  faculty: 'Faculty of Clinical Sciences',
  department: 'Medicine & Surgery (MBBS)',
  levelType: 'Undergraduate',
  level: '300 Level',
});

let phoneSeq = 0;
/** Sign up + verify a student (each with their own phone number); returns their access token. */
async function student(username: string, institution?: string, extra: Record<string, unknown> = {}) {
  const email = `${username.replace(/\W/g, '')}@uni.edu`;
  const phoneNumber = `80${String(10_000_000 + ++phoneSeq)}`;
  await http()
    .post(api('/auth/signup'))
    .send({ firstName: 'Real', lastName: 'Name', username, email, password: PASSWORD, userType: 'STUDENT', phoneNumber, countryCode: '+234', studentProfile: profile(institution), ...extra })
    .expect(201);
  const res = await http().post(api('/auth/verify')).send({ email, code: mail.lastCode(email) }).expect(201);
  return res.body.accessToken as string;
}

/** Make an account look older than 24 h (new accounts get stricter limits). */
const age = (username: string) =>
  server.connection.collection('users').updateOne({ usernameLower: username.toLowerCase() }, { $set: { createdAt: new Date(Date.now() - 3 * 86_400_000) } });

const as = (token: string) => ({
  get: (path: string, query?: object) => http().get(api(path)).query(query ?? {}).set(auth(token)),
  post: (path: string, body?: object) => http().post(api(path)).set(auth(token)).send(body ?? {}),
  patch: (path: string, body: object) => http().patch(api(path)).set(auth(token)).send(body),
  delete: (path: string) => http().delete(api(path)).set(auth(token)),
});

/** Nothing any student sees about another may contain these. */
const assertNoPersonalData = (body: unknown) => {
  const json = JSON.stringify(body);
  for (const secret of ['@uni.edu', 'Real', '8010000', 'requesterId', 'recipientId', 'studentId', 'challengerId', 'opponentId', 'referredBy', '"_id"']) {
    expect(json).not.toContain(secret);
  }
};

let ada: string, bola: string, chi: string, dayo: string, efe: string, fola: string, admin: string;

beforeAll(async () => {
  server = await startInMemoryApp();
  mail = server.mail;
  http = () => request(server.app.getHttpServer());
  await seedSampleContent(server.connection);
  ada = await student('ada_med');
  bola = await student('bola.k');
  chi = await student('chi_x');
  dayo = await student('dayo_01');
  efe = await student('efe_s');
  fola = await student('fola_ui', 'University of Ibadan');
  for (const u of ['ada_med', 'bola.k', 'chi_x', 'dayo_01', 'efe_s', 'fola_ui']) await age(u);
  await server.createStaff('moderator1@edmira.com', 'admin', 'Staff!2345', 'Mo Moderator');
  admin = (await http().post(api('/auth/login')).send({ email: 'moderator1@edmira.com', password: 'Staff!2345' }).expect(201)).body.accessToken;
});

afterAll(async () => {
  await server?.stop();
});

describe('search', () => {
  it('needs a login and 3+ characters', async () => {
    await http().get(api('/people/search')).query({ q: 'ada' }).expect(401);
    const short = await as(bola).get('/people/search', { q: 'ad' }).expect(400);
    expect(short.body.code).toBe('QUERY_TOO_SHORT');
  });

  it('finds by username prefix with public details only, never yourself', async () => {
    const res = await as(bola).get('/people/search', { q: 'ADA' }).expect(200);
    expect(res.body).toEqual([
      { username: 'ada_med', initials: 'AD', school: 'UNILAG', level: '300 Level', badge: null, avatar: { preset: null, url: null }, connection: { status: 'none' } },
    ]);
    assertNoPersonalData(res.body);
    expect((await as(ada).get('/people/search', { q: 'ada' }).expect(200)).body).toEqual([]);
  });

  it('respects "Who can find me": exact username only, or nobody', async () => {
    await as(chi).patch('/auth/privacy', { findability: 'exact' }).expect(200);
    expect((await as(bola).get('/people/search', { q: 'chi' }).expect(200)).body).toEqual([]);
    expect((await as(bola).get('/people/search', { q: 'chi_x' }).expect(200)).body.map((p: any) => p.username)).toEqual(['chi_x']);

    await as(chi).patch('/auth/privacy', { findability: 'nobody' }).expect(200);
    expect((await as(bola).get('/people/search', { q: 'chi_x' }).expect(200)).body).toEqual([]);
    // Same 404 as an account that doesn't exist.
    const hidden = await as(bola).get('/people/chi_x').expect(404);
    const missing = await as(bola).get('/people/no_such_kid').expect(404);
    expect(hidden.body).toEqual(missing.body);
    // A request to a hidden student creates nothing and says the same as always.
    expect((await as(bola).post('/connections', { username: 'chi_x' }).expect(202)).body).toEqual({ ok: true });
    expect((await as(bola).get('/connections/requests').expect(200)).body.outgoing).toEqual([]);
    await as(chi).patch('/auth/privacy', { findability: 'everyone' }).expect(200);
  });

  it('shows staff only for the exact username, with the EdMira team badge, and they can’t connect', async () => {
    expect((await as(bola).get('/people/search', { q: 'moder' }).expect(200)).body).toEqual([]);
    const exact = (await as(bola).get('/people/search', { q: 'Moderator1' }).expect(200)).body;
    expect(exact).toEqual([expect.objectContaining({ username: 'moderator1', badge: 'edmira_team', school: '', level: '' })]);
    const card = (await as(bola).get('/people/moderator1').expect(200)).body;
    expect(card).toMatchObject({ badge: 'edmira_team', canConnect: false });
    await as(bola).post('/connections', { username: 'moderator1' }).expect(202);
    expect((await as(bola).get('/connections/requests').expect(200)).body.outgoing).toEqual([]);
  });

  it('limits searches to 30 a minute per student, and logs it', async () => {
    for (let i = 0; i < 30; i++) await as(dayo).get('/people/search', { q: 'zzz' }).expect(200);
    const limited = await as(dayo).get('/people/search', { q: 'zzz' }).expect(429);
    expect(limited.body.code).toBe('SEARCH_LIMIT');
    const events = await server.connection.collection('security_events').find({ type: 'search_rate_limited' }).toArray();
    expect(events).toHaveLength(1);
  });
});

describe('connection requests', () => {
  let requestId: string;

  it('sends a request with a preset note; only the recipient is told', async () => {
    expect((await as(ada).post('/connections', { username: 'BOLA.K', note: 'classmates' }).expect(202)).body).toEqual({ ok: true });
    await as(ada).post('/connections', { username: 'bola.k', note: 'Hi, give me your number' }).expect(400); // no free text

    const bolaRequests = (await as(bola).get('/connections/requests').expect(200)).body;
    expect(bolaRequests.incoming).toEqual([
      expect.objectContaining({ username: 'ada_med', school: 'UNILAG', note: 'classmates', id: expect.any(String) }),
    ]);
    assertNoPersonalData(bolaRequests);
    requestId = bolaRequests.incoming[0].id;
    expect((await as(ada).get('/connections/requests').expect(200)).body.outgoing.map((r: any) => r.username)).toEqual(['bola.k']);

    const inbox = (await as(bola).get('/notifications').expect(200)).body;
    expect(inbox[0]).toMatchObject({ type: 'connection_request', username: 'ada_med', read: false });
    expect((await as(bola).get('/me/social-summary').expect(200)).body).toEqual({ incomingRequests: 1, unreadNotifications: 1 });
    await as(bola).post('/notifications/read-all').expect(204);
    expect((await as(bola).get('/me/social-summary').expect(200)).body.unreadNotifications).toBe(0);
  });

  it('refuses anyone else touching the request (IDOR) — and the sender accepting their own', async () => {
    for (const action of ['accept', 'decline', 'cancel']) {
      await as(chi).post(`/connections/${requestId}/${action}`).expect(404);
    }
    await as(chi).delete(`/connections/${requestId}`).expect(404);
    await as(chi).post(`/connections/${new Types.ObjectId()}/accept`).expect(404);
    expect((await as(ada).post(`/connections/${requestId}/accept`).expect(409)).body.code).toBe('NOT_OPEN');
    await as(bola).post(`/connections/${requestId}/cancel`).expect(409); // only the sender cancels
  });

  it('connects on accept, notifies the sender, and shares progress per each person’s settings', async () => {
    expect((await as(bola).post(`/connections/${requestId}/accept`).expect(200)).body).toEqual({ id: requestId, status: 'accepted' });
    expect((await as(ada).get('/connections').expect(200)).body).toEqual([expect.objectContaining({ username: 'bola.k', id: requestId })]);
    expect((await as(bola).get('/connections').expect(200)).body.map((c: any) => c.username)).toEqual(['ada_med']);
    expect((await as(ada).get('/notifications').expect(200)).body[0]).toMatchObject({ type: 'connection_accepted', username: 'bola.k' });

    const card = (await as(ada).get('/people/bola.k').expect(200)).body;
    expect(card.connection).toEqual({ status: 'connected', id: requestId });
    expect(card.progress).toMatchObject({ streakDays: 0, topicsPractised: 0, averageScore: null }); // scores hidden by default
    assertNoPersonalData(card);

    await as(bola).patch('/auth/privacy', { shareProgress: false }).expect(200);
    expect((await as(ada).get('/people/bola.k').expect(200)).body.progress).toBeNull();
    // A non-connection never sees progress.
    expect((await as(chi).get('/people/bola.k').expect(200)).body.progress).toBeNull();
    await as(bola).patch('/auth/privacy', { shareProgress: true }).expect(200);
  });

  it('declines silently, with a 30-day cooldown the sender can’t see', async () => {
    await as(dayo).post('/connections', { username: 'efe_s' }).expect(202);
    const incoming = (await as(efe).get('/connections/requests').expect(200)).body.incoming;
    await as(efe).post(`/connections/${incoming[0].id}/decline`).expect(200);
    // Dayo isn't told: the request just disappears, no notification.
    expect((await as(dayo).get('/connections/requests').expect(200)).body.outgoing).toEqual([]);
    expect((await as(dayo).get('/notifications').expect(200)).body).toEqual([]);

    // Re-requesting within 30 days looks normal to Dayo but never reaches Efe.
    await as(dayo).post('/connections', { username: 'efe_s' }).expect(202);
    expect((await as(dayo).get('/connections/requests').expect(200)).body.outgoing.map((r: any) => r.username)).toEqual(['efe_s']);
    expect((await as(efe).get('/connections/requests').expect(200)).body.incoming).toEqual([]);
    const efeInbox = (await as(efe).get('/notifications').expect(200)).body;
    expect(efeInbox.filter((n: any) => n.username === 'dayo_01')).toHaveLength(1); // only the first request
    // Efe can't act on the silent request either.
    const silentId = (await as(dayo).get('/connections/requests').expect(200)).body.outgoing[0].id;
    await as(efe).post(`/connections/${silentId}/accept`).expect(404);
  });

  it('respects "Who can send me requests"', async () => {
    await as(efe).patch('/auth/privacy', { requestsFrom: 'school' }).expect(200);
    await as(fola).post('/connections', { username: 'efe_s' }).expect(202); // different school
    expect((await as(efe).get('/connections/requests').expect(200)).body.incoming).toEqual([]);
    await as(efe).patch('/auth/privacy', { requestsFrom: 'everyone' }).expect(200);
  });

  it('expires requests after 14 days', async () => {
    await as(chi).post('/connections', { username: 'fola_ui' }).expect(202);
    await server.connection.collection('connections').updateOne({ status: 'pending', shadow: false }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const incoming = (await as(fola).get('/connections/requests').expect(200)).body.incoming;
    expect(incoming).toEqual([]);
    const row = await server.connection.collection('connections').findOne({ status: 'expired' });
    expect(row).toBeTruthy();
    await as(fola).post(`/connections/${row!._id}/accept`).expect(409);
  });

  it('removes a connection silently, from either side', async () => {
    await as(efe).post('/connections', { username: 'chi_x' }).expect(202);
    const id = (await as(chi).get('/connections/requests').expect(200)).body.incoming[0].id;
    await as(chi).post(`/connections/${id}/accept`).expect(200);
    await as(efe).delete(`/connections/${id}`).expect(200);
    expect((await as(chi).get('/connections').expect(200)).body).toEqual([]);
    await as(chi).delete(`/connections/${id}`).expect(409);
  });

  it('limits accounts under 24 hours old to 5 requests a day', async () => {
    const newbie = await student('newbie_1');
    const targets = ['ada_med', 'bola.k', 'chi_x', 'dayo_01', 'efe_s', 'fola_ui'];
    for (const t of targets.slice(0, 5)) await as(newbie).post('/connections', { username: t }).expect(202);
    const limited = await as(newbie).post('/connections', { username: targets[5] }).expect(429);
    expect(limited.body.code).toBe('REQUEST_LIMIT');
  });
});

describe('block & report', () => {
  it('blocks instantly and silently: connection gone, hidden both ways, notifications cleared', async () => {
    expect((await as(ada).post('/blocks', { username: 'bola.k' }).expect(200)).body).toEqual({ ok: true });
    expect((await as(ada).get('/connections').expect(200)).body).toEqual([]);
    expect((await as(bola).get('/connections').expect(200)).body).toEqual([]);
    // Hidden from each other — exactly like a missing account.
    expect((await as(bola).get('/people/search', { q: 'ada' }).expect(200)).body).toEqual([]);
    expect((await as(ada).get('/people/search', { q: 'bola' }).expect(200)).body).toEqual([]);
    await as(bola).get('/people/ada_med').expect(404);
    await as(bola).post('/connections', { username: 'ada_med' }).expect(202);
    const adaIncoming = (await as(ada).get('/connections/requests').expect(200)).body.incoming;
    expect(adaIncoming.map((r: any) => r.username)).not.toContain('bola.k');
    expect((await as(ada).get('/notifications').expect(200)).body.some((n: any) => n.username === 'bola.k')).toBe(false);
    expect((await as(ada).get('/blocks').expect(200)).body).toEqual([expect.objectContaining({ username: 'bola.k' })]);
  });

  it('unblocks (without reconnecting)', async () => {
    await as(ada).delete('/blocks/bola.k').expect(200);
    expect((await as(ada).get('/blocks').expect(200)).body).toEqual([]);
    expect((await as(bola).get('/people/ada_med').expect(200)).body.connection).toEqual({ status: 'none' });
  });

  it('files a report with evidence for moderators, optionally blocking too', async () => {
    await as(efe).post('/reports/users', { username: 'dayo_01', category: 'harassment', note: 'Keeps re-requesting', block: true }).expect(200);
    await as(efe).post('/reports/users', { username: 'dayo_01', category: 'nonsense' }).expect(400);
    expect((await as(efe).post('/reports/users', { username: 'ghost_000', category: 'spam' }).expect(200)).body).toEqual({ ok: true });

    await as(bola).get('/admin/moderation/reports').expect(403); // students can't
    const queue = (await as(admin).get('/admin/moderation/reports').expect(200)).body;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      category: 'harassment',
      note: 'Keeps re-requesting',
      reporter: { username: 'efe_s' },
      reported: { username: 'dayo_01', email: 'dayo_01@uni.edu' }, // admins see who it is
      evidence: { reportedUsername: 'dayo_01', recentRequests: expect.arrayContaining([expect.objectContaining({ from: 'dayo_01', status: 'declined' })]) },
    });
    expect((await as(efe).get('/blocks').expect(200)).body.map((b: any) => b.username)).toEqual(['dayo_01']);
  });

  it('lets moderators warn, rename, suspend for N days and ban — each audit-logged', async () => {
    let current = 'chi_x';
    const report = async (category = 'spam') => {
      await as(fola).post('/reports/users', { username: current, category }).expect(200);
      const open = (await as(admin).get('/admin/moderation/reports').expect(200)).body;
      return open.find((r: any) => r.reported.username === current).id as string;
    };

    await as(admin).post(`/admin/moderation/reports/${await report()}/action`, { action: 'warn' }).expect(201);
    expect((await as(chi).get('/notifications').expect(200)).body[0]).toMatchObject({ type: 'account_warning' });

    await as(admin).post(`/admin/moderation/reports/${await report('inappropriate_username')}/action`, { action: 'rename', username: 'student_4821' }).expect(201);
    await http().post(api('/auth/login')).send({ identifier: 'student_4821', password: PASSWORD }).expect(201);
    current = 'student_4821';

    await as(admin).post(`/admin/moderation/reports/${await report()}/action`, { action: 'suspend', days: 0 }).expect(400);
    const id = await report();
    await as(admin).post(`/admin/moderation/reports/${id}/action`, { action: 'suspend', days: 3 }).expect(201);
    const blocked = await http().post(api('/auth/login')).send({ identifier: 'student_4821', password: PASSWORD }).expect(403);
    expect(blocked.body.message).toMatch(/suspended until/);
    await as(chi).get('/connections').expect(401); // live token stops at once
    expect((await as(bola).get('/people/search', { q: 'student_48' }).expect(200)).body).toEqual([]); // hidden while suspended
    await as(admin).post(`/admin/moderation/reports/${id}/action`, { action: 'dismiss' }).expect(400); // already handled

    // A timed suspension lifts itself once it ends.
    await server.connection.collection('users').updateOne({ usernameLower: 'student_4821' }, { $set: { suspendedUntil: new Date(Date.now() - 1000) } });
    chi = (await http().post(api('/auth/login')).send({ identifier: 'student_4821', password: PASSWORD }).expect(201)).body.accessToken;

    await as(admin).post(`/admin/moderation/reports/${await report('impersonation')}/action`, { action: 'ban' }).expect(201);
    expect((await http().post(api('/auth/login')).send({ identifier: 'student_4821', password: PASSWORD }).expect(403)).body.message).toMatch(/closed/);

    const audit = JSON.stringify((await as(admin).get('/admin/audit-log').expect(200)).body);
    for (const line of ['Warned @chi_x', 'Changed username @chi_x → @student_4821', 'Suspended @student_4821 for 3 days', 'Banned @student_4821']) {
      expect(audit).toContain(line);
    }
    const events = (await as(admin).get('/admin/moderation/security-events', { type: 'moderation_action' }).expect(200)).body;
    expect(events.length).toBeGreaterThanOrEqual(4);
  });

  it('auto-flags an account reported by 5 different students and pauses its requests until reviewed', async () => {
    const target = await student('flag_me');
    await age('flag_me');
    // One at a time: parallel requests to the in-process test server can drop a connection.
    const reporters: string[] = [];
    for (const u of ['rep_a', 'rep_b', 'rep_c', 'rep_d', 'rep_e']) reporters.push(await student(u));
    for (const r of reporters) await as(r).post('/reports/users', { username: 'flag_me', category: 'spam' }).expect(200);

    const flagged = (await as(admin).get('/admin/moderation/flagged').expect(200)).body;
    const entry = flagged.find((f: any) => f.username === 'flag_me');
    expect(entry.flag.reasons).toEqual(['reported by 5 students']);
    const paused = await as(target).post('/connections', { username: 'ada_med' }).expect(403);
    expect(paused.body.code).toBe('REQUESTS_PAUSED');

    await as(admin).post(`/admin/moderation/flagged/${entry.id}/clear`).expect(201);
    await as(target).post('/connections', { username: 'ada_med' }).expect(202);
  });
});

describe('invite links', () => {
  it('credits the inviter and sends their connection request — never connects automatically', async () => {
    const before = (await as(ada).get('/auth/profile').expect(200)).body;
    expect(before.referralCount).toBe(0);
    expect(before).not.toHaveProperty('referredBy');

    const newcomer = await student('new_kid', undefined, { referralCode: '@Ada_Med' });
    expect((await as(ada).get('/auth/profile').expect(200)).body.referralCount).toBe(1);
    expect((await as(ada).get('/me/referrals').expect(200)).body).toMatchObject({ count: 1, joined: 1, pending: 1, rewarded: 0, pointsEarned: 0 });

    const requests = (await as(newcomer).get('/connections/requests').expect(200)).body;
    expect(requests.incoming.map((r: any) => r.username)).toEqual(['ada_med']);
    expect((await as(newcomer).get('/connections').expect(200)).body).toEqual([]);
    expect((await as(newcomer).get('/auth/profile').expect(200)).body).not.toHaveProperty('referredBy');
    assertNoPersonalData(requests);
  });

  it('ignores self-referrals, unknown or staff inviters, and the same phone number', async () => {
    await student('selfie_1', undefined, { referralCode: 'selfie_1' });
    await student('ghost_ref', undefined, { referralCode: 'nobody_here' });
    await student('staff_ref', undefined, { referralCode: 'moderator1' });
    const adaPhone = (await server.connection.collection('users').findOne({ usernameLower: 'ada_med' }))!.phone.number;
    await student('same_phone', undefined, { referralCode: 'ada_med', phoneNumber: adaPhone });
    expect((await as(ada).get('/me/referrals').expect(200)).body.count).toBe(1);
    expect(await server.connection.collection('users').countDocuments({ referredBy: { $exists: true } })).toBe(1);
  });

  it('shows the public invite page only what the inviter allows', async () => {
    expect((await http().get(api('/invites/ADA_MED')).expect(200)).body).toEqual({ username: 'ada_med', initials: 'AD', school: 'UNILAG', level: '300 Level' });
    await as(ada).patch('/auth/privacy', { findability: 'exact' }).expect(200);
    expect((await http().get(api('/invites/ada_med')).expect(200)).body).toEqual({ username: 'ada_med', initials: 'AD', school: '', level: '' });
    await as(ada).patch('/auth/privacy', { findability: 'everyone' }).expect(200);
    await http().get(api('/invites/moderator1')).expect(404);
    await http().get(api('/invites/nobody_here')).expect(404);
  });

  it('lets admins see referrals per student and per school', async () => {
    const report = (await as(admin).get('/admin/referrals').expect(200)).body;
    expect(report.total).toBe(1);
    expect(report.students[0]).toMatchObject({ username: 'ada_med', count: 1, school: 'UNILAG' });
    expect(report.schools[0]).toMatchObject({ school: 'UNILAG', count: 1, inviters: 1 });
  });
});

describe('challenge a friend', () => {
  let p1: string, p2: string, p3: string, topicId: string, challengeId: string;

  /** Answers for a challenge: the first `right` correct, the rest wrong. */
  const answersFor = async (questions: { id: string }[], right: number) => {
    const docs = await server.connection.collection('questions').find({ _id: { $in: questions.map(q => new Types.ObjectId(q.id)) } }).toArray();
    const key = new Map(docs.map(d => [String(d._id), d]));
    return questions.map((q, i) => {
      const d = key.get(q.id)!;
      return { questionId: q.id, selectedIndex: i < right ? d.answerIndex : (d.answerIndex + 1) % d.options.length };
    });
  };
  const connect = async (from: string, to: string, toName: string) => {
    await as(from).post('/connections', { username: toName }).expect(202);
    const id = (await as(to).get('/connections/requests').expect(200)).body.incoming[0].id;
    await as(to).post(`/connections/${id}/accept`).expect(200);
  };

  beforeAll(async () => {
    p1 = await student('player_one');
    p2 = await student('player_two');
    p3 = await student('player_three');
    for (const u of ['player_one', 'player_two', 'player_three']) await age(u);
    await connect(p1, p2, 'player_two');
    const courses = (await as(p1).get('/courses').expect(200)).body;
    topicId = courses.flatMap((c: any) => c.topics)[0].id;
  });

  it('can only challenge an accepted connection', async () => {
    await as(p3).post('/challenges', { topicId, username: 'player_one' }).expect(404); // not connected
    await as(p1).post('/challenges', { topicId, username: 'no_such_kid' }).expect(404);
    const res = (await as(p1).post('/challenges', { topicId, username: 'player_two' }).expect(201)).body;
    expect(res).toMatchObject({ role: 'challenger', status: 'pending', other: { username: 'player_two' }, me: { started: false, result: null } });
    assertNoPersonalData(res);
    challengeId = res.id;
    expect((await as(p2).get('/notifications').expect(200)).body[0]).toMatchObject({ type: 'challenge_received', username: 'player_one', refId: challengeId });
  });

  it('keeps everyone else out (IDOR)', async () => {
    await as(p3).get(`/challenges/${challengeId}`).expect(404);
    for (const action of ['accept', 'decline', 'cancel', 'start']) await as(p3).post(`/challenges/${challengeId}/${action}`).expect(404);
    await as(p3).post(`/challenges/${challengeId}/submit`, { answers: [{ questionId: topicId, selectedIndex: 0 }] }).expect(404);
    await as(p2).post(`/challenges/${challengeId}/cancel`).expect(409); // only the challenger cancels
    await as(p2).post(`/challenges/${challengeId}/start`).expect(409); // the opponent accepts first
  });

  it('gives both the same questions, timed by the server, and hides the other score until both finish', async () => {
    await as(p2).post(`/challenges/${challengeId}/accept`).expect(200);
    const run1 = (await as(p1).post(`/challenges/${challengeId}/start`).expect(200)).body;
    expect(run1.questions.length).toBeGreaterThanOrEqual(3);
    expect(run1.questions.length).toBeLessThanOrEqual(10);
    for (const q of run1.questions) expect(q).not.toHaveProperty('answerIndex');
    const again = (await as(p1).post(`/challenges/${challengeId}/start`).expect(200)).body;
    expect(again.startedAt).toBe(run1.startedAt); // restarting doesn't reset the clock

    const after1 = (await as(p1).post(`/challenges/${challengeId}/submit`, { answers: await answersFor(run1.questions, run1.questions.length) }).expect(200)).body;
    expect(after1.me.result).toMatchObject({ score: 100, total: run1.questions.length });
    await as(p1).post(`/challenges/${challengeId}/submit`, { answers: await answersFor(run1.questions, 1) }).expect(409); // once only

    const seenBy2 = (await as(p2).get(`/challenges/${challengeId}`).expect(200)).body;
    expect(seenBy2.them).toEqual({ finished: true, result: null });

    const run2 = (await as(p2).post(`/challenges/${challengeId}/start`).expect(200)).body;
    expect(run2.questions.map((q: any) => q.id)).toEqual(run1.questions.map((q: any) => q.id));
    const done = (await as(p2).post(`/challenges/${challengeId}/submit`, { answers: await answersFor(run2.questions, 1) }).expect(200)).body;
    expect(done).toMatchObject({ status: 'completed', outcome: 'lost', them: { result: { score: 100 } } });
    expect((await as(p1).get(`/challenges/${challengeId}`).expect(200)).body.outcome).toBe('won');
    expect((await as(p1).get('/notifications').expect(200)).body[0]).toMatchObject({ type: 'challenge_result', refId: challengeId });
    // It also counted as a normal quiz.
    expect((await as(p2).get('/quiz-attempts').expect(200)).body.length).toBe(1);
  });

  it('expires after 48 hours', async () => {
    const c = (await as(p2).post('/challenges', { topicId, username: 'player_one' }).expect(201)).body;
    await server.connection.collection('challenges').updateOne({ _id: new Types.ObjectId(c.id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await as(p1).get(`/challenges/${c.id}`).expect(200)).body.status).toBe('expired');
    await as(p2).post(`/challenges/${c.id}/start`).expect(409);
  });

  it('turns a shared link into a connection request first, then lets the new connection claim it', async () => {
    const link = (await as(p1).post('/challenges', { topicId }).expect(201)).body;
    expect(link).toMatchObject({ viaLink: true, other: null, code: expect.stringMatching(/^[a-z0-9]{8}$/) });
    expect((await http().get(api(`/challenges/public/${link.code}`)).expect(200)).body).toMatchObject({ challenger: { username: 'player_one' }, open: true });

    const first = (await as(p3).get(`/challenges/link/${link.code}`).expect(200)).body;
    expect(first).toMatchObject({ needsConnection: true, challenger: { username: 'player_one' } });
    const req = (await as(p3).get('/connections/requests').expect(200)).body.incoming.find((r: any) => r.username === 'player_one');
    await as(p3).post(`/connections/${req.id}/accept`).expect(200);

    const claimed = (await as(p3).get(`/challenges/link/${link.code}`).expect(200)).body;
    expect(claimed).toMatchObject({ role: 'opponent', status: 'accepted', other: { username: 'player_one' } });
    await as(p2).get(`/challenges/link/${link.code}`).expect(404); // already taken
    expect((await http().get(api(`/challenges/public/${link.code}`)).expect(200)).body.open).toBe(false);
  });

  it('cancels open challenges when either student blocks the other', async () => {
    const c = (await as(p1).post('/challenges', { topicId, username: 'player_two' }).expect(201)).body;
    await as(p2).post('/blocks', { username: 'player_one' }).expect(200);
    await as(p1).get(`/challenges/${c.id}`).expect(200).then(r => expect(r.body.status).toBe('cancelled'));
    await as(p2).delete('/blocks/player_one').expect(200);
  });

  it('limits challenges to 10 a day', async () => {
    const busy = await student('busy_bee');
    for (let i = 0; i < 10; i++) await as(busy).post('/challenges', { topicId }).expect(201);
    expect((await as(busy).post('/challenges', { topicId }).expect(429)).body.code).toBe('CHALLENGE_LIMIT');
    const stats = (await as(admin).get('/admin/challenges/stats').expect(200)).body;
    expect(stats).toMatchObject({ completed: 1, sentWeek: expect.any(Number) });
  });
});

describe('profiles & badges', () => {
  let pub: string, viewer: string;
  beforeAll(async () => {
    pub = await student('pub_profile');
    viewer = await student('viewer_1');
  });

  it('keeps profiles private by default — no badges or progress for strangers', async () => {
    const card = (await as(viewer).get('/people/pub_profile').expect(200)).body;
    expect(card).toMatchObject({ publicProfile: false, realName: null, badges: [], progress: null });
    await http().get(api('/profiles/pub_profile')).expect(404);
  });

  it('shows a public profile to any student (and to the public endpoint), with the name only if allowed', async () => {
    await as(pub).patch('/auth/privacy', { publicProfile: true }).expect(200);
    const card = (await as(viewer).get('/people/pub_profile').expect(200)).body;
    expect(card).toMatchObject({ publicProfile: true, realName: null, badges: ['founding_tester'], progress: { streakDays: 0, topicsMastered: 0, averageScore: null } });
    const open = (await http().get(api('/profiles/PUB_PROFILE')).expect(200)).body;
    expect(open).toMatchObject({ username: 'pub_profile', realName: null, badges: ['founding_tester'] });
    expect(JSON.stringify(open)).not.toContain('@uni.edu');

    await as(pub).patch('/auth/privacy', { showRealName: true }).expect(200);
    expect((await http().get(api('/profiles/pub_profile')).expect(200)).body.realName).toBe('Real Name');
    expect((await as(pub).get('/me/profile').expect(200)).body).toMatchObject({ publicProfile: true, realName: 'Real Name' });

    // Blocks still win over "public".
    await as(pub).post('/blocks', { username: 'viewer_1' }).expect(200);
    await as(viewer).get('/people/pub_profile').expect(404);
    await as(pub).delete('/blocks/viewer_1').expect(200);
  });

  it('lets admins give and take away manual badges, logged', async () => {
    const id = (await server.connection.collection('users').findOne({ usernameLower: 'pub_profile' }))!._id;
    await as(admin).patch(`/admin/students/${id}/badges`, { badge: 'campus_ambassador', give: true }).expect(200);
    await as(admin).patch(`/admin/students/${id}/badges`, { badge: 'founding_tester', give: false }).expect(200);
    expect((await as(viewer).get('/people/pub_profile').expect(200)).body.badges).toEqual(['campus_ambassador']);
    expect(JSON.stringify((await as(admin).get('/admin/audit-log').expect(200)).body)).toContain('Gave the campus ambassador badge to @pub_profile');
  });
});

describe('study groups', () => {
  let owner: string, friend: string, stranger: string, groupId: string, code: string;
  const connect = async (from: string, to: string, toName: string) => {
    await as(from).post('/connections', { username: toName }).expect(202);
    const id = (await as(to).get('/connections/requests').expect(200)).body.incoming.find((r: any) => r.username)!.id;
    await as(to).post(`/connections/${id}/accept`).expect(200);
  };

  beforeAll(async () => {
    owner = await student('g_owner');
    friend = await student('g_friend');
    stranger = await student('g_stranger');
    for (const u of ['g_owner', 'g_friend', 'g_stranger']) await age(u);
    await connect(owner, friend, 'g_friend');
  });

  it('creates a group with a clean name, owned by its creator', async () => {
    await as(owner).post('/groups', { name: 'f' }).expect(400);
    expect((await as(owner).post('/groups', { name: 'Sh1t heads' }).expect(400)).body.code).toBe('GROUP_NAME_OFFENSIVE');
    const g = (await as(owner).post('/groups', { name: '  MBBS 300L   Physiology ' }).expect(201)).body;
    expect(g).toMatchObject({ name: 'MBBS 300L Physiology', role: 'owner', memberCount: 1, code: expect.stringMatching(/^[a-z0-9]{8}$/) });
    [groupId, code] = [g.id, g.code];
  });

  it('invites accepted connections only, and they must accept', async () => {
    await as(owner).post(`/groups/${groupId}/invites`, { username: 'g_stranger' }).expect(404); // not a connection
    await as(owner).post(`/groups/${groupId}/invites`, { username: 'g_friend' }).expect(200);
    const mine = (await as(friend).get('/groups').expect(200)).body;
    expect(mine.groups).toEqual([]);
    expect(mine.invitations).toEqual([expect.objectContaining({ id: groupId, invitedBy: 'g_owner' })]);
    expect((await as(friend).get('/notifications').expect(200)).body[0]).toMatchObject({ type: 'group_invite', refId: groupId });
    await as(friend).get(`/groups/${groupId}`).expect(404); // not a member until accepting
    const joined = (await as(friend).post(`/groups/${groupId}/invites/accept`).expect(200)).body;
    expect(joined).toMatchObject({ role: 'member', memberCount: 2, code: null }); // only the owner sees the code
  });

  it('keeps everyone else out (IDOR)', async () => {
    await as(stranger).get(`/groups/${groupId}`).expect(404);
    await as(stranger).post(`/groups/${groupId}/invites`, { username: 'g_owner' }).expect(404);
    await as(stranger).post(`/groups/${groupId}/leave`).expect(404);
    await as(stranger).delete(`/groups/${groupId}/members/g_friend`).expect(404);
    await as(friend).delete(`/groups/${groupId}/members/g_owner`).expect(403); // owner only
    await as(friend).post(`/groups/${groupId}/code`, { reset: true }).expect(403);
  });

  it('joins by code only when the owner allows it, and the code can be reset', async () => {
    expect((await as(stranger).get(`/groups/code/${code}`).expect(200)).body).toMatchObject({ name: 'MBBS 300L Physiology', isMember: false });
    await as(owner).post(`/groups/${groupId}/code`, { enabled: false }).expect(200);
    await as(stranger).get(`/groups/code/${code}`).expect(404);
    const reset = (await as(owner).post(`/groups/${groupId}/code`, { enabled: true, reset: true }).expect(200)).body;
    expect(reset.code).not.toBe(code);
    await as(stranger).post(`/groups/code/${code}/join`).expect(404); // old code is dead
    expect((await as(stranger).post(`/groups/code/${reset.code}/join`).expect(200)).body.memberCount).toBe(3);
  });

  it('shows topics practised and this week’s points — never scores', async () => {
    const detail = (await as(friend).get(`/groups/${groupId}`).expect(200)).body;
    expect(detail.leaderboard.map((r: any) => r.username).sort()).toEqual(['g_friend', 'g_owner', 'g_stranger']);
    expect(JSON.stringify(detail)).not.toMatch(/"score"|@uni\\.edu/);
    assertNoPersonalData(detail);
  });

  it('hides members who blocked each other, and refuses joins next to someone you blocked', async () => {
    await as(stranger).post('/blocks', { username: 'g_friend' }).expect(200);
    const seenByFriend = (await as(friend).get(`/groups/${groupId}`).expect(200)).body;
    expect(seenByFriend.members.map((m: any) => m.username)).not.toContain('g_stranger');
    const outsider = await student('g_outsider');
    await as(outsider).post('/blocks', { username: 'g_owner' }).expect(200);
    const fresh = (await as(owner).get(`/groups/${groupId}`).expect(200)).body.code;
    await as(outsider).post(`/groups/code/${fresh}/join`).expect(404);
  });

  it('lets the owner remove members, and hands the group on when the owner leaves', async () => {
    await as(owner).delete(`/groups/${groupId}/members/g_stranger`).expect(200);
    await as(stranger).get(`/groups/${groupId}`).expect(404);
    await as(owner).post(`/groups/${groupId}/leave`).expect(200);
    expect((await as(friend).get(`/groups/${groupId}`).expect(200)).body).toMatchObject({ role: 'owner', memberCount: 1 });
    expect((await as(friend).post(`/groups/${groupId}/leave`).expect(200)).body).toEqual({ ok: true, deleted: true });
  });

  it('limits each student to 5 groups they own, and lets admins delete a group', async () => {
    const maker = await student('g_maker');
    for (let i = 1; i <= 5; i++) await as(maker).post('/groups', { name: `Group ${i}` }).expect(201);
    expect((await as(maker).post('/groups', { name: 'Group 6' }).expect(429)).body.code).toBe('GROUP_LIMIT');
    const list = (await as(admin).get('/admin/groups', { q: 'group 1' }).expect(200)).body;
    expect(list[0]).toMatchObject({ name: 'Group 1', owner: 'g_maker', memberCount: 1 });
    await as(admin).delete(`/admin/groups/${list[0].id}`).expect(200);
    expect((await as(maker).get('/groups').expect(200)).body.groups).toHaveLength(4);
  });
});
