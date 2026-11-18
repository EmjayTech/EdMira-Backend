import { Connection, Types } from 'mongoose';
import { Department } from '../common/enum/department.enum';
import type { Outline } from './notes-format';

/**
 * ─── Physiology: from school courses to Subject → Module → Topic ────────────
 *
 * Each outline module (PHY-01 … PHY-13) becomes a "module" course record
 * (subject, moduleId, shortName, icon; no code). Physiology topics move from
 * the old school courses (PIO 201, 214 …) into their modules. Topic ids never
 * change, so questions, quiz attempts, Focus Areas, progress and Continue
 * learning keep working; the copies of the course id/title stored with
 * attempts, topic stats, materials and study groups are updated. The old
 * courses are archived (not deleted) and point to their modules. Every change
 * is logged so `undo` puts everything back.
 *
 * Works on the raw collections (no app modules), so it runs from a script.
 */

const KEY = 'physiology-modules';
const SUBJECT = 'Physiology';

/** Card label, icon and colour per module. */
const MODULE_META: Record<string, { shortName: string; icon: string; color: string }> = {
  'PHY-01': { shortName: 'General', icon: 'cell', color: '#2A4FE0' },
  'PHY-02': { shortName: 'Blood', icon: 'drop', color: '#B91C1C' },
  'PHY-03': { shortName: 'Nerve & Muscle', icon: 'nerve', color: '#7C3AED' },
  'PHY-04': { shortName: 'Autonomic', icon: 'nodes', color: '#0F766E' },
  'PHY-05': { shortName: 'Cardiovascular', icon: 'heart', color: '#C2410C' },
  'PHY-06': { shortName: 'Respiratory', icon: 'lungs', color: '#0369A1' },
  'PHY-07': { shortName: 'Renal', icon: 'kidney', color: '#A16207' },
  'PHY-08': { shortName: 'Gastrointestinal', icon: 'gut', color: '#15803D' },
  'PHY-09': { shortName: 'Endocrine', icon: 'gland', color: '#BE185D' },
  'PHY-10': { shortName: 'Reproductive', icon: 'repro', color: '#9333EA' },
  'PHY-11': { shortName: 'Neurophysiology', icon: 'brain', color: '#1D4ED8' },
  'PHY-12': { shortName: 'Special Senses', icon: 'eye', color: '#0E7490' },
  'PHY-13': { shortName: 'Applied', icon: 'activity', color: '#4D7C0F' },
};

/**
 * Existing topics the outline doesn't map one-to-one, and where they go
 * (approved with the restructure plan): by course code, then title (or "*").
 */
const FALLBACK: { course: string; title: string; module: string }[] = [
  { course: 'PIO305', title: 'The Autonomic Nervous System', module: 'PHY-04' },
  { course: 'PIO414', title: '*', module: 'PHY-13' },
];

/** Programmes that need each module (outline "programmes"), as audience departments: a recommendation only. */
const ALL_MODULES = [Department.MBBS, Department.BDS, Department.PHYSIOLOGY, Department.PHYSIOTHERAPY];
const CORE_MODULES = [Department.NURSING_SCIENCE, Department.MEDICAL_LABORATORY_SCIENCE, Department.PHARMACY, Department.RADIOGRAPHY];

const codeKey = (s?: string | null) => (s ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase();
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** "200L–300L" → ["200 Level", "300 Level"] */
export function levelsOf(typical?: string): string[] {
  const nums = [...(typical ?? '').matchAll(/(\d00)\s*L/gi)].map(m => Number(m[1]));
  if (nums.length === 2) {
    const out: string[] = [];
    for (let n = nums[0]; n <= nums[1]; n += 100) out.push(`${n} Level`);
    return out;
  }
  return nums.map(n => `${n} Level`);
}

export function audienceFor(moduleId: string, typical?: string) {
  const n = Number(moduleId.slice(-2));
  const departments = [...ALL_MODULES, ...(n <= 12 ? CORE_MODULES : [])];
  return levelsOf(typical).flatMap(level => departments.map(department => ({ level, department })));
}

interface TopicMove {
  topicId: Types.ObjectId;
  title: string;
  status: string;
  fromCourse: string;
  fromCourseId: Types.ObjectId | null;
  fromCourseTitle: string;
  oldOrder: number;
  oldCurriculumId: string | null;
  module: string;
  curriculumId: string | null;
  order: number;
  how: 'curriculum id' | 'outline mapping' | 'fallback';
  attempts: number;
  topicStats: number;
  materials: number;
}

export interface MigrationPlan {
  modules: { id: string; title: string; shortName: string; exists: boolean; topics: number; levels: string[] }[];
  moves: TopicMove[];
  unmatched: { title: string; course: string; reason: string }[];
  courseMaterials: { id: string; title: string; fromCourse: string; module: string }[];
  groups: { id: string; name: string; fromCourse: string; module: string }[];
  oldCourses: { code: string; title: string; status: string; replacedBy: string[] }[];
  totals: { topics: number; questions: number; attempts: number; topicStats: number; materials: number; groups: number };
  alreadyDone: boolean;
}

export async function planPhysiologyModules(db: Connection, outline: Outline): Promise<MigrationPlan> {
  const c = (name: string) => db.collection(name);
  const outlineTopics = new Map<string, { module: string; order: number; course: string; existing: string | null }>();
  for (const m of outline.modules) {
    for (const t of m.topics) outlineTopics.set(t.id, { module: m.id, order: t.order, course: codeKey(t.edmira.course), existing: t.edmira.existing_topic });
  }
  const oldCodes = new Set(outline.modules.flatMap(m => m.topics.map(t => codeKey(t.edmira.course))).concat(FALLBACK.map(f => f.course)));

  const courses = await c('courses').find({}).project({ title: 1, code: 1, status: 1, moduleId: 1, replacedBy: 1 }).toArray();
  const oldCourses = courses.filter(x => !x.moduleId && oldCodes.has(codeKey(x.code)));
  const courseById = new Map(courses.map(x => [String(x._id), x]));
  const existingModules = new Map(courses.filter(x => x.moduleId).map(x => [x.moduleId as string, x]));

  const topics = await c('topics')
    .find({ $or: [{ courseId: { $in: oldCourses.map(x => x._id) } }, { curriculumId: /^PHY-/ }] })
    .project({ title: 1, courseId: 1, order: 1, status: 1, curriculumId: 1 })
    .toArray();

  const moves: TopicMove[] = [];
  const unmatched: MigrationPlan['unmatched'] = [];
  for (const t of topics) {
    const course = courseById.get(String(t.courseId));
    if (course?.moduleId) continue; // already in a module
    const code = codeKey(course?.code);
    let module: string | null = null;
    let curriculumId: string | null = (t.curriculumId as string) ?? null;
    let order = 100 + (Number(t.order) || 0);
    let how: TopicMove['how'] = 'curriculum id';

    if (curriculumId && outlineTopics.has(curriculumId)) {
      const o = outlineTopics.get(curriculumId)!;
      module = o.module;
      order = o.order;
    } else {
      const byTitle = [...outlineTopics.entries()].find(([, o]) => o.existing && o.course === code && norm(o.existing) === norm(t.title));
      if (byTitle) {
        [curriculumId, { module, order }] = [byTitle[0], byTitle[1]];
        how = 'outline mapping';
      } else {
        const fb = FALLBACK.find(f => f.course === code && (f.title === '*' || norm(f.title) === norm(t.title)));
        if (fb) {
          module = fb.module;
          how = 'fallback';
        }
      }
    }
    if (!module) {
      unmatched.push({ title: t.title, course: course?.code ?? '—', reason: 'Not in the outline and no fallback rule' });
      continue;
    }
    const [attempts, topicStats, materials] = await Promise.all([
      c('quizattempts').countDocuments({ topicId: t._id }),
      c('topic_stats').countDocuments({ topicId: t._id }),
      c('resources').countDocuments({ topicId: t._id }),
    ]);
    moves.push({
      topicId: t._id as Types.ObjectId,
      title: t.title,
      status: t.status,
      fromCourse: course?.code ?? '—',
      fromCourseId: (course?._id as Types.ObjectId) ?? null,
      fromCourseTitle: course?.title ?? '',
      oldOrder: Number(t.order) || 0,
      oldCurriculumId: (t.curriculumId as string) ?? null,
      module,
      curriculumId,
      order,
      how,
      attempts,
      topicStats,
      materials,
    });
  }

  // Where an old course's whole-course materials and groups go: the module most of its topics went to.
  const mainModule = (courseId: string) => {
    const counts = new Map<string, number>();
    for (const m of moves) if (String(m.fromCourseId) === courseId) counts.set(m.module, (counts.get(m.module) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const courseMaterials: MigrationPlan['courseMaterials'] = [];
  const groups: MigrationPlan['groups'] = [];
  for (const oc of oldCourses) {
    const module = mainModule(String(oc._id));
    if (!module) continue;
    for (const r of await c('resources').find({ courseId: oc._id, topicId: { $exists: false } }).project({ title: 1 }).toArray()) {
      courseMaterials.push({ id: String(r._id), title: r.title, fromCourse: oc.code, module });
    }
    for (const r of await c('resources').find({ courseId: oc._id, topicId: null }).project({ title: 1 }).toArray()) {
      if (!courseMaterials.some(x => x.id === String(r._id))) courseMaterials.push({ id: String(r._id), title: r.title, fromCourse: oc.code, module });
    }
    for (const g of await c('study_groups').find({ courseId: oc._id }).project({ name: 1 }).toArray()) {
      groups.push({ id: String(g._id), name: g.name, fromCourse: oc.code, module });
    }
  }

  const questions = moves.length ? await c('questions').countDocuments({ topicId: { $in: moves.map(m => m.topicId) } }) : 0;
  const modules = outline.modules.map(m => ({
    id: m.id,
    title: m.title,
    shortName: MODULE_META[m.id]?.shortName ?? m.title,
    exists: existingModules.has(m.id),
    topics: moves.filter(x => x.module === m.id).length,
    levels: levelsOf(m.typical_level),
  }));
  return {
    modules,
    moves,
    unmatched,
    courseMaterials,
    groups,
    oldCourses: oldCourses.map(oc => ({
      code: oc.code,
      title: oc.title,
      status: oc.status,
      replacedBy: [...new Set(moves.filter(m => String(m.fromCourseId) === String(oc._id)).map(m => m.module))],
    })),
    totals: {
      topics: moves.length,
      questions,
      attempts: moves.reduce((n, m) => n + m.attempts, 0),
      topicStats: moves.reduce((n, m) => n + m.topicStats, 0),
      materials: moves.reduce((n, m) => n + m.materials, 0) + courseMaterials.length,
      groups: groups.length,
    },
    alreadyDone: !!(await c('migrations').findOne({ key: KEY, undoneAt: { $exists: false } })),
  };
}

/** Apply a plan. Everything changed is logged in `migrations` so undo can restore it. */
export async function applyPhysiologyModules(db: Connection, outline: Outline, plan: MigrationPlan) {
  if (plan.alreadyDone) throw new Error('Already applied. Run with --undo first to apply it again.');
  const c = (name: string) => db.collection(name);
  const now = new Date();

  // 1. Module records (published; open to everyone; audience = recommendation).
  const moduleIds = new Map<string, Types.ObjectId>();
  const created: string[] = [];
  for (const m of outline.modules) {
    const meta = MODULE_META[m.id] ?? { shortName: m.title, icon: 'book', color: '#2A4FE0' };
    const existing = await c('courses').findOne({ moduleId: m.id });
    if (existing) {
      moduleIds.set(m.id, existing._id as Types.ObjectId);
      continue;
    }
    const res = await c('courses').insertOne({
      title: m.title,
      description: '',
      color: meta.color,
      audience: audienceFor(m.id, m.typical_level),
      status: 'published',
      subject: SUBJECT,
      moduleId: m.id,
      shortName: meta.shortName,
      icon: meta.icon,
      typicalLevels: levelsOf(m.typical_level),
      createdAt: now,
      updatedAt: now,
    });
    moduleIds.set(m.id, res.insertedId);
    created.push(String(res.insertedId));
  }
  const moduleTitle = new Map(outline.modules.map(m => [m.id, m.title]));

  // 2. Topics and everything that stores a copy of their course.
  for (const mv of plan.moves) {
    const to = moduleIds.get(mv.module)!;
    const title = moduleTitle.get(mv.module)!;
    await c('topics').updateOne({ _id: mv.topicId }, { $set: { courseId: to, order: mv.order, ...(mv.curriculumId ? { curriculumId: mv.curriculumId } : {}), updatedAt: now } });
    await c('quizattempts').updateMany({ topicId: mv.topicId }, { $set: { courseId: to, courseTitle: title } });
    await c('topic_stats').updateMany({ topicId: mv.topicId }, { $set: { courseId: to, courseTitle: title } });
    await c('resources').updateMany({ topicId: mv.topicId }, { $set: { courseId: to } });
  }
  for (const r of plan.courseMaterials) await c('resources').updateOne({ _id: new Types.ObjectId(r.id) }, { $set: { courseId: moduleIds.get(r.module) } });
  for (const g of plan.groups) await c('study_groups').updateOne({ _id: new Types.ObjectId(g.id) }, { $set: { courseId: moduleIds.get(g.module) } });

  // 3. Old school courses: archived, pointing at their modules (old links on phones can redirect).
  const oldCourseLog: { code: string; id: string; status: string }[] = [];
  for (const oc of plan.oldCourses) {
    const doc = await c('courses').findOne({ code: oc.code, moduleId: { $exists: false } });
    if (!doc) continue;
    oldCourseLog.push({ code: oc.code, id: String(doc._id), status: doc.status });
    await c('courses').updateOne({ _id: doc._id }, { $set: { status: 'archived', replacedBy: oc.replacedBy.map(m => String(moduleIds.get(m))), updatedAt: now } });
  }

  await c('migrations').insertOne({
    key: KEY,
    at: now,
    createdModules: created,
    topics: plan.moves.map(m => ({
      topicId: String(m.topicId),
      oldCourseId: m.fromCourseId ? String(m.fromCourseId) : null,
      oldCourseTitle: m.fromCourseTitle,
      oldOrder: m.oldOrder,
      oldCurriculumId: m.oldCurriculumId,
    })),
    courseMaterials: plan.courseMaterials.map(r => ({ id: r.id, oldCode: r.fromCourse })),
    groups: plan.groups.map(g => ({ id: g.id, oldCode: g.fromCourse })),
    oldCourses: oldCourseLog,
  });
  return { modulesCreated: created.length, topicsMoved: plan.moves.length };
}

/** Put everything back as it was before `apply`. */
export async function undoPhysiologyModules(db: Connection) {
  const c = (name: string) => db.collection(name);
  const log = await c('migrations').findOne({ key: KEY, undoneAt: { $exists: false } }, { sort: { at: -1 } });
  if (!log) throw new Error('Nothing to undo.');
  const oldCourseId = new Map<string, string>((log.oldCourses ?? []).map((o: { code: string; id: string }) => [o.code, o.id]));

  for (const t of log.topics) {
    const id = new Types.ObjectId(t.topicId);
    const back = t.oldCourseId ? new Types.ObjectId(t.oldCourseId) : null;
    await c('topics').updateOne(
      { _id: id },
      { $set: { ...(back ? { courseId: back } : {}), order: t.oldOrder }, ...(t.oldCurriculumId ? {} : { $unset: { curriculumId: '' } }) },
    );
    if (t.oldCurriculumId) await c('topics').updateOne({ _id: id }, { $set: { curriculumId: t.oldCurriculumId } });
    if (back) {
      await c('quizattempts').updateMany({ topicId: id }, { $set: { courseId: back, courseTitle: t.oldCourseTitle } });
      await c('topic_stats').updateMany({ topicId: id }, { $set: { courseId: back, courseTitle: t.oldCourseTitle } });
      await c('resources').updateMany({ topicId: id }, { $set: { courseId: back } });
    }
  }
  for (const r of log.courseMaterials ?? []) {
    const back = oldCourseId.get(r.oldCode);
    if (back) await c('resources').updateOne({ _id: new Types.ObjectId(r.id) }, { $set: { courseId: new Types.ObjectId(back) } });
  }
  for (const g of log.groups ?? []) {
    const back = oldCourseId.get(g.oldCode);
    if (back) await c('study_groups').updateOne({ _id: new Types.ObjectId(g.id) }, { $set: { courseId: new Types.ObjectId(back) } });
  }
  for (const o of log.oldCourses ?? []) {
    await c('courses').updateOne({ _id: new Types.ObjectId(o.id) }, { $set: { status: o.status }, $unset: { replacedBy: '' } });
  }
  // Modules this run created go, unless something new was added to them since.
  let removed = 0;
  for (const id of log.createdModules ?? []) {
    const _id = new Types.ObjectId(id);
    if (!(await c('topics').countDocuments({ courseId: _id }))) {
      await c('courses').deleteOne({ _id });
      removed++;
    }
  }
  await c('migrations').updateOne({ _id: log._id }, { $set: { undoneAt: new Date() } });
  return { topicsRestored: log.topics.length, modulesRemoved: removed };
}

/** The dry-run report, for people. */
export function formatPlan(p: MigrationPlan): string {
  const L: string[] = [];
  L.push(`PHYSIOLOGY → MODULES: ${p.alreadyDone ? 'ALREADY APPLIED (run --undo to reverse)' : 'dry run'}`);
  L.push('');
  L.push('Modules (13, open to everyone; level = recommendation):');
  for (const m of p.modules) L.push(`  ${m.id}  ${m.shortName.padEnd(17)} ${m.exists ? 'exists      ' : 'will create '} ${String(m.topics).padStart(2)} topics moving in · recommended ${m.levels.join(', ') || '—'}`);
  L.push('');
  L.push('Topics (id unchanged; history follows automatically):');
  for (const m of [...p.moves].sort((a, b) => a.module.localeCompare(b.module) || a.order - b.order)) {
    L.push(
      `  ${m.fromCourse.padEnd(7)} "${m.title}" → ${m.module}${m.curriculumId ? ` (${m.curriculumId})` : ''} [${m.how}; ${m.status}] · ${m.attempts} attempts, ${m.topicStats} topic stats, ${m.materials} materials`,
    );
  }
  L.push('');
  L.push(`Whole-course materials moving: ${p.courseMaterials.length}`);
  for (const r of p.courseMaterials) L.push(`  ${r.fromCourse} "${r.title}" → ${r.module}`);
  L.push(`Study groups re-linked: ${p.groups.length}`);
  for (const g of p.groups) L.push(`  ${g.fromCourse} "${g.name}" → ${g.module}`);
  L.push('');
  L.push('Old school courses (archived, not deleted; old links redirect to their modules):');
  for (const oc of p.oldCourses) L.push(`  ${oc.code} "${oc.title}" (${oc.status}) → ${oc.replacedBy.join(', ') || 'no topics'}`);
  L.push('');
  L.push(`UNMATCHED (left where they are): ${p.unmatched.length}`);
  for (const u of p.unmatched) L.push(`  ${u.course} "${u.title}": ${u.reason}`);
  L.push('');
  const t = p.totals;
  L.push(`Totals: ${t.topics} topics (${t.questions} questions) · ${t.attempts} quiz attempts · ${t.topicStats} topic stats · ${t.materials} materials · ${t.groups} groups`);
  return L.join('\n');
}
