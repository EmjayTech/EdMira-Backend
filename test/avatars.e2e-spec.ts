import request from 'supertest';
import sharp from 'sharp';
import { FakeEmailService, startInMemoryApp } from './support/in-memory-app';

/**
 * Profile pictures: presets, photo upload (content-checked, re-encoded,
 * EXIF stripped), removal, the daily limit, where avatars show, and
 * reporting / moderator removal.
 */

jest.setTimeout(120_000);

let server: Awaited<ReturnType<typeof startInMemoryApp>>;
let http: () => ReturnType<typeof request>;
let mail: FakeEmailService;

const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const PASSWORD = 'Str0ng!Pass';
let phoneSeq = 500;

async function student(username: string) {
  const email = `${username.replace(/\W/g, '')}@uni.edu`;
  await http()
    .post(api('/auth/signup'))
    .send({
      firstName: 'Real', lastName: 'Name', username, email, password: PASSWORD, userType: 'STUDENT',
      phoneNumber: `80${String(10_000_000 + ++phoneSeq)}`, countryCode: '+234',
      studentProfile: { institution: 'University of Lagos', faculty: 'Faculty of Clinical Sciences', department: 'Medicine & Surgery (MBBS)', levelType: 'Undergraduate', level: '300 Level' },
    })
    .expect(201);
  await server.connection.collection('users').updateOne({ email }, { $set: { createdAt: new Date(Date.now() - 3 * 86_400_000) } });
  const res = await http().post(api('/auth/verify')).send({ email, code: mail.lastCode(email) }).expect(201);
  return res.body.accessToken as string;
}

const photo = (format: 'jpeg' | 'png' = 'jpeg', withGps = false) => {
  let img = sharp({ create: { width: 900, height: 600, channels: 3, background: '#2a7' } });
  if (withGps) img = img.withExif({ IFD0: { Make: 'TestCam', Copyright: 'secret-location' }, IFD3: { GPSLatitude: '6/1 27/1 0/1', GPSLatitudeRef: 'N' } });
  return format === 'png' ? img.png().toBuffer() : img.jpeg().toBuffer();
};

let ada: string, bola: string, admin: string;

beforeAll(async () => {
  server = await startInMemoryApp();
  mail = server.mail;
  http = () => request(server.app.getHttpServer());
  ada = await student('ava_ada');
  bola = await student('ava_bola');
  await server.createStaff('mod-av@edmira.com', 'admin', 'Staff!2345', 'Mo Moderator');
  admin = (await http().post(api('/auth/login')).send({ email: 'mod-av@edmira.com', password: 'Staff!2345' }).expect(201)).body.accessToken;
});

afterAll(async () => {
  await server?.stop();
});

describe('profile picture', () => {
  it('starts with initials only', async () => {
    const me = (await http().get(api('/auth/profile')).set(auth(ada)).expect(200)).body;
    expect(me.avatar).toEqual({ preset: null, url: null });
    expect(me).not.toHaveProperty('avatarQuota');
  });

  it('sets a built-in avatar and rejects unknown ones', async () => {
    const res = await http().put(api('/auth/avatar/preset')).set(auth(ada)).send({ preset: 'a07' }).expect(200);
    expect(res.body.avatar).toEqual({ preset: 'a07', url: null });
    await http().put(api('/auth/avatar/preset')).set(auth(ada)).send({ preset: 'a99' }).expect(400);
    await http().put(api('/auth/avatar/preset')).send({ preset: 'a01' }).expect(401);
  });

  it('accepts a photo, re-encodes it to 512×512 WebP and strips EXIF / GPS', async () => {
    const res = await http()
      .post(api('/auth/avatar/photo'))
      .set(auth(ada))
      .attach('file', await photo('jpeg', true), { filename: 'me.jpg', contentType: 'image/jpeg' })
      .expect(201);
    expect(res.body.avatar.preset).toBeNull();
    expect(res.body.avatar.url).toMatch(/^\/api\/v1\/files\/avatars\/[\w-]+\.webp$/);
    const file = await http().get(res.body.avatar.url).expect(200);
    expect(file.headers['content-type']).toContain('image/webp');
    expect(file.headers['cache-control']).toContain('immutable');
    const meta = await sharp(file.body as Buffer).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 512, 512]);
    expect(meta.exif).toBeUndefined();
    expect((file.body as Buffer).toString('latin1')).not.toContain('secret-location');
    expect((file.body as Buffer).length).toBeLessThan(200_000);
  });

  it('gives a new URL on every change (cache-busting) and deletes the old file', async () => {
    const first = (await http().get(api('/auth/profile')).set(auth(ada)).expect(200)).body.avatar.url;
    const res = await http().post(api('/auth/avatar/photo')).set(auth(ada)).attach('file', await photo('png'), 'x.png').expect(201);
    expect(res.body.avatar.url).not.toBe(first);
    await http().get(first).expect(404);
  });

  it('judges the file by its content, not its name', async () => {
    const fake = Buffer.from('%PDF-1.4 not really a picture');
    const res = await http().post(api('/auth/avatar/photo')).set(auth(bola)).attach('file', fake, { filename: 'cute.jpg', contentType: 'image/jpeg' }).expect(400);
    expect(res.body.code).toBe('AVATAR_NOT_IMAGE');
    await http().post(api('/auth/avatar/photo')).set(auth(bola)).expect(400);
  });

  it('refuses files over 5 MB', async () => {
    const big = Buffer.concat([await photo('jpeg'), Buffer.alloc(5 * 1024 * 1024 + 10)]);
    await http().post(api('/auth/avatar/photo')).set(auth(bola)).attach('file', big, 'big.jpg').expect(413);
  });

  it('removes the picture (back to initials) and shows avatars to others', async () => {
    await http().put(api('/auth/avatar/preset')).set(auth(bola)).send({ preset: 'a03' }).expect(200);
    const found = (await http().get(api('/people/search')).query({ q: 'ava_bola' }).set(auth(ada)).expect(200)).body;
    expect(found[0].avatar).toEqual({ preset: 'a03', url: null });
    const res = await http().delete(api('/auth/avatar')).set(auth(bola)).expect(200);
    expect(res.body.avatar).toEqual({ preset: null, url: null });
  });

  it('caps changes at 10 a day', async () => {
    const used = await server.connection.collection('users').findOne({ usernameLower: 'ava_bola' });
    const already = used?.avatarQuota?.count ?? 0;
    for (let i = already; i < 10; i++) {
      await http().put(api('/auth/avatar/preset')).set(auth(bola)).send({ preset: 'a01' }).expect(200);
    }
    const res = await http().put(api('/auth/avatar/preset')).set(auth(bola)).send({ preset: 'a02' }).expect(429);
    expect(res.body.code).toBe('AVATAR_LIMIT');
    await http().delete(api('/auth/avatar')).set(auth(bola)).expect(200); // removing is always allowed
  });

  it('lets students report a photo and moderators remove it (logged, student told)', async () => {
    await http().post(api('/reports/users')).set(auth(bola)).send({ username: 'ava_ada', category: 'inappropriate_photo' }).expect(200);
    const queue = (await http().get(api('/admin/moderation/reports')).set(auth(admin)).expect(200)).body;
    const report = queue.find((r: any) => r.category === 'inappropriate_photo');
    expect(report.reported.avatar.url).toMatch(/avatars\//);
    expect(report.evidence.reportedAvatar.url).toBe(report.reported.avatar.url);
    await http().post(api(`/admin/moderation/reports/${report.id}/action`)).set(auth(admin)).send({ action: 'remove_photo' }).expect(201);
    const me = (await http().get(api('/auth/profile')).set(auth(ada)).expect(200)).body;
    expect(me.avatar).toEqual({ preset: null, url: null });
    await http().get(report.reported.avatar.url).expect(404);
    // Nothing left to remove now.
    const students = (await http().get(api('/admin/students')).set(auth(admin)).expect(200)).body;
    const adaId = students.find((s: any) => s.username === 'ava_ada').id;
    await http().delete(api(`/admin/students/${adaId}/avatar`)).set(auth(admin)).expect(400);
    await http().delete(api(`/admin/students/${adaId}/avatar`)).set(auth(bola)).expect(403);
    const inbox = (await http().get(api('/notifications')).set(auth(ada)).expect(200)).body;
    expect(JSON.stringify(inbox)).toContain('avatar_removed');
    const log = (await http().get(api('/admin/audit-log')).set(auth(admin)).expect(200)).body.map((e: any) => e.summary);
    expect(log).toContain('Removed the profile photo of @ava_ada');
  });
});
