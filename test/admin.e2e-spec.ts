import request from 'supertest';
import { seedSampleContent } from '../src/seed/seed-sample-content';
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
