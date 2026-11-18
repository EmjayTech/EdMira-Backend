import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { importContent, LIBRARY_AUTHOR_NAME } from '../src/admin/content-import';
import { ContentService } from '../src/content/content.service';
import { applyPhysiologyModules, planPhysiologyModules, undoPhysiologyModules } from '../src/content/physiology-modules';
import { startInMemoryApp } from './support/in-memory-app';

/** Physiology school courses → modules: dry run changes nothing, apply keeps history attached, undo restores exactly. */

jest.setTimeout(180_000);

let server: Awaited<ReturnType<typeof startInMemoryApp>>;
const db = () => server.connection;
const col = (n: string) => db().collection(n);
const outline = JSON.parse(readFileSync(join(__dirname, '../../Desktop/EdMira Mobile1.0/EdMira-MobileApp/content-import/curriculum/physiology_outline.json'), 'utf8'));

const snapshot = async () => {
  const pick = async (n: string, fields: string[]) =>
    (await col(n).find({}).sort({ _id: 1 }).toArray()).map(d => Object.fromEntries(['_id', ...fields].map(f => [f, d[f] === undefined ? undefined : String(d[f])])));
  return {
    courses: await pick('courses', ['status', 'replacedBy']),
    topics: await pick('topics', ['courseId', 'order', 'curriculumId']),
    attempts: await pick('quizattempts', ['courseId', 'courseTitle']),
    stats: await pick('topic_stats', ['courseId', 'courseTitle']),
    resources: await pick('resources', ['courseId']),
    groups: await pick('study_groups', ['courseId']),
  };
};

beforeAll(async () => {
  server = await startInMemoryApp();
  const dir = join(__dirname, '../content-library/import');
  const model = (name: string) => server.app.get(getModelToken(name));
  const models = { courses: model('Course'), topics: model('Topic'), questions: model('Question'), resources: model('Resource') };
  for (const file of readdirSync(dir).filter(f => /^(200|300|400)-pio/.test(f))) {
    await importContent(models as never, JSON.parse(readFileSync(join(dir, file), 'utf8')).courses, { name: LIBRARY_AUTHOR_NAME }, { publishNewCourses: true });
  }
  // A student's history on an old course: an attempt, a topic stat, a study group.
  const course = await col('courses').findOne({ code: 'PIO214' });
  const topic = await col('topics').findOne({ courseId: course!._id, title: 'Blood Pressure and Circulation' });
  const user = new Types.ObjectId();
  await col('quizattempts').insertOne({ userId: user, topicId: topic!._id, courseId: course!._id, courseTitle: course!.title, score: 7, total: 10 });
  await col('topic_stats').insertOne({ userId: user, topicId: topic!._id, courseId: course!._id, courseTitle: course!.title, attempts: 1 });
  await col('study_groups').insertOne({ name: 'CVS gang', courseId: course!._id });
});

afterAll(async () => server?.stop());

it('dry run reports every topic, nothing unmatched, and changes nothing', async () => {
  const before = await snapshot();
  const plan = await planPhysiologyModules(db(), outline);
  expect(plan.unmatched).toEqual([]);
  expect(plan.moves).toHaveLength(30);
  expect(plan.totals).toMatchObject({ attempts: 1, topicStats: 1, groups: 1 });
  expect(await snapshot()).toEqual(before);
});

it('apply moves topics and their history to modules; undo restores everything exactly', async () => {
  const before = await snapshot();
  await applyPhysiologyModules(db(), outline, await planPhysiologyModules(db(), outline));

  const cvs = await col('courses').findOne({ moduleId: 'PHY-05' });
  expect(cvs).toMatchObject({ subject: 'Physiology', shortName: 'Cardiovascular', status: 'published' });
  expect(cvs!.code).toBeUndefined();
  const topic = await col('topics').findOne({ title: 'Blood Pressure and Circulation' });
  expect(topic).toMatchObject({ courseId: cvs!._id, curriculumId: 'PHY-05-07' });
  expect(await col('quizattempts').findOne({ topicId: topic!._id })).toMatchObject({ courseId: cvs!._id, courseTitle: cvs!.title });
  expect(await col('topic_stats').findOne({ topicId: topic!._id })).toMatchObject({ courseId: cvs!._id });
  const old = await col('courses').findOne({ code: 'PIO214' });
  expect(old).toMatchObject({ status: 'archived' });
  expect(old!.replacedBy).toHaveLength(2);
  expect((await col('study_groups').findOne({ name: 'CVS gang' }))!.courseId).toEqual(cvs!._id);
  expect(await col('topics').countDocuments({ courseId: old!._id })).toBe(0);

  // A second run is refused; the plan says it's done.
  const again = await planPhysiologyModules(db(), outline);
  expect(again.alreadyDone).toBe(true);
  await expect(applyPhysiologyModules(db(), outline, again)).rejects.toThrow(/Already applied/);

  await undoPhysiologyModules(db());
  expect(await col('courses').countDocuments({ moduleId: { $exists: true } })).toBe(0);
  expect(await snapshot()).toEqual(before);
});

it('students see modules without codes; chips and code search use only their school\'s verified codes; old links redirect', async () => {
  await applyPhysiologyModules(db(), outline, await planPhysiologyModules(db(), outline));
  await col('topics').updateMany({}, { $set: { status: 'published' } });
  await col('questions').updateMany({}, { $set: { status: 'published' } });
  await col('curricula').insertOne({ subject: 'Physiology', version: outline.version, modules: [], schools: outline.school_codes });
  const content = server.app.get(ContentService);
  const aau = { level: '200 Level', department: 'Medicine & Surgery (MBBS)', institution: 'Ambrose Alli University, Ekpoma' };
  const unilag = { level: '200 Level', department: 'Medicine & Surgery (MBBS)', institution: 'University of Lagos' };

  const list = await content.listCourses(aau);
  const cvs = list.find(c => 'moduleId' in c && c.moduleId === 'PHY-05')!;
  expect(cvs).toMatchObject({ subject: 'Physiology', shortName: 'Cardiovascular', forYou: true, schoolChip: { school: 'AAU', codes: ['PHS 203'] } });
  expect('code' in cvs).toBe(false);
  expect(list.some(c => 'code' in c && c.code === 'PIO214')).toBe(false);
  // UNILAG has no verified mapping: no chip, ever.
  expect((await content.listCourses(unilag)).some(c => 'schoolChip' in c)).toBe(false);
  // Level is a recommendation: 300L modules are still listed for a 200L student.
  expect(list.find(c => 'moduleId' in c && c.moduleId === 'PHY-11')).toMatchObject({ forYou: false });

  const hit = await content.search('PHS 201', aau);
  expect(hit.courses.map(c => ('moduleId' in c ? c.moduleId : ''))).toEqual(['PHY-02']);
  expect(hit.topics.length).toBeGreaterThan(0);
  expect((await content.search('PHS 201', unilag)).courses).toEqual([]);
  // National NUC CCMAS codes work for everyone.
  expect((await content.search('PIO 214', unilag)).courses.map(c => ('moduleId' in c ? c.moduleId : '')).sort()).toEqual(['PHY-05', 'PHY-06']);

  const old = await col('courses').findOne({ code: 'PIO214' });
  const moved = await content.getCourse(String(old!._id), aau);
  expect('replacedBy' in moved && moved.replacedBy.map(m => m.shortName).sort()).toEqual(['Cardiovascular', 'Respiratory']);
});

it('a quiz draws up to 20 from a big bank: unseen first, then missed; retry gets exactly its ids', async () => {
  const content = server.app.get(ContentService);
  const topic = await col('topics').findOne({ title: 'Blood Pressure and Circulation' });
  await col('questions').insertMany(
    Array.from({ length: 40 }, (_, i) => ({
      topicId: topic!._id,
      stem: `Bank question ${i}?`,
      options: ['a', 'b', 'c', 'd'],
      answerIndex: 0,
      explanation: 'x',
      status: 'published',
      createdAt: new Date(),
    })),
  );
  const bank = await content.getQuizQuestions(String(topic!._id));
  expect(bank.length).toBeGreaterThan(40);
  const user = new Types.ObjectId();
  const first = await content.getQuizSet(String(topic!._id), String(user));
  expect(first).toHaveLength(20);
  // The student has now seen these 20 (all wrong): the next quiz shows unseen ones only.
  await col('quizattempts').insertOne({ studentId: user, topicId: topic!._id, submittedAt: new Date(), answers: first.map(q => ({ questionId: new Types.ObjectId(q.id), correct: false })) });
  const second = await content.getQuizSet(String(topic!._id), String(user));
  const seen = new Set(first.map(q => q.id));
  expect(second.filter(q => seen.has(q.id))).toHaveLength(Math.max(0, 20 - (bank.length - 20)));
  const retry = await content.getQuizSet(String(topic!._id), String(user), first.slice(0, 3).map(q => q.id));
  expect(retry.map(q => q.id).sort()).toEqual(first.slice(0, 3).map(q => q.id).sort());
});
