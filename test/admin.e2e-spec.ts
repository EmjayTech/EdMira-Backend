import request from 'supertest';
import { seedSampleContent } from '../src/seed/seed-sample-content';
import { AiNewsService } from '../src/admin/ai-news.service';
import { startInMemoryApp } from './support/in-memory-app';

/**
 * The admin dashboard's API (EdMira-Admin/docs/ADMIN_API.md): roles, the
 * content review workflow, and its effect on what students see.
 */

jest.setTimeout(120_000);

let server: Awaited<ReturnType<typeof startInMemoryApp>>;
const http = () => request(server.app.getHttpServer());
const api = (path: string) => `/api/v1${path}`;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const PASSWORD = 'Staff!2345';

const tokens: Record<'admin' | 'creator' | 'reviewer' | 'student', string> = {} as any;

const login = async (email: string, password = PASSWORD) =>
  (await http().post(api('/auth/login')).send({ email, password }).expect(201)).body.accessToken as string;

/** Staff calls: as(role).get('/admin/courses') */
const as = (who: keyof typeof tokens) => ({
  get: (path: string) => http().get(api(path)).set(bearer(tokens[who])),
  post: (path: string, body?: object) => http().post(api(path)).set(bearer(tokens[who])).send(body),
  patch: (path: string, body: object) => http().patch(api(path)).set(bearer(tokens[who])).send(body),
});

const topicBody = (courseId: string, overrides: object = {}) => ({
  courseId,
  title: 'Cranial nerves',
  order: 1,
  summary: 'The twelve cranial nerves and how to test them.',
  readMinutes: 0,
  material: [{ heading: 'Overview', body: 'Olfactory, optic, oculomotor…', keyPoints: ['CN I–XII'] }],
  ...overrides,
});

const questionBody = (topicId: string, overrides: object = {}) => ({
  topicId,
  stem: 'Which cranial nerve supplies the lateral rectus?',
  options: ['Oculomotor (III)', 'Trochlear (IV)', 'Abducens (VI)', 'Facial (VII)'],
  answerIndex: 2,
  explanation: 'The abducens nerve (VI) supplies lateral rectus — "LR6".',
  ...overrides,
});

beforeAll(async () => {
  server = await startInMemoryApp();
  await seedSampleContent(server.connection);
  await server.createStaff('admin@edmira.com', 'admin', PASSWORD, 'Ada Admin');
  await server.createStaff('creator@edmira.com', 'creator', PASSWORD, 'Chidi Creator');
  await server.createStaff('reviewer@edmira.com', 'reviewer', PASSWORD, 'Dr Rita Reviewer');
  tokens.admin = await login('admin@edmira.com');
  tokens.creator = await login('creator@edmira.com');
  tokens.reviewer = await login('reviewer@edmira.com');

  const email = 'student@uni.edu';
  await http()
    .post(api('/auth/signup'))
    .send({
      firstName: 'Sade', lastName: 'Student', username: 'sade', email, password: 'Str0ng!Pass',
      userType: 'STUDENT',
      studentProfile: {
        institution: 'University of Lagos', faculty: 'Faculty of Clinical Sciences',
        department: 'Anatomy', levelType: 'Undergraduate', level: '200 Level',
      },
    })
    .expect(201);
  const verified = await http().post(api('/auth/verify')).send({ email, code: server.mail.lastCode(email) });
  tokens.student = verified.body.accessToken;
});

afterAll(async () => {
  await server?.stop();
});

describe('access', () => {
  it('is refused without a token, and for students', async () => {
    await http().get(api('/admin/courses')).expect(401);
    const res = await as('student').get('/admin/courses').expect(403);
    expect(res.body.message).toBe('This account does not have staff access.');
  });

  it('includes the role in the staff profile (the dashboard checks it at sign-in)', async () => {
    const res = await as('reviewer').get('/auth/profile').expect(200);
    expect(res.body.role).toBe('reviewer');
  });

  it('shows all content, with answers, to staff', async () => {
    const courses = await as('reviewer').get('/admin/courses').expect(200);
    expect(courses.body.map((c: any) => c.status)).toContain('draft'); // Pathology
    const questions = await as('reviewer').get('/admin/questions').expect(200);
    expect(questions.body[0]).toHaveProperty('answerIndex');
    expect(questions.body[0]).toHaveProperty('explanation');
    const topics = await as('reviewer').get('/admin/topics').expect(200);
    expect(topics.body[0].material.length).toBeGreaterThan(0);
  });
});

describe('content lifecycle', () => {
  let courseId: string;
  let topicId: string;
  let questionId: string;

  const studentCourseTitles = async () =>
    (await as('student').get('/courses').expect(200)).body.map((c: any) => c.title);

  it('lets a creator draft a course that students cannot see', async () => {
    const res = await as('creator')
      .post('/admin/courses', { title: 'Neuroanatomy', description: 'Brain and nerves', code: '', color: '#7C3AED' })
      .expect(201);
    expect(res.body).toMatchObject({ status: 'draft', code: 'NEU' });
    courseId = res.body.id;
    expect(await studentCourseTitles()).not.toContain('Neuroanatomy');
  });

  it('only lets an admin publish a course', async () => {
    await as('creator').post(`/admin/courses/${courseId}/status`, { status: 'published' }).expect(403);
    await as('admin').post(`/admin/courses/${courseId}/status`, { status: 'published' }).expect(201);
  });

  it('validates topics and questions with the dashboard’s messages', async () => {
    const topic = await as('creator')
      .post('/admin/topics', topicBody(courseId, { summary: ' ', material: [] }))
      .expect(400);
    expect(topic.body.message).toBe('Write a short summary. Add at least one study section.');

    const ok = await as('creator').post('/admin/topics', topicBody(courseId)).expect(201);
    expect(ok.body).toMatchObject({ status: 'draft', createdByName: 'Chidi Creator', readMinutes: 1 });
    topicId = ok.body.id;

    const dup = await as('creator')
      .post('/admin/questions', questionBody(topicId, { options: ['A', 'a', 'B'], answerIndex: 0 }))
      .expect(400);
    expect(dup.body.message).toBe('Two options are the same.');

    const noAnswer = await as('creator')
      .post('/admin/questions', questionBody(topicId, { answerIndex: 9 }))
      .expect(400);
    expect(noAnswer.body.message).toBe('Mark the correct answer.');

    questionId = (await as('creator').post('/admin/questions', questionBody(topicId)).expect(201)).body.id;
  });

  it('reviewers can’t create content', async () => {
    await as('reviewer').post('/admin/questions', questionBody(topicId)).expect(403);
  });

  it('runs submit → request changes → resubmit → approve', async () => {
    await as('creator').post(`/admin/topics/${topicId}/transitions`, { action: 'submit' }).expect(201);
    await as('creator').post(`/admin/questions/${questionId}/transitions`, { action: 'submit' }).expect(201);

    // Locked while in review.
    const locked = await as('creator').patch(`/admin/questions/${questionId}`, questionBody(topicId)).expect(409);
    expect(locked.body.message).toMatch(/being reviewed/);

    // Creators can't approve.
    const creatorApprove = await as('creator')
      .post(`/admin/questions/${questionId}/transitions`, { action: 'approve' })
      .expect(403);
    expect(creatorApprove.body.message).toBe('Only medical reviewers and admins can review content.');

    // Sending back needs a note.
    await as('reviewer').post(`/admin/questions/${questionId}/transitions`, { action: 'request_changes' }).expect(400);
    const back = await as('reviewer')
      .post(`/admin/questions/${questionId}/transitions`, { action: 'request_changes', note: 'Cite a source' })
      .expect(201);
    expect(back.body).toMatchObject({
      status: 'draft',
      lastReview: { decision: 'changes_requested', note: 'Cite a source', reviewerName: 'Dr Rita Reviewer' },
    });

    await as('creator')
      .patch(`/admin/questions/${questionId}`, questionBody(topicId, { explanation: 'Moore, Clinically Oriented Anatomy: LR6.' }))
      .expect(200);
    await as('creator').post(`/admin/questions/${questionId}/transitions`, { action: 'submit' }).expect(201);
    await as('reviewer').post(`/admin/questions/${questionId}/transitions`, { action: 'approve', note: 'Checked' }).expect(201);
    await as('reviewer').post(`/admin/topics/${topicId}/transitions`, { action: 'approve' }).expect(201);
  });

  it('shows approved content to students immediately', async () => {
    expect(await studentCourseTitles()).toContain('Neuroanatomy');
    const questions = await as('student').get(`/topics/${topicId}/questions`).expect(200);
    expect(questions.body.map((q: any) => q.id)).toEqual([questionId]);
    expect(questions.body[0]).not.toHaveProperty('answerIndex');
  });

  it('pulls a published question back into review when it is edited', async () => {
    const res = await as('creator')
      .patch(`/admin/questions/${questionId}`, questionBody(topicId, { stem: 'Which nerve abducts the eye?' }))
      .expect(200);
    expect(res.body.status).toBe('in_review');
    const questions = await as('student').get(`/topics/${topicId}/questions`).expect(200);
    expect(questions.body).toEqual([]);
  });

  it('never lets anyone approve their own work — admins included', async () => {
    const own = await as('admin').post('/admin/questions', questionBody(topicId, { stem: 'Admin-written' })).expect(201);
    await as('admin').post(`/admin/questions/${own.body.id}/transitions`, { action: 'submit' }).expect(201);
    const res = await as('admin')
      .post(`/admin/questions/${own.body.id}/transitions`, { action: 'approve' })
      .expect(403);
    expect(res.body.message).toMatch(/can't review your own content/);
    await as('reviewer').post(`/admin/questions/${own.body.id}/transitions`, { action: 'approve' }).expect(201);
  });

  it('only admins archive and restore; invalid moves are refused', async () => {
    await as('reviewer').post(`/admin/topics/${topicId}/transitions`, { action: 'archive' }).expect(403);
    await as('admin').post(`/admin/topics/${topicId}/transitions`, { action: 'archive' }).expect(201);
    const again = await as('admin').post(`/admin/topics/${topicId}/transitions`, { action: 'archive' }).expect(409);
    expect(again.body.message).toBe("Can't archive content that is archived.");
    await as('admin').post(`/admin/topics/${topicId}/transitions`, { action: 'restore' }).expect(201);
  });
});

describe('study materials (slides, videos, textbooks)', () => {
  // The student: University of Lagos · Anatomy · 200 Level.
  let anatomyId: string;
  let topicId: string;
  let slides: any;
  let video: any;
  let ibadanBook: any;
  const PDF = Buffer.from('%PDF-1.4\n% EdMira test slides\n');

  const upload = (who: keyof typeof tokens, name: string, body = PDF) =>
    http().post(api('/admin/uploads')).set(bearer(tokens[who])).attach('file', body, name);
  const studentMaterials = async () =>
    (await as('student').get(`/courses/${anatomyId}/resources`).expect(200)).body as any[];
  const approve = async (id: string) => {
    await as('creator').post(`/admin/resources/${id}/transitions`, { action: 'submit' }).expect(201);
    await as('reviewer').post(`/admin/resources/${id}/transitions`, { action: 'approve' }).expect(201);
  };

  beforeAll(async () => {
    anatomyId = (await as('admin').get('/admin/courses').expect(200)).body.find((c: any) => c.title === 'Anatomy').id;
    topicId = (await as('admin').get('/admin/topics').expect(200)).body.find(
      (t: any) => t.courseId === anatomyId && t.status === 'published',
    ).id;
  });

  it('reports whether uploads are available', async () => {
    const res = await as('creator').get('/admin/uploads/status').expect(200);
    expect(res.body).toMatchObject({ enabled: true, types: expect.arrayContaining(['.pdf', '.pptx']) });
  });

  it('uploads slides and refuses other file types', async () => {
    await upload('creator', 'virus.exe').expect(400);
    await upload('reviewer', 'slides.pdf').expect(403);
    const file = (await upload('creator', 'Upper limb — lecture 3.pdf').expect(201)).body;
    expect(file).toMatchObject({ name: 'Upper limb — lecture 3.pdf', size: PDF.length, mimeType: 'application/pdf' });

    slides = (
      await as('creator')
        .post('/admin/resources', { courseId: anatomyId, kind: 'slides', title: 'Upper limb slides', file })
        .expect(201)
    ).body;
    expect(slides).toMatchObject({ status: 'draft', topicId: '', institution: '', file: { name: file.name } });
  });

  it('validates materials with readable messages', async () => {
    const bad = async (body: object, message: string) => {
      const res = await as('creator').post('/admin/resources', { courseId: anatomyId, ...body }).expect(400);
      expect(res.body.message).toContain(message);
    };
    await bad({ kind: 'notes', title: 'Handout' }, 'Upload a file or paste a link.');
    await bad({ kind: 'video', title: 'Brachial plexus', link: 'https://vimeo.com/123' }, 'Videos must be YouTube links.');
    await bad({ kind: 'textbook', title: 'Gray', link: 'ftp://files' }, 'Links must start with http:// or https://.');
    const other = (await as('admin').get('/admin/courses').expect(200)).body.find((c: any) => c.title === 'Physiology');
    await bad({ kind: 'notes', title: 'x', link: 'https://a.b', courseId: other.id, topicId }, 'different course');
  });

  it('adds a topic video and a school-only textbook', async () => {
    video = (
      await as('creator')
        .post('/admin/resources', {
          courseId: anatomyId, topicId, kind: 'video', title: 'Brachial plexus in 10 minutes',
          link: 'https://youtu.be/dQw4w9WgXcQ?t=5',
        })
        .expect(201)
    ).body;
    expect(video.youTubeId).toBe('dQw4w9WgXcQ');
    ibadanBook = (
      await as('creator')
        .post('/admin/resources', {
          courseId: anatomyId, kind: 'textbook', title: 'UI Anatomy manual',
          link: 'https://ui.edu.ng/anatomy-manual.pdf', institution: 'University of Ibadan',
        })
        .expect(201)
    ).body;
  });

  it('hides materials from students until another reviewer approves them', async () => {
    expect(await studentMaterials()).toEqual([]);
    await as('creator').post(`/admin/resources/${slides.id}/transitions`, { action: 'submit' }).expect(201);
    await as('creator').post(`/admin/resources/${slides.id}/transitions`, { action: 'approve' }).expect(403);
    await as('reviewer').post(`/admin/resources/${slides.id}/transitions`, { action: 'approve' }).expect(201);
    await approve(video.id);
    await approve(ibadanBook.id);

    const materials = await studentMaterials();
    expect(materials.map(m => m.title).sort()).toEqual(['Brachial plexus in 10 minutes', 'Upper limb slides']);
    expect(materials.find(m => m.kind === 'video')).toMatchObject({ source: 'youtube', youTubeId: 'dQw4w9WgXcQ', topicId });
    const pdf = materials.find(m => m.kind === 'slides');
    expect(pdf).toMatchObject({ source: 'file', file: { name: 'Upper limb — lecture 3.pdf', mimeType: 'application/pdf' } });
    expect(pdf.file).not.toHaveProperty('key');
  });

  it('shows a school\'s own materials only to its students', async () => {
    const ids = (await studentMaterials()).map(m => m.id);
    expect(ids).not.toContain(ibadanBook.id); // student is at Lagos
    await as('admin')
      .patch(`/admin/resources/${ibadanBook.id}`, {
        courseId: anatomyId, kind: 'textbook', title: ibadanBook.title, link: ibadanBook.link,
        institution: 'University of Lagos',
      })
      .expect(200); // back to review after editing published content
    await as('reviewer').post(`/admin/resources/${ibadanBook.id}/transitions`, { action: 'approve' }).expect(201);
    expect((await studentMaterials()).map(m => m.id)).toContain(ibadanBook.id);
  });

  it('downloads files through short-lived signed links', async () => {
    const res = await as('student').get(`/resources/${slides.id}/download`).expect(200);
    expect(res.body).toMatchObject({ name: 'Upper limb — lecture 3.pdf', size: PDF.length });
    const url = new URL(res.body.url);
    const file = await http().get(url.pathname + url.search).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(Buffer.compare(file.body, PDF)).toBe(0);

    await http().get(url.pathname + url.search.replace(/sig=\w/, 'sig=0')).expect(404);
    await as('student').get(`/resources/${video.id}/download`).expect(404); // a link, not a file
  });

  it('logs material changes', async () => {
    const summaries = (await as('admin').get('/admin/audit-log').expect(200)).body.map((e: any) => e.summary);
    expect(summaries).toContain('Added material “Upper limb slides”');
    expect(summaries).toContain('Approved and published material “Upper limb slides”');
  });
});

describe('reports, feedback, students', () => {
  let reportId: string;
  let studentId: string;

  it('lets reviewers handle question reports (with a note)', async () => {
    const [course] = (await as('student').get('/courses')).body;
    const topicId = course.topics[0].id;
    const [question] = (await as('student').get(`/topics/${topicId}/questions`)).body;
    await as('student').post(`/questions/${question.id}/reports`, { topicId, reason: 'wrong_answer', note: 'B?' }).expect(201);

    const list = await as('creator').get('/admin/reports').expect(200);
    reportId = list.body[0].id;
    expect(list.body[0]).toMatchObject({ status: 'open', questionId: question.id, reason: 'wrong_answer' });

    await as('creator').patch(`/admin/reports/${reportId}`, { status: 'resolved', resolutionNote: 'x' }).expect(403);
    await as('reviewer').patch(`/admin/reports/${reportId}`, { status: 'resolved' }).expect(400);
    const done = await as('reviewer')
      .patch(`/admin/reports/${reportId}`, { status: 'resolved', resolutionNote: 'Fixed the key' })
      .expect(200);
    expect(done.body).toMatchObject({ status: 'resolved', handledByName: 'Dr Rita Reviewer' });
  });

  it('keeps feedback admin-only', async () => {
    await as('student').post('/feedback', { area: 'quizzes', rating: 4, message: 'Great' }).expect(201);
    await as('reviewer').get('/admin/feedback').expect(403);
    const list = await as('admin').get('/admin/feedback').expect(200);
    const item = await as('admin').patch(`/admin/feedback/${list.body[0].id}`, { status: 'planned' }).expect(200);
    expect(item.body.status).toBe('planned');
  });

  it('lists students (not staff) for admins', async () => {
    await as('creator').get('/admin/students').expect(403);
    const res = await as('admin').get('/admin/students').expect(200);
    const emails = res.body.map((s: any) => s.email);
    expect(emails).toContain('student@uni.edu');
    expect(emails).not.toContain('admin@edmira.com');
    const student = res.body.find((s: any) => s.email === 'student@uni.edu');
    expect(student).toMatchObject({ institution: 'University of Lagos', level: '200 Level', status: 'active' });
    expect(new Date(student.joinedAt).getTime()).toBeGreaterThan(0);
    studentId = student.id;
  });

  it('suspends a student at once, and reactivates them', async () => {
    await as('admin').patch(`/admin/students/${studentId}`, { status: 'suspended' }).expect(200);
    await as('student').get('/courses').expect(401); // live token revoked
    const res = await http()
      .post(api('/auth/login'))
      .send({ email: 'student@uni.edu', password: 'Str0ng!Pass' })
      .expect(403);
    expect(res.body.message).toMatch(/suspended/);

    await as('admin').patch(`/admin/students/${studentId}`, { status: 'active' }).expect(200);
    tokens.student = await login('student@uni.edu', 'Str0ng!Pass');
    await as('student').get('/courses').expect(200);
  });

  it('can’t suspend staff through the students endpoint', async () => {
    const staff = await as('admin').get('/auth/profile').expect(200);
    await as('admin').patch(`/admin/students/${staff.body.id}`, { status: 'suspended' }).expect(404);
  });

  it('shares quiz attempts with every role (overview metrics)', async () => {
    const [course] = (await as('student').get('/courses')).body;
    const topicId = course.topics[0].id;
    const questions = (await as('student').get(`/topics/${topicId}/questions`)).body;
    await as('student').post('/quiz-attempts', {
      topicId,
      startedAt: new Date().toISOString(),
      answers: questions.map((q: any) => ({ questionId: q.id, selectedIndex: 0 })),
    }).expect(201);
    const res = await as('reviewer').get('/admin/quiz-attempts').expect(200);
    expect(res.body[0]).toMatchObject({ studentId, topicId });
    expect(res.body[0]).not.toHaveProperty('answers');
  });
});

describe('activity log and role changes', () => {
  it('records every change, newest first, for admins only', async () => {
    await as('reviewer').get('/admin/audit-log').expect(403);
    const res = await as('admin').get('/admin/audit-log').expect(200);
    const summaries = res.body.map((e: any) => e.summary);
    expect(summaries[0]).toBe('Reactivated student Sade Student');
    expect(summaries).toContain('Created course “Neuroanatomy”');
    expect(summaries).toContain('Requested changes on question “Which cranial nerve supplies the lateral rectus?” — “Cite a source”');
    expect(summaries.some((s: string) => s.startsWith('Edited published question'))).toBe(true);
    expect(res.body[0]).toMatchObject({ actorName: 'Ada Admin', entity: 'student' });
  });

  it('removing a role takes effect immediately', async () => {
    await server.connection.collection('users').updateOne({ email: 'creator@edmira.com' }, { $unset: { role: '' } });
    await as('creator').get('/admin/courses').expect(403);
  });
});

describe('who a course is for (audience rules)', () => {
  // The student above: University of Lagos · Anatomy · 200 Level.
  const courseByTitle = async (who: keyof typeof tokens, path: string, title: string) =>
    (await as(who).get(path).expect(200)).body.find((c: any) => c.title === title);

  it('marks every course as the student\'s own until rules are added', async () => {
    const courses = (await as('student').get('/courses').expect(200)).body;
    expect(courses.every((c: any) => c.forYou === true)).toBe(true);
  });

  it('saves rules, dropping blanks and duplicates', async () => {
    const anatomy = await courseByTitle('admin', '/admin/courses', 'Anatomy');
    const res = await as('admin')
      .patch(`/admin/courses/${anatomy.id}`, {
        title: 'Anatomy',
        audience: [
          { level: '200 Level', department: 'Anatomy', institution: '' },
          { level: '200 Level', department: 'Anatomy' },
          { level: '100 Level', department: 'Nursing Science', institution: 'University of Lagos' },
        ],
      })
      .expect(200);
    expect(res.body.audience).toEqual([
      { level: '200 Level', department: 'Anatomy' },
      { level: '100 Level', department: 'Nursing Science', institution: 'University of Lagos' },
    ]);
  });

  it('leaves the rules alone when an edit doesn\'t send them', async () => {
    const anatomy = await courseByTitle('admin', '/admin/courses', 'Anatomy');
    const res = await as('admin').patch(`/admin/courses/${anatomy.id}`, { title: 'Anatomy' }).expect(200);
    expect(res.body.audience).toHaveLength(2);
  });

  it('rejects levels, departments and schools that don\'t exist', async () => {
    const anatomy = await courseByTitle('admin', '/admin/courses', 'Anatomy');
    for (const rule of [{ level: '700 Level' }, { level: '200 Level', department: 'Astrology' }, { institution: 'University of Lagos' }]) {
      await as('admin').patch(`/admin/courses/${anatomy.id}`, { title: 'Anatomy', audience: [rule] }).expect(400);
    }
  });

  it('marks courses forYou by level, department and school — but still lists them all', async () => {
    const pharm = await courseByTitle('admin', '/admin/courses', 'Pharmacology');
    await as('admin')
      .patch(`/admin/courses/${pharm.id}`, { title: 'Pharmacology', audience: [{ level: '300 Level' }] })
      .expect(200);
    const physio = await courseByTitle('admin', '/admin/courses', 'Physiology');
    await as('admin')
      .patch(`/admin/courses/${physio.id}`, {
        title: 'Physiology',
        audience: [{ level: '200 Level', institution: 'University of Ibadan' }],
      })
      .expect(200);

    const courses = (await as('student').get('/courses').expect(200)).body;
    const forYou = Object.fromEntries(courses.map((c: any) => [c.title, c.forYou]));
    expect(forYou).toMatchObject({
      Anatomy: true, // 200 Level · Anatomy · any school
      Biochemistry: true, // no rules = everyone
      Pharmacology: false, // 300 Level only
      Physiology: false, // 200 Level, but only at Ibadan
    });

    // Topics and search follow the course.
    const topicId = courses.find((c: any) => c.title === 'Pharmacology').topics[0].id;
    expect((await as('student').get(`/topics/${topicId}`).expect(200)).body.course.forYou).toBe(false);
    const found = (await as('student').get('/search?q=pharmacology').expect(200)).body.courses;
    expect(found[0]).toMatchObject({ title: 'Pharmacology', forYou: false });
  });

  it('follows the student when they change level in Edit profile', async () => {
    await as('student').patch('/auth/profile', { studentProfile: { level: '300 Level' } }).expect(200);
    const pharm = await courseByTitle('student', '/courses', 'Pharmacology');
    const anatomy = await courseByTitle('student', '/courses', 'Anatomy');
    expect([pharm.forYou, anatomy.forYou]).toEqual([true, false]);
  });
});

describe('campus news', () => {
  const story = (overrides: object = {}) => ({
    title: 'Post-UTME screening dates announced',
    summary: 'UNILAG releases its screening timetable.',
    body: ['Screening starts on 3 November.', '  ', 'Bring your JAMB slip.'],
    category: 'admissions',
    institution: 'University of Lagos',
    source: 'UNILAG',
    sourceUrl: 'https://unilag.edu.ng/news',
    ...overrides,
  });
  const publicTitles = async () =>
    (await http().get(api('/news?limit=20')).set(bearer(tokens.student)).expect(200)).body.map((n: any) => n.title);

  it('is admin-only', async () => {
    await as('reviewer').get('/admin/news').expect(403);
    await as('reviewer').post('/admin/news', story()).expect(403);
  });

  it('validates stories with readable messages', async () => {
    const res = await as('admin').post('/admin/news', story({ title: ' ', summary: '' })).expect(400);
    expect(res.body.message).toBe('Give the story a title. Write a short summary.');
    const bad = await as('admin').post('/admin/news', story({ imageUrl: 'http://x.com/a.jpg' })).expect(400);
    expect(JSON.stringify(bad.body.message)).toContain('https://');
    await as('admin').post('/admin/news', story({ category: 'gossip' })).expect(400);
  });

  let id: string;

  it('creates drafts that students cannot see, then publishes them straight away', async () => {
    const created = await as('admin').post('/admin/news', story()).expect(201);
    id = created.body.id;
    expect(created.body).toMatchObject({ status: 'draft', createdByName: 'Ada Admin', isSample: false });
    expect(created.body.body).toEqual(['Screening starts on 3 November.', 'Bring your JAMB slip.']);
    expect(await publicTitles()).not.toContain('Post-UTME screening dates announced');

    const published = await as('admin').post(`/admin/news/${id}/status`, { status: 'published' }).expect(201);
    expect(published.body.status).toBe('published');
    const titles = await publicTitles();
    expect(titles[0]).toBe('Post-UTME screening dates announced');
    const article = await http().get(api(`/news/${id}`)).set(bearer(tokens.student)).expect(200);
    expect(article.body).toMatchObject({ institution: 'University of Lagos', sourceUrl: 'https://unilag.edu.ng/news' });
  });

  it('edits stay live, and an empty link clears it', async () => {
    const res = await as('admin').patch(`/admin/news/${id}`, story({ title: 'Screening dates moved', sourceUrl: '' })).expect(200);
    expect(res.body).toMatchObject({ status: 'published', sourceUrl: '' });
    const article = await http().get(api(`/news/${id}`)).set(bearer(tokens.student)).expect(200);
    expect(article.body.title).toBe('Screening dates moved');
    expect(article.body.sourceUrl).toBeUndefined();
  });

  it('keeps future-dated stories hidden until their date', async () => {
    const future = new Date(Date.now() + 7 * 864e5).toISOString();
    const res = await as('admin').post('/admin/news', story({ title: 'Scheduled story', publishedAt: future })).expect(201);
    await as('admin').post(`/admin/news/${res.body.id}/status`, { status: 'published' }).expect(201);
    expect(await publicTitles()).not.toContain('Scheduled story');
    const all = await as('admin').get('/admin/news').expect(200);
    expect(all.body.find((n: any) => n.id === res.body.id).publishedAt).toBe(future);
  });

  it('archiving removes a story from the app; in_review is not a news status', async () => {
    await as('admin').post(`/admin/news/${id}/status`, { status: 'in_review' }).expect(400);
    await as('admin').post(`/admin/news/${id}/status`, { status: 'archived' }).expect(201);
    expect(await publicTitles()).not.toContain('Screening dates moved');
    await http().get(api(`/news/${id}`)).set(bearer(tokens.student)).expect(404);
  });

  it('logs news changes in the activity log', async () => {
    const res = await as('admin').get('/admin/audit-log').expect(200);
    const summaries = res.body.map((e: any) => e.summary);
    expect(summaries).toContain('Published news “Post-UTME screening dates announced”');
    expect(summaries[0]).toBe('Archived news “Screening dates moved”');
  });
});

describe('bulk import, bulk review and AI drafting', () => {
  beforeAll(async () => {
    // An earlier test removes the first creator's role.
    await server.createStaff('creator2@edmira.com', 'creator', PASSWORD, 'Chidi Creator');
    tokens.creator = await login('creator2@edmira.com');
  });

  const course = (overrides: object = {}) => ({
    title: 'Embryology (import)',
    code: 'EMB',
    audience: [{ level: '200 Level', department: 'Anatomy' }],
    topics: [
      {
        title: 'Gastrulation',
        summary: 'How the trilaminar disc forms in week 3.',
        material: [{ heading: 'Week 3', body: 'The primitive streak appears…', keyPoints: ['Three germ layers'] }],
        questions: [
          { stem: 'The primitive streak first appears in which week?', options: ['1', '2', '3', '4', '5'], answerIndex: 2, explanation: 'Week 3 — gastrulation.' },
          { stem: 'Which layer forms the neural tube?', options: ['Ectoderm', 'Mesoderm', 'Endoderm'], answerIndex: 0 },
        ],
      },
      { title: 'Neurulation', questions: [{ stem: 'Neural tube closure completes by day?', options: ['14', '21', '28', '35'], answerIndex: 2 }] },
    ],
    ...overrides,
  });

  it('reports every problem with its position and saves nothing', async () => {
    const bad = course({
      title: 'Bad import',
      topics: [{ title: 'T', questions: [{ stem: '', options: ['A'], answerIndex: 3 }, { stem: 'ok?', options: ['A', 'a'], answerIndex: 0 }] }],
    });
    const res = await as('creator').post('/admin/import', { courses: [bad] }).expect(201);
    expect(res.body.imported).toBe(false);
    expect(res.body.errors.map((e: any) => e.path)).toEqual([
      'courses[0].topics[0].questions[0]',
      'courses[0].topics[0].questions[1]',
    ]);
    const titles = (await as('admin').get('/admin/courses')).body.map((c: any) => c.title);
    expect(titles).not.toContain('Bad import');
  });

  it('dry-runs, then imports into the review queue', async () => {
    const dry = await as('creator').post('/admin/import', { courses: [course()], dryRun: true }).expect(201);
    expect(dry.body).toMatchObject({
      imported: false,
      courses: { created: 1 },
      topics: { created: 2, withoutNotes: 1 },
      questions: { created: 3 },
    });

    const res = await as('creator').post('/admin/import', { courses: [course()] }).expect(201);
    expect(res.body.imported).toBe(true);
    const courses = (await as('admin').get('/admin/courses')).body;
    const created = courses.find((c: any) => c.title === 'Embryology (import)');
    expect(created.status).toBe('draft'); // creators can't publish courses
    const topics = (await as('admin').get('/admin/topics')).body.filter((t: any) => t.courseId === created.id);
    expect(topics.map((t: any) => [t.title, t.status, t.order])).toEqual([
      ['Gastrulation', 'in_review', 1],
      ['Neurulation', 'draft', 2],
    ]);
    const qs = (await as('admin').get('/admin/questions')).body.filter((q: any) => topics.some((t: any) => t.id === q.topicId));
    expect(qs).toHaveLength(3);
    expect(qs.every((q: any) => q.status === 'in_review' && q.createdByName === 'Chidi Creator')).toBe(true);
  });

  it('is safe to import twice: matches by title and skips repeated questions', async () => {
    const again = course({
      title: 'embryology (IMPORT)',
      topics: [{ title: 'gastrulation', questions: [
        { stem: 'The primitive  streak first appears in which week?', options: ['1', '2', '3'], answerIndex: 2 },
        { stem: 'Notochord derives from?', options: ['Ectoderm', 'Mesoderm'], answerIndex: 1 },
      ] }],
    });
    const res = await as('creator').post('/admin/import', { courses: [again] }).expect(201);
    expect(res.body).toMatchObject({ courses: { matched: 1, created: 0 }, topics: { matched: 1 }, questions: { created: 1, duplicates: 1 } });
  });

  it('lets only admins import library content, which they may then approve themselves', async () => {
    const lib = course({ title: 'Library course', topics: [course().topics[0]] });
    await as('creator').post('/admin/import', { courses: [lib], asLibrary: true }).expect(403);
    await as('admin').post('/admin/import', { courses: [lib], asLibrary: true }).expect(201);

    const libCourse = (await as('admin').get('/admin/courses')).body.find((c: any) => c.title === 'Library course');
    expect(libCourse.status).toBe('published'); // admins' new courses go live…
    // …but stay hidden from students until a topic is approved.
    expect((await as('student').get('/courses')).body.map((c: any) => c.title)).not.toContain('Library course');

    const topic = (await as('admin').get('/admin/topics')).body.find((t: any) => t.courseId === libCourse.id);
    const qs = (await as('admin').get('/admin/questions')).body.filter((q: any) => q.topicId === topic.id);
    expect(topic.createdByName).toBe('EdMira content library');
    expect(topic.createdById).toBe('');

    const res = await as('admin')
      .post('/admin/transitions/bulk', {
        action: 'approve',
        items: [{ kind: 'topic', id: topic.id }, ...qs.map((q: any) => ({ kind: 'question', id: q.id }))],
      })
      .expect(201);
    expect(res.body.done).toHaveLength(1 + qs.length);
    expect(res.body.failed).toEqual([]);

    const visible = (await as('student').get('/courses')).body.find((c: any) => c.title === 'Library course');
    expect(visible.topics.map((t: any) => t.title)).toEqual(['Gastrulation']);
  });

  it('imports recommended YouTube videos into the review queue, once', async () => {
    const lib = (videos: object[]) => course({ title: 'Library course', topics: [{ title: 'Gastrulation', videos }] });
    const good = { title: 'Gastrulation explained', link: 'https://youtu.be/dQw4w9WgXcQ', description: 'Osmosis · 8 min' };

    const bad = await as('admin').post('/admin/import', { courses: [lib([good, { title: 'Elsewhere', link: 'https://vimeo.com/1' }])], asLibrary: true }).expect(201);
    expect(bad.body.imported).toBe(false);
    expect(bad.body.errors).toEqual([expect.objectContaining({ path: 'courses[0].topics[0].videos[1]', message: 'Videos must be YouTube links.' })]);

    const res = await as('admin').post('/admin/import', { courses: [lib([good])], asLibrary: true }).expect(201);
    expect(res.body).toMatchObject({ imported: true, videos: { created: 1, duplicates: 0 } });
    const again = await as('admin').post('/admin/import', { courses: [lib([{ ...good, link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }])], asLibrary: true }).expect(201);
    expect(again.body.videos).toEqual({ created: 0, duplicates: 1 });

    const libCourse = (await as('admin').get('/admin/courses')).body.find((c: any) => c.title === 'Library course');
    const video = (await as('admin').get('/admin/resources')).body.find((r: any) => r.courseId === libCourse.id && r.kind === 'video');
    expect(video).toMatchObject({
      title: 'Gastrulation explained',
      link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      youTubeId: 'dQw4w9WgXcQ',
      description: 'Osmosis · 8 min',
      status: 'in_review',
      createdByName: 'EdMira content library',
    });
    expect(video.topicId).toBeTruthy();

    await as('admin').post('/admin/transitions/bulk', { action: 'approve', items: [{ kind: 'resource', id: video.id }] }).expect(201);
    const materials = (await as('student').get(`/courses/${libCourse.id}/resources`).expect(200)).body;
    expect(materials).toEqual([expect.objectContaining({ kind: 'video', source: 'youtube', youTubeId: 'dQw4w9WgXcQ' })]);
  });

  it('gives students a signed PDF of topic and course notes', async () => {
    const binary = (res: any, done: (err: Error | null, body: Buffer) => void) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    };
    const pathOf = (url: string) => { const u = new URL(url); return u.pathname + u.search; };
    const libCourse = (await as('student').get('/courses')).body.find((c: any) => c.title === 'Library course');
    const topicId = libCourse.topics[0].id;

    const link = (await as('student').get(`/topics/${topicId}/notes`).expect(200)).body;
    expect(link).toMatchObject({ name: 'Gastrulation_notes.pdf', mimeType: 'application/pdf' });
    const pdf = await http().get(pathOf(link.url)).buffer(true).parse(binary).expect(200); // no token needed
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('Gastrulation_notes.pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((pdf.body as Buffer).length).toBeGreaterThan(2000);

    await http().get(pathOf(link.url).replace(/sig=\w/, 'sig=0')).expect(404);
    await http().get(pathOf(link.url).replace('/topic/', '/course/')).expect(404); // signature is per scope + id

    const course = (await as('student').get(`/courses/${libCourse.id}/notes`).expect(200)).body;
    expect(course.name).toBe('Library_course_notes.pdf');
    const coursePdf = await http().get(pathOf(course.url)).buffer(true).parse(binary).expect(200);
    expect((coursePdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    await as('student').get('/topics/64b000000000000000000000/notes').expect(404);
    await http().get(api(`/topics/${topicId}/notes`)).expect(401);
  });

  it('bulk review checks each item on its own', async () => {
    const created = (await as('admin').get('/admin/courses')).body.find((c: any) => c.title === 'Embryology (import)');
    const topics = (await as('admin').get('/admin/topics')).body.filter((t: any) => t.courseId === created.id);
    const q = (await as('admin').get('/admin/questions')).body.find((x: any) => x.topicId === topics[0].id);
    const draftTopic = topics.find((t: any) => t.status === 'draft');

    await as('reviewer').post('/admin/transitions/bulk', { action: 'reject', items: [{ kind: 'question', id: q.id }] }).expect(201)
      .then(res => expect(res.body.failed[0].error).toMatch(/note/i));
    const res = await as('reviewer')
      .post('/admin/transitions/bulk', {
        action: 'approve',
        items: [{ kind: 'question', id: q.id }, { kind: 'topic', id: draftTopic.id }],
      })
      .expect(201);
    expect(res.body.done).toEqual([q.id]);
    expect(res.body.failed).toEqual([{ id: draftTopic.id, error: expect.stringMatching(/draft/) }]);
  });

  it('logs imports in the activity log', async () => {
    const log = (await as('admin').get('/admin/audit-log')).body;
    expect(log.some((e: any) => e.action === 'imported' && /library content/.test(e.summary))).toBe(true);
  });

  it('reports AI drafting as off without a key', async () => {
    expect((await as('creator').get('/admin/ai/status').expect(200)).body).toEqual({ enabled: false });
    const topic = (await as('admin').get('/admin/topics')).body[0];
    await as('creator').post(`/admin/topics/${topic.id}/ai-questions`, { count: 5 }).expect(503);
    await as('creator').post(`/admin/topics/${topic.id}/ai-questions`, { count: 50 }).expect(400);
  });
});

describe('AI news from trusted sources', () => {
  const DAY = 864e5;
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toUTCString();
  const article = (title: string, text: string) =>
    `<html><head><meta property="og:title" content="${title}"><meta property="og:image" content="https://unilag.edu.ng/img/1.jpg"></head>` +
    `<body><nav>Menu</nav><article><h1>${title}</h1><p>${text}</p><p>${'More details for students. '.repeat(12)}</p></article></body></html>`;

  const pages: Record<string, { type: string; body: string }> = {
    'https://unilag.edu.ng/news': {
      type: 'text/html',
      body: `<a href="/about">About the University of Lagos and its history</a>
        <a href="/news/post-utme-screening-2026">UNILAG announces 2026/2027 post-UTME screening dates</a>
        <a href="/news/sports-day">Vice-Chancellor opens inter-faculty sports festival today</a>`,
    },
    'https://unilag.edu.ng/news/post-utme-screening-2026': {
      type: 'text/html',
      body: article('Post-UTME screening dates', 'Screening for the 2026/2027 session starts on 3 November.'),
    },
    'https://unilag.edu.ng/news/sports-day': { type: 'text/html', body: article('Sports festival', 'The sports festival opened today.') },
    'https://ncdc.gov.ng/feed': {
      type: 'application/rss+xml',
      body: `<rss><channel>
        <item><title>Lassa fever situation report, week 39</title><link>https://ncdc.gov.ng/news/lassa-39</link><pubDate>${iso(1)}</pubDate></item>
        <item><title>Old cholera advisory from months ago</title><link>https://ncdc.gov.ng/news/old</link><pubDate>${iso(60)}</pubDate></item>
      </channel></rss>`,
    },
    'https://ncdc.gov.ng/news/lassa-39': { type: 'text/html', body: article('Lassa fever update', 'Screening of contacts continues as Lassa fever cases rise in Edo and Ondo.') },
  };
  const fakeFetch = (async (url: string) => {
    const page = pages[url];
    return page
      ? new Response(page.body, { status: 200, headers: { 'content-type': page.type } })
      : new Response('Not found', { status: 404, statusText: 'Not Found' });
  }) as typeof fetch;

  const picked: string[] = [];
  const fakeWriter = {
    async pick(_source: any, candidates: { title: string; url: string }[], max: number) {
      picked.push(...candidates.map(c => c.url));
      return candidates.map((c, i) => (/screening|lassa|sports/i.test(c.title) ? i : -1)).filter(i => i >= 0).slice(0, max);
    },
    async write(source: any, a: { url: string; text: string }) {
      const relevant = /screening/i.test(a.text);
      return {
        relevant,
        title: /lassa/i.test(a.text) ? 'Lassa fever cases rise in Edo and Ondo' : 'UNILAG post-UTME screening starts 3 November',
        summary: 'Short summary for the carousel.',
        body: [`${source.name} says: ${a.text.slice(0, 80)}`],
        category: (/lassa/i.test(a.text) ? 'clinical' : 'admissions') as 'clinical' | 'admissions',
        institution: /unilag/.test(a.url) ? 'University of Lagos' : '',
        publishedDate: '',
      };
    },
  };

  const del = (path: string) => http().delete(api(path)).set(bearer(tokens.admin));
  const service = () => server.app.get(AiNewsService);

  it('is admin-only and reports itself off without an API key', async () => {
    await as('reviewer').get('/admin/news/ai').expect(403);
    await as('reviewer').post('/admin/news/fetch').expect(403);
    const res = await as('admin').get('/admin/news/ai').expect(200);
    expect(res.body).toMatchObject({ enabled: false, running: false, sources: [] });
    await as('admin').post('/admin/news/fetch').expect(503);
  });

  it('manages sources with readable validation', async () => {
    const bad = await as('admin').post('/admin/news/sources', { name: 'Internal', url: 'http://localhost:4000/x' }).expect(400);
    expect(JSON.stringify(bad.body.message)).toContain('web address');
    const internal = await as('admin').post('/admin/news/sources', { name: 'Internal', url: 'http://192.168.1.10/news' }).expect(400);
    expect(JSON.stringify(internal.body.message)).toContain('web address');
    await as('admin').post('/admin/news/sources', { name: 'X', url: 'not a url' }).expect(400);

    const unilag = await as('admin')
      .post('/admin/news/sources', { name: 'UNILAG', url: 'https://unilag.edu.ng/news', institution: 'University of Lagos' })
      .expect(201);
    expect(unilag.body).toMatchObject({ enabled: true, autoPublish: false, lastCheckedAt: null });
    await as('admin').post('/admin/news/sources', { name: 'Again', url: 'https://unilag.edu.ng/news' }).expect(409);

    const ncdc = await as('admin').post('/admin/news/sources', { name: 'NCDC', url: 'https://ncdc.gov.ng/feed' }).expect(201);
    const updated = await as('admin').patch(`/admin/news/sources/${ncdc.body.id}`, { name: 'NCDC', url: 'https://ncdc.gov.ng/feed', autoPublish: true }).expect(200);
    expect(updated.body.autoPublish).toBe(true);

    const gone = await as('admin').post('/admin/news/sources', { name: 'Gone', url: 'https://gone.example.org/' }).expect(201);
    await del(`/admin/news/sources/${gone.body.id}`).expect(200);
    await del(`/admin/news/sources/${gone.body.id}`).expect(404);
  });

  it('turns new, relevant stories into drafts — or publishes them for auto-publish sources', async () => {
    service().useForTesting(fakeWriter, fakeFetch);
    const run = await as('admin').post('/admin/news/fetch').expect(201);
    expect(run.body).toMatchObject({ sourcesChecked: 2, added: 2, published: 1, errors: [] });
    // The sports story was read but judged irrelevant; the 60-day-old advisory was never offered.
    expect(run.body.skipped).toBe(1);
    expect(picked).not.toContain('https://ncdc.gov.ng/news/old');
    expect(picked).not.toContain('https://unilag.edu.ng/about');

    const all = (await as('admin').get('/admin/news').expect(200)).body;
    const draft = all.find((n: any) => n.title === 'UNILAG post-UTME screening starts 3 November');
    expect(draft).toMatchObject({
      status: 'draft',
      origin: 'ai',
      category: 'admissions',
      source: 'UNILAG',
      institution: 'University of Lagos',
      sourceUrl: 'https://unilag.edu.ng/news/post-utme-screening-2026',
      imageUrl: 'https://unilag.edu.ng/img/1.jpg',
      createdByName: 'AI · UNILAG',
    });
    const titles = (await http().get(api('/news?limit=20')).set(bearer(tokens.student)).expect(200)).body.map((n: any) => n.title);
    expect(titles[0]).toBe('Lassa fever cases rise in Edo and Ondo');
    expect(titles).not.toContain(draft.title);

    const sources = (await as('admin').get('/admin/news/ai').expect(200)).body.sources;
    expect(sources.find((s: any) => s.name === 'UNILAG')).toMatchObject({ lastAdded: 1, lastError: '' });
  });

  it('only asks the AI about links it has not seen before', async () => {
    picked.length = 0;
    const run = await as('admin').post('/admin/news/fetch').expect(201);
    expect(run.body).toMatchObject({ added: 0, errors: [] });
    expect(picked).toEqual([]);
  });

  it('records unreachable sources instead of failing the run', async () => {
    const broken = await as('admin').post('/admin/news/sources', { name: 'Broken', url: 'https://broken.example.org/' }).expect(201);
    const run = await as('admin').post('/admin/news/fetch').expect(201);
    expect(run.body.errors).toEqual([{ source: 'Broken', message: '404 Not Found from https://broken.example.org/' }]);
    await as('admin').patch(`/admin/news/sources/${broken.body.id}`, { name: 'Broken', url: 'https://broken.example.org/', enabled: false }).expect(200);
  });

  it('never finds more stories than the limit allows in the window', async () => {
    const extra = ['post-utme-screening-venues', 'post-utme-screening-results'];
    pages['https://unilag.edu.ng/news'].body += extra
      .map(slug => `<a href="/news/${slug}">UNILAG update on ${slug.replace(/-/g, ' ')} for new students</a>`)
      .join('');
    for (const slug of extra) {
      pages[`https://unilag.edu.ng/news/${slug}`] = { type: 'text/html', body: article(slug, `Screening news: ${slug} for the 2026 session.`) };
    }
    const writeTitle = fakeWriter.write;
    fakeWriter.write = async (source, a) => ({ ...(await writeTitle(source, a)), title: `UNILAG ${a.url.split('/').pop()}` });
    try {
      // 2 found so far; a limit of 3 leaves room for exactly one more, though two are new.
      process.env.NEWS_LIMIT = '3';
      const run = await as('admin').post('/admin/news/fetch').expect(201);
      expect(run.body).toMatchObject({ limitReached: false, added: 1, limit: { max: 3, windowHours: 48, used: 3 } });

      picked.length = 0;
      const full = await as('admin').post('/admin/news/fetch').expect(201);
      expect(full.body).toMatchObject({ limitReached: true, sourcesChecked: 0, added: 0 });
      expect(picked).toEqual([]); // no site read, no AI call
      expect(new Date(full.body.limit.nextSlotAt).getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);
      const status = (await as('admin').get('/admin/news/ai').expect(200)).body;
      expect(status.limit).toMatchObject({ max: 3, used: 3 });
      expect(status.limit.nextSlotAt).toBe(full.body.limit.nextSlotAt);
    } finally {
      delete process.env.NEWS_LIMIT;
      fakeWriter.write = writeTitle;
    }
  });

  it('publishes or discards AI suggestions in bulk', async () => {
    const drafts = (await as('admin').get('/admin/news').expect(200)).body.filter((n: any) => n.origin === 'ai' && n.status === 'draft');
    const res = await as('admin').post('/admin/news/bulk-status', { ids: [...drafts.map((d: any) => d.id), '64b000000000000000000000'], status: 'published' }).expect(201);
    expect(res.body.done).toEqual(drafts.map((d: any) => d.id));
    expect(res.body.failed).toEqual([{ id: '64b000000000000000000000', error: 'That story no longer exists.' }]);
    await as('admin').post('/admin/news/bulk-status', { ids: [], status: 'published' }).expect(400);
    await as('reviewer').post('/admin/news/bulk-status', { ids: [drafts[0].id], status: 'archived' }).expect(403);
  });

  it('adds the suggested official sources once', async () => {
    const first = await as('admin').post('/admin/news/sources/defaults').expect(201);
    const count = first.body.sources.length;
    expect(first.body.sources.map((s: any) => s.name)).toEqual(expect.arrayContaining(['NCDC', 'JAMB', 'MDCN', 'NUC']));
    const again = await as('admin').post('/admin/news/sources/defaults').expect(201);
    expect(again.body.sources).toHaveLength(count);
    service().useForTesting(undefined);
  });
});
