import request from 'supertest';
import { seedSampleContent } from '../src/seed/seed-sample-content';
import { ContentBundle, TopicVersionsService } from '../src/content/topic-versions.service';
import { startInMemoryApp } from './support/in-memory-app';

/**
 * Part 3e: original notes import as DRAFT versions, live notes never change
 * until approval, old questions are retired (quiz history intact), rollback,
 * figures, the editable per-school codes and contributor permissions.
 */

jest.setTimeout(180_000);

let server: Awaited<ReturnType<typeof startInMemoryApp>>;
const http = () => request(server.app.getHttpServer());
const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const db = () => server.connection;
const service = () => server.app.get(TopicVersionsService);

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect x="4" y="4" width="392" height="192" rx="12" fill="#EEF2FE"/><text x="200" y="104" text-anchor="middle" font-size="20">Wiggers</text></svg>');

const topicFile = (id: string, title: string, extra = '') => `---
id: ${id}
title: ${title}
summary: A short summary for ${title}.
${extra}---

## Objectives
- Describe the phases
- Relate pressure and volume
- Link events to heart sounds

## Key points
- Systole has **two** phases

## Notes
### Phases
Written originally for EdMira: isovolumetric contraction, then ejection.

{{fig:wiggers}}

## Extended
### Pressure–volume loops
Deeper detail for Pro.

## Clinical correlation
### Aortic stenosis
A narrowed valve raises left ventricular pressure.

## Revision
- S1 = AV valves close

## Further reading
- Guyton & Hall, cardiac cycle chapter (cited)

## Figures
- key: wiggers
  file: figures/wiggers.svg
  caption: Pressures in one cardiac cycle.
  alt: Line graph of aortic, ventricular and atrial pressure over time.
`;

const WORDS = 'aorta valve atrium systole diastole preload afterload contractility stroke volume ejection fraction murmur sound pressure gradient compliance resistance viscosity laminar turbulent capillary arteriole venule baroreceptor chemoreceptor vagus sympathetic pacemaker node bundle purkinje plateau calcium potassium sodium channel refractory threshold depolarise repolarise inotrope chronotrope starling filling isovolumetric relaxation dicrotic notch wedge capacitance elastance reflex medulla renin angiotensin aldosterone vasopressin bradykinin histamine nitric endothelin prostacyclin'.split(' ');
const mcq = (n: number, prefix: string) =>
  JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      // Distinct wording per question (the near-duplicate check is strict).
      stem: `${prefix} question: ${WORDS.slice(i * 4, i * 4 + 4).join(' ')}?`,
      options: ['First option text', 'Second option text', 'Third option text', 'Fourth option text'],
      answer: 'ABCD'[i % 4],
      explanation: 'The right option follows from the pressure changes; the others happen in other phases of the cycle.',
      difficulty: ['easy', 'medium', 'hard'][i % 3],
      kind: ['recall', 'understanding', 'clinical'][i % 3],
    })),
  );

const outline = {
  subject: 'Physiology',
  version: 'test',
  modules: [
    {
      id: 'PHY-05',
      title: 'Cardiovascular',
      edmira_course: 'PHY',
      topics: [
        { id: 'PHY-05-04', title: 'Cardiac cycle', order: 4, edmira: { course: 'PHY', action: 'new_version', existing_topic: 'The Cardiac Cycle' } },
        { id: 'PHY-05-06', title: 'Haemodynamics', order: 6, edmira: { course: 'PHY', action: 'new_topic', existing_topic: null } },
      ],
    },
  ],
  school_codes: [
    { school: 'University of Benin (UNIBEN), MBBS', key: 'uniben', verified: true, source: 'https://medicine.uniben.edu/mbbs-curriculum/', courses: [{ code: 'PHS211', title: 'Cardiovascular', modules: ['PHY-05'] }] },
    { school: 'University of Lagos (UNILAG)', key: 'unilag', verified: false, source: null, courses: [] },
  ],
};

const bundle = (over: Partial<ContentBundle> = {}, cycleExtra = ''): ContentBundle => ({
  source: 'test/physiology',
  outline: outline as never,
  topics: [
    { path: 'PHY-05-04.md', text: topicFile('PHY-05-04', 'The Cardiac Cycle', cycleExtra), questions: mcq(16, 'Cycle') },
    { path: 'PHY-05-06.md', text: topicFile('PHY-05-06', 'Haemodynamics').replace('Written originally for EdMira: isovolumetric contraction, then ejection.', 'Flow equals pressure difference divided by resistance, in our own words.'), questions: mcq(15, 'Flow') },
  ],
  files: { 'figures/wiggers.svg': SVG },
  ...over,
});

let student: string;
let reviewer: string;
let cycleId: string;
let attemptId: string;
let liveMaterialBefore: unknown;

beforeAll(async () => {
  server = await startInMemoryApp();
  await seedSampleContent(server.connection);
  await server.createStaff('rev@content.test', 'reviewer', 'Staff!2345', 'Rita Reviewer');
  reviewer = (await http().post(api('/auth/login')).send({ email: 'rev@content.test', password: 'Staff!2345' }).expect(201)).body.accessToken;

  const email = 'cv_student@uni.edu';
  await http()
    .post(api('/auth/signup'))
    .send({
      firstName: 'Ada', lastName: 'Obi', username: 'cv_student', email, password: 'Str0ng!Pass', userType: 'STUDENT',
      studentProfile: { institution: 'University of Lagos', faculty: 'Faculty of Basic Medical Sciences', department: 'Physiology', levelType: 'Undergraduate', level: '200 Level' },
    })
    .expect(201);
  student = (await http().post(api('/auth/verify')).send({ email, code: server.mail.lastCode(email) }).expect(201)).body.accessToken;

  const cycle = await db().collection('topics').findOne({ title: 'The Cardiac Cycle' });
  cycleId = String(cycle!._id);
  liveMaterialBefore = (await http().get(api(`/topics/${cycleId}`)).set(auth(student)).expect(200)).body.topic.material;

  // A quiz on the old questions, so history must survive.
  const qs = (await http().get(api(`/topics/${cycleId}/questions`)).set(auth(student)).expect(200)).body;
  const list = Array.isArray(qs) ? qs : qs.items ?? qs.data;
  const res = await http()
    .post(api('/quiz-attempts'))
    .set(auth(student))
    .send({ topicId: cycleId, startedAt: new Date(Date.now() - 300_000).toISOString(), answers: list.map((q: any) => ({ questionId: q.id, selectedIndex: 0 })) })
    .expect(201);
  attemptId = (res.body.data ?? res.body).id;
});

afterAll(async () => {
  await server?.stop();
});

describe('versioned notes import', () => {
  it('a dry run checks everything and saves nothing', async () => {
    const r = await service().import(bundle(), { dryRun: true, authorName: 'EdMira content library' });
    expect(r.problems.filter(p => p.level === 'error')).toEqual([]);
    expect(r.topics).toMatchObject({ newVersions: [expect.stringContaining('PHY-05-04')], created: [expect.stringContaining('PHY-05-06')] });
    expect(r.questions).toBe(31);
    expect(await db().collection('topic_versions').countDocuments()).toBe(0);
  });

  it('refuses the whole import if anything is wrong (NC image, unknown contributor, missing figure)', async () => {
    const bad = bundle(
      {
        topics: [
          {
            path: 'PHY-05-04.md',
            text: topicFile('PHY-05-04', 'The Cardiac Cycle', 'contributors: dr-nobody\n').replace('  alt: Line graph', '  source: OpenStax\n  licence: CC BY-NC-SA 4.0\n  attribution: OpenStax\n  url: https://openstax.org/x\n  alt: Line graph'),
            questions: mcq(16, 'Cycle'),
          },
        ],
      },
    );
    const r = await service().import(bad, { authorName: 'x' });
    const errors = r.problems.filter(p => p.level === 'error').map(p => p.message);
    expect(errors.some(m => /NonCommercial/.test(m))).toBe(true);
    expect(errors.some(m => /dr-nobody/.test(m))).toBe(true);
    expect(r.imported).toBe(false);
    expect(await db().collection('topic_versions').countDocuments()).toBe(0);
  });

  it('imports drafts: live notes unchanged, new topic hidden, questions in review', async () => {
    const r = await service().import(bundle(), { authorName: 'EdMira content library' });
    expect(r.imported).toBe(true);
    expect(r.figures.stored).toBe(1);
    expect(r.figures.reused).toBe(1);

    const live = (await http().get(api(`/topics/${cycleId}`)).set(auth(student)).expect(200)).body.topic;
    expect(live.material).toEqual(liveMaterialBefore);
    expect(live.objectives).toBeUndefined();

    const versions = await db().collection('topic_versions').find({ topicId: { $exists: true } }).sort({ version: 1 }).toArray();
    expect(versions.map(v => [v.version, v.status])).toEqual(expect.arrayContaining([[0, 'published'], [1, 'in_review']]));
    const newTopic = await db().collection('topics').findOne({ curriculumId: 'PHY-05-06' });
    expect(newTopic!.status).toBe('draft');
    await http().get(api(`/topics/${newTopic!._id}`)).set(auth(student)).expect(404);
    expect(await db().collection('questions').countDocuments({ tag: 'PHY-05-04', status: 'in_review', topicVersion: 1 })).toBe(16);

    // Unchanged files: nothing new.
    const again = await service().import(bundle(), { authorName: 'EdMira content library' });
    expect(again.topics.unchanged).toHaveLength(2);
    expect(await db().collection('topic_versions').countDocuments()).toBe(3);
  });

  it('reviewers see pending versions with the live notes to compare; students cannot', async () => {
    await http().get(api('/admin/topic-versions')).set(auth(student)).expect(403);
    const pending = (await http().get(api('/admin/topic-versions')).set(auth(reviewer)).expect(200)).body;
    expect(pending.map((v: any) => v.topicTitle)).toEqual(expect.arrayContaining(['The Cardiac Cycle', 'Haemodynamics']));
    const v1 = pending.find((v: any) => v.topicTitle === 'The Cardiac Cycle');
    const detail = (await http().get(api(`/admin/topic-versions/${v1.id}`)).set(auth(reviewer)).expect(200)).body;
    expect(detail.version).toMatchObject({ version: 1, status: 'in_review', curriculumId: 'PHY-05-04' });
    expect(detail.live).toMatchObject({ version: 0 });
    expect(detail.questions).toHaveLength(16);
    // Sending back needs a reason.
    await http().post(api(`/admin/topic-versions/${v1.id}/transitions`)).set(auth(reviewer)).send({ action: 'request_changes' }).expect(400);
  });

  it('approving puts the new notes live, retires old questions, keeps quiz history', async () => {
    const [v1] = (await http().get(api(`/topics/${cycleId}/versions`.replace('/topics', '/admin/topics'))).set(auth(reviewer)).expect(200)).body;
    expect(v1.version).toBe(1);
    const res = await http().post(api(`/admin/topic-versions/${v1.id}/transitions`)).set(auth(reviewer)).send({ action: 'approve' }).expect(201);
    expect(res.body).toMatchObject({ status: 'published', questionsPublished: 16 });

    const live = (await http().get(api(`/topics/${cycleId}`)).set(auth(student)).expect(200)).body.topic;
    expect(live).toMatchObject({ curriculumId: 'PHY-05-04', objectives: expect.any(Array), revision: ['S1 = AV valves close'], furtherReading: [expect.stringContaining('Guyton')] });
    expect(live.extended[0].heading).toBe('Pressure–volume loops');
    expect(live.figures[0]).toMatchObject({ label: 'Figure 1.4.1', caption: 'Pressures in one cardiac cycle.', attribution: '' });

    const fig = await http().get(api(live.figures[0].url.replace('/api/v1', ''))).expect(200);
    expect(fig.headers['content-type']).toContain('image/svg+xml');
    expect(fig.headers['cache-control']).toContain('immutable');

    const quiz = (await http().get(api(`/topics/${cycleId}/questions`)).set(auth(student)).expect(200)).body;
    const list = Array.isArray(quiz) ? quiz : quiz.items ?? quiz.data;
    expect(list.every((q: any) => /^Cycle question/.test(q.stem))).toBe(true);
    // The old attempt still opens with its (now retired) questions.
    const old = (await http().get(api(`/quiz-attempts/${attemptId}`)).set(auth(student)).expect(200)).body;
    const oldQuestions = (old.data ?? old).questions;
    expect(oldQuestions.length).toBeGreaterThan(0);
    expect(oldQuestions.every((q: any) => !/^Cycle question/.test(q.stem))).toBe(true);

    const topic = await db().collection('topics').findOne({ _id: (await db().collection('topics').findOne({ curriculumId: 'PHY-05-04' }))!._id });
    expect(topic).toMatchObject({ reviewedBy: 'Rita Reviewer', liveVersion: 1 });
    expect(await db().collection('auditentries').countDocuments({ action: 'version_approve' })).toBe(1);
  });

  it('rolls back to the notes from before, and forward again', async () => {
    const history = (await http().get(api(`/admin/topics/${cycleId}/versions`)).set(auth(reviewer)).expect(200)).body;
    const v0 = history.find((v: any) => v.version === 0);
    expect(v0.status).toBe('superseded');
    await http().post(api(`/admin/topic-versions/${v0.id}/transitions`)).set(auth(reviewer)).send({ action: 'restore' }).expect(201);
    let live = (await http().get(api(`/topics/${cycleId}`)).set(auth(student)).expect(200)).body.topic;
    expect(live.material).toEqual(liveMaterialBefore);
    let quiz = (await http().get(api(`/topics/${cycleId}/questions`)).set(auth(student)).expect(200)).body;
    expect((Array.isArray(quiz) ? quiz : quiz.items ?? quiz.data).some((q: any) => /^Cycle question/.test(q.stem))).toBe(false);

    const v1 = (await http().get(api(`/admin/topics/${cycleId}/versions`)).set(auth(reviewer)).expect(200)).body.find((v: any) => v.version === 1);
    await http().post(api(`/admin/topic-versions/${v1.id}/transitions`)).set(auth(reviewer)).send({ action: 'restore' }).expect(201);
    live = (await http().get(api(`/topics/${cycleId}`)).set(auth(student)).expect(200)).body.topic;
    expect(live.curriculumId).toBe('PHY-05-04');
    quiz = (await http().get(api(`/topics/${cycleId}/questions`)).set(auth(student)).expect(200)).body;
    expect((Array.isArray(quiz) ? quiz : quiz.items ?? quiz.data).every((q: any) => /^Cycle question/.test(q.stem))).toBe(true);
  });

  it('a changed file replaces the version still waiting for review (no pile-up)', async () => {
    const before = await db().collection('topic_versions').countDocuments();
    const changed = bundle();
    changed.topics[1].text = changed.topics[1].text.replace('Deeper detail for Pro.', 'Deeper detail for Pro, revised.');
    const r = await service().import(changed, { authorName: 'EdMira content library' });
    expect(r.topics.newVersions).toEqual([expect.stringContaining('PHY-05-06')]);
    expect(await db().collection('topic_versions').countDocuments()).toBe(before);
    const v = await db().collection('topic_versions').findOne({ curriculumId: 'PHY-05-06' });
    expect(v!.extended[0].body).toContain('revised');
  });
});

describe('"⚑" checks', () => {
  it('each ⚑ (notes or question) must be confirmed, corrected or removed by a reviewer before approval', async () => {
    const flagged = bundle();
    flagged.topics = [
      {
        ...flagged.topics[1],
        text: flagged.topics[1].text
          .replace('Deeper detail for Pro.', 'Deeper detail for Pro. Resistance rises with the fourth power of radius ⚑ check the exponent.')
          .replace('- S1 = AV valves close', '- S1 = AV valves close\n- Viscosity ⚑ doubles in polycythaemia'),
        questions: JSON.stringify(
          JSON.parse(flagged.topics[1].questions!).map((q: any, i: number) => (i === 2 ? { ...q, explanation: `${q.explanation} ⚑ Confirm this figure.` } : q)),
        ),
      },
    ];
    const r = await service().import(flagged, { authorName: 'EdMira content library' });
    expect(r.problems.filter(p => p.level === 'error')).toEqual([]);

    const pending = (await http().get(api('/admin/topic-versions')).set(auth(reviewer)).expect(200)).body.find((v: any) => v.curriculumId === 'PHY-05-06');
    let detail = (await http().get(api(`/admin/topic-versions/${pending.id}`)).set(auth(reviewer)).expect(200)).body;
    const flags = detail.version.flags;
    expect(flags.map((f: any) => [f.where, f.status])).toEqual([
      ['Extended › Pressure–volume loops', 'open'],
      ['Revision #2', 'open'],
      ['Question 3 · explanation', 'open'],
    ]);
    expect(flags[0].excerpt).toBe('Resistance rises with the fourth power of radius ⚑ check the exponent.');

    // Blocked: the version, and its flagged question on its own.
    expect((await http().post(api(`/admin/topic-versions/${pending.id}/transitions`)).set(auth(reviewer)).send({ action: 'approve' }).expect(409)).body.message).toMatch(/3 "⚑"/);
    const flaggedQuestion = flags[2].questionId;
    await http().post(api(`/admin/questions/${flaggedQuestion}/transitions`)).set(auth(reviewer)).send({ action: 'approve' }).expect(409);
    // Students can't resolve; a correction needs text.
    await http().post(api(`/admin/topic-versions/${pending.id}/flags/${flags[0].id}`)).set(auth(student)).send({ action: 'confirm' }).expect(403);
    await http().post(api(`/admin/topic-versions/${pending.id}/flags/${flags[0].id}`)).set(auth(reviewer)).send({ action: 'correct' }).expect(400);

    await http()
      .post(api(`/admin/topic-versions/${pending.id}/flags/${flags[0].id}`))
      .set(auth(reviewer))
      .send({ action: 'correct', text: 'Resistance is inversely proportional to the fourth power of the radius (Poiseuille).', note: 'Checked against standard references' })
      .expect(201);
    await http().post(api(`/admin/topic-versions/${pending.id}/flags/${flags[1].id}`)).set(auth(reviewer)).send({ action: 'remove' }).expect(201);
    const last = await http().post(api(`/admin/topic-versions/${pending.id}/flags/${flags[2].id}`)).set(auth(reviewer)).send({ action: 'confirm' }).expect(201);
    expect(last.body).toMatchObject({ status: 'confirmed', open: 0 });
    await http().post(api(`/admin/topic-versions/${pending.id}/flags/${flags[2].id}`)).set(auth(reviewer)).send({ action: 'confirm' }).expect(409);

    detail = (await http().get(api(`/admin/topic-versions/${pending.id}`)).set(auth(reviewer)).expect(200)).body;
    expect(detail.version.extended[0].body).toContain('inversely proportional to the fourth power');
    expect(detail.version.revision).toEqual(['S1 = AV valves close']);
    expect(detail.version.flags.every((f: any) => f.status !== 'open' && f.resolution.by === 'Rita Reviewer')).toBe(true);
    const q = await db().collection('questions').findOne({ _id: new (require('mongoose').Types.ObjectId)(flaggedQuestion) });
    expect(q!.explanation).not.toContain('⚑');
    expect(await db().collection('auditentries').countDocuments({ action: { $in: ['flag_corrected', 'flag_removed', 'flag_confirmed'] } })).toBe(3);

    await http().post(api(`/admin/topic-versions/${pending.id}/transitions`)).set(auth(reviewer)).send({ action: 'approve' }).expect(201);
  });
});

describe('school codes (editable) and contributors', () => {
  it('keeps verified codes, adds schools without guessing, validates modules', async () => {
    const c = (await http().get(api('/admin/curriculum/physiology')).set(auth(reviewer)).expect(200)).body;
    expect(c.schools.map((s: any) => s.key)).toEqual(['uniben', 'unilag']);
    expect(c.schools[1].courses).toEqual([]);

    await server.createStaff('admin@content.test', 'admin', 'Staff!2345', 'Ade Admin');
    const admin = (await http().post(api('/auth/login')).send({ email: 'admin@content.test', password: 'Staff!2345' }).expect(201)).body.accessToken;
    await http().put(api('/admin/curriculum/physiology/schools/unilag')).set(auth(admin)).send({ school: 'University of Lagos (UNILAG)', courses: [{ code: 'PHS 201', modules: ['PHY-99'] }] }).expect(400);
    const saved = (
      await http().put(api('/admin/curriculum/physiology/schools/unilag')).set(auth(admin)).send({ school: 'University of Lagos (UNILAG)', source: 'Ambassador outline', courses: [{ code: 'PHS 201', title: 'Cardiovascular', modules: ['PHY-05'] }] }).expect(200)
    ).body;
    expect(saved).toMatchObject({ key: 'unilag', verified: false, updatedBy: 'Ade Admin' });

    // A later import never overwrites a school an admin edited.
    await service().import(bundle(), { authorName: 'EdMira content library' });
    const after = (await http().get(api('/admin/curriculum/physiology')).set(auth(admin)).expect(200)).body;
    expect(after.schools.find((s: any) => s.key === 'unilag').courses[0].code).toBe('PHS 201');

    await http().delete(api('/admin/curriculum/physiology/schools/unilag')).set(auth(admin)).expect(200);
    expect(await db().collection('auditentries').countDocuments({ entity: 'curriculum' })).toBe(2);
  });

  it('a contributor needs permission on record; credited ones show on the topic', async () => {
    await server.createStaff('admin2@content.test', 'admin', 'Staff!2345', 'Bisi Admin');
    const admin = (await http().post(api('/auth/login')).send({ email: 'admin2@content.test', password: 'Staff!2345' }).expect(201)).body.accessToken;
    await http().post(api('/admin/contributors')).set(auth(admin)).send({ key: 'dr-eze', name: 'Dr C. Eze', permissionGranted: true }).expect(400); // what they agreed to
    await http().post(api('/admin/contributors')).set(auth(admin)).send({ key: 'dr-ojo', name: 'Dr T. Ojo', permissionGranted: false }).expect(201);
    await http()
      .post(api('/admin/contributors'))
      .set(auth(admin))
      .send({ key: 'dr-eze', name: 'Dr C. Eze', permissionGranted: true, permissionText: 'Signed contributor agreement, 12 Nov 2026 (Drive › Contributors)', credit: true, creditName: 'Dr C. Eze (UNIBEN)' })
      .expect(201);

    const noPermission = bundle();
    noPermission.topics = [{ ...noPermission.topics[1], text: noPermission.topics[1].text.replace('summary:', 'contributors: dr-ojo\nsummary:') }];
    expect((await service().import(noPermission, { authorName: 'x' })).problems.some(p => /dr-ojo.*permission/.test(p.message))).toBe(true);

    const credited = bundle();
    credited.topics = [{ ...credited.topics[1], text: credited.topics[1].text.replace('summary:', 'contributors: dr-eze\nsummary:') }];
    const r = await service().import(credited, { authorName: 'x' });
    expect(r.problems.filter(p => p.level === 'error')).toEqual([]);
    const v = await db().collection('topic_versions').findOne({ curriculumId: 'PHY-05-06', status: 'in_review' });
    await http().post(api(`/admin/topic-versions/${v!._id}/transitions`)).set(auth(reviewer)).send({ action: 'approve' }).expect(201);
    const topic = await db().collection('topics').findOne({ curriculumId: 'PHY-05-06' });
    expect(topic).toMatchObject({ status: 'published', credits: ['Dr C. Eze (UNIBEN)'] });
  });
});
