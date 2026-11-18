import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ContentStatus } from '../common/enum/content-status.enum';
import { can } from '../admin/permissions';
import type { Staff } from '../admin/staff.guard';
import {
  FIGURE_TYPES,
  FormatProblem,
  MAX_FIGURE_BYTES,
  OriginalityFlag,
  Outline,
  ParsedQuestion,
  ParsedTopic,
  SchoolCodes,
  checkTopic,
  findFlags,
  resolveIn,
  contentHash,
  figureTypeOk,
  originality,
  parseQuestions,
  parseTopic,
  sha,
} from './notes-format';
import { ContentAsset, ContentAssetDocument } from './schemas/content-asset.schema';
import { Contributor, ContributorDocument } from './schemas/contributor.schema';
import { Course, CourseDocument } from './schemas/course.schema';
import { Curriculum, CurriculumDocument } from './schemas/curriculum.schema';
import { Question, QuestionDocument } from './schemas/question.schema';
import { Topic, TopicDocument } from './schemas/topic.schema';
import { TopicVersion, TopicVersionDocument } from './schemas/topic-version.schema';

/** A subject folder read into memory (by `yarn content:notes`, or an upload later). */
export interface ContentBundle {
  /** e.g. "content-import/physiology" */
  source: string;
  outline: Outline;
  /** Topic files: path → text, plus the matching .mcq.json if any. */
  topics: { path: string; text: string; questions?: string }[];
  /** "figures/nephron.svg" → bytes */
  files: Record<string, Buffer>;
  /** Stock phrases reviewers have flagged (content-import/originality-phrases.txt). */
  phrases?: string[];
}

export interface ImportReport {
  dryRun: boolean;
  imported: boolean;
  topics: { created: string[]; newVersions: string[]; unchanged: string[] };
  questions: number;
  figures: { stored: number; reused: number };
  originalityFlags: number;
  problems: FormatProblem[];
}

type VersionAction = 'approve' | 'request_changes' | 'reject' | 'restore';

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const codeKey = (s?: string | null) => (s ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase();
const plainSections = (secs?: { heading: string; body: string; keyPoints?: string[] }[]) =>
  (secs ?? []).map(({ heading, body, keyPoints }) => ({ heading, body, ...(keyPoints?.length ? { keyPoints: [...keyPoints] } : {}) }));
const plainFigures = (figs?: Topic['figures']) =>
  (figs ?? []).map(f => ({
    key: f.key,
    label: f.label,
    caption: f.caption,
    alt: f.alt,
    source: f.source,
    licence: f.licence,
    attributionText: f.attributionText,
    ...(f.originalUrl ? { originalUrl: f.originalUrl } : {}),
    modified: !!f.modified,
    assetId: f.assetId,
    mimeType: f.mimeType,
  }));
const PENDING = ['in_review', 'changes_requested'];
const textOf = (t: { material?: { heading: string; body: string }[]; extended?: { heading: string; body: string }[]; clinical?: { heading: string; body: string }[] }) =>
  [...(t.material ?? []), ...(t.extended ?? []), ...(t.clinical ?? [])].map(s => s.body).join('\n\n');

/**
 * Versioned study notes: import as drafts, review, publish, roll back.
 *
 * - Importing never touches live notes. Each changed topic gets a version
 *   "in_review" with its questions (Question.topicVersion = N, also in the
 *   usual question review queue). A version still waiting for review is
 *   replaced by a newer import. Unchanged files add nothing.
 * - Approving version N copies it onto the topic (live), publishes its
 *   remaining questions, retires the previous version's questions (archived,
 *   never deleted — students' quiz history keeps working) and marks the old
 *   version "superseded". Restoring a superseded version does the reverse.
 * - Version 0 is a snapshot of a topic's notes from before versioning.
 * - Courses aren't created here: each module maps to an existing course.
 */
@Injectable()
export class TopicVersionsService {
  constructor(
    @InjectModel(Course.name) private readonly courses: Model<CourseDocument>,
    @InjectModel(Topic.name) private readonly topics: Model<TopicDocument>,
    @InjectModel(Question.name) private readonly questions: Model<QuestionDocument>,
    @InjectModel(TopicVersion.name) private readonly versions: Model<TopicVersionDocument>,
    @InjectModel(ContentAsset.name) private readonly assets: Model<ContentAssetDocument>,
    @InjectModel(Curriculum.name) private readonly curricula: Model<CurriculumDocument>,
    @InjectModel(Contributor.name) private readonly contributors: Model<ContributorDocument>,
  ) {}

  // ── Import ────────────────────────────────────────────────────────────────

  async import(bundle: ContentBundle, opts: { dryRun?: boolean; authorName: string }): Promise<ImportReport> {
    const report: ImportReport = {
      dryRun: !!opts.dryRun,
      imported: false,
      topics: { created: [], newVersions: [], unchanged: [] },
      questions: 0,
      figures: { stored: 0, reused: 0 },
      originalityFlags: 0,
      problems: [],
    };
    const problems = report.problems;
    const outline = bundle.outline;

    // The outline: every topic ID → its module, order and EdMira course / topic.
    const where = new Map<string, { moduleIndex: number; module: Outline['modules'][number]; topic: Outline['modules'][number]['topics'][number] }>();
    outline.modules.forEach((m, moduleIndex) => m.topics.forEach(topic => where.set(topic.id, { moduleIndex, module: m, topic })));
    // Only the courses this import's topic files belong to need to exist.
    const usedIds = new Set(bundle.topics.map(f => parseTopic(f.text).id));
    const courseCodes = [...new Set(outline.modules.flatMap(m => m.topics.filter(t => usedIds.has(t.id)).map(t => codeKey(t.edmira.course))))];
    // Each course's topics in curriculum order (modules in order, then topics).
    const courseSequence = new Map<string, string[]>();
    for (const m of outline.modules) {
      for (const t of m.topics) {
        const k = codeKey(t.edmira.course);
        courseSequence.set(k, [...(courseSequence.get(k) ?? []), t.id]);
      }
    }
    const courseDocs = await this.courses.find().select('code title moduleId').lean().exec();
    // After the module migration, topics go into their module (PHY-05 …); before it, into the school course.
    const moduleById = new Map(courseDocs.filter(c => c.moduleId).map(c => [c.moduleId as string, c]));
    const courseByCode = new Map<string, (typeof courseDocs)[number]>();
    for (const code of courseCodes) {
      const doc = courseDocs.find(c => !c.moduleId && codeKey(c.code) === code);
      if (doc) courseByCode.set(code, doc);
    }
    for (const m of outline.modules) {
      for (const t of m.topics.filter(t => usedIds.has(t.id))) {
        if (!moduleById.has(m.id) && !courseByCode.has(codeKey(t.edmira.course))) {
          problems.push({ where: 'outline', message: `${t.id}: neither module ${m.id} nor course ${t.edmira.course} is in the app (load content-library first).`, level: 'error' });
        }
      }
    }
    const targetOf = (place: { module: Outline['modules'][number]; topic: Outline['modules'][number]['topics'][number] }) => {
      const mod = moduleById.get(place.module.id);
      if (mod) return { course: mod, order: place.topic.order };
      const k = codeKey(place.topic.edmira.course);
      return { course: courseByCode.get(k)!, order: (courseSequence.get(k) ?? []).indexOf(place.topic.id) + 1 };
    };

    // 1. Parse and check everything: nothing is saved if anything is wrong.
    type Item = {
      path: string;
      topic: ParsedTopic;
      questions: ParsedQuestion[];
      figureData: Record<string, { data: Buffer; mimeType: string; hash: string; name: string }>;
      contributorIds: string[];
      credits: string[];
    };
    const items: Item[] = [];
    const seen = new Set<string>();
    for (const file of bundle.topics) {
      const topic = parseTopic(file.text);
      problems.push(...checkTopic(topic, file.path, where.get(topic.id)?.topic));
      if (seen.has(topic.id)) problems.push({ where: file.path, message: `${topic.id} has two files.`, level: 'error' });
      seen.add(topic.id);

      let questions: ParsedQuestion[] = [];
      if (file.questions !== undefined) {
        let json: unknown;
        try {
          json = JSON.parse(file.questions);
        } catch (e) {
          problems.push({ where: `${file.path} questions`, message: `Not valid JSON: ${(e as Error).message}`, level: 'error' });
        }
        if (json !== undefined) {
          const r = parseQuestions(json, file.path.replace(/\.md$/, '.mcq.json'));
          questions = r.questions;
          problems.push(...r.problems);
        }
      } else problems.push({ where: file.path, message: 'No questions file (.mcq.json) yet.', level: 'warning' });

      const figureData: Item['figureData'] = {};
      for (const f of topic.figures) {
        const ext = f.file.split('.').pop()?.toLowerCase() ?? '';
        const mimeType = FIGURE_TYPES[ext];
        const data = bundle.files[f.file];
        if (!mimeType) problems.push({ where: file.path, message: `Figure "${f.key}": use SVG, PNG, JPEG or WebP.`, level: 'error' });
        else if (!data) problems.push({ where: file.path, message: `Figure "${f.key}": ${f.file} not found.`, level: 'error' });
        else if (data.length > MAX_FIGURE_BYTES) problems.push({ where: file.path, message: `Figure "${f.key}" is over 1 MB.`, level: 'error' });
        else if (!figureTypeOk(mimeType, data)) problems.push({ where: file.path, message: `Figure "${f.key}" isn't a safe ${ext.toUpperCase()} image.`, level: 'error' });
        else figureData[f.key] = { data, mimeType, hash: sha(data), name: f.file };
      }

      const contributorIds: string[] = [];
      const credits: string[] = [];
      for (const key of topic.contributors) {
        const c = await this.contributors.findOne({ key }).lean().exec();
        if (!c) problems.push({ where: file.path, message: `Contributor "${key}" isn't recorded (admin → Contributors).`, level: 'error' });
        else if (!c.permissionGranted) problems.push({ where: file.path, message: `Contributor "${key}" hasn't granted permission.`, level: 'error' });
        else {
          contributorIds.push(String(c._id));
          if (c.credit) credits.push(c.creditName || c.name);
        }
      }
      items.push({ path: file.path, topic, questions, figureData, contributorIds, credits });
    }

    // 2. Originality: compare each topic with every other EdMira topic (DB + this import).
    const dbTopics = await this.topics.find().select('title courseId curriculumId material extended clinical').lean().exec();
    const titleOfCourse = new Map(courseDocs.map(c => [String(c._id), c.code ?? c.title]));
    const flagsFor = new Map<string, OriginalityFlag[]>();
    for (const it of items) {
      const place = where.get(it.topic.id);
      const same = (t: (typeof dbTopics)[number]) =>
        t.curriculumId === it.topic.id || (!!place?.topic.edmira.existing_topic && norm(t.title) === norm(place.topic.edmira.existing_topic));
      const corpus = [
        ...dbTopics.filter(t => !same(t)).map(t => ({ label: `${titleOfCourse.get(String(t.courseId)) ?? ''} › ${t.title}`, text: textOf(t) })),
        ...items.filter(o => o !== it).map(o => ({ label: `${o.topic.id} (this import)`, text: textOf(o.topic) })),
      ];
      const sectionsOf = (label: string, secs: { heading: string; body: string }[]) => secs.map(s => ({ label: `${label} › ${s.heading}`, body: s.body }));
      const flags = originality(
        { id: it.topic.id, sections: [...sectionsOf('Notes', it.topic.material), ...sectionsOf('Extended', it.topic.extended), ...sectionsOf('Clinical', it.topic.clinical)] },
        corpus,
        bundle.phrases,
      );
      flagsFor.set(it.topic.id, flags);
      report.originalityFlags += flags.length;
      for (const f of flags) {
        problems.push({ where: it.path, message: `Originality: "${f.passage.slice(0, 80)}…" (${f.section}) closely matches ${f.matches} — rewrite it.`, level: 'warning' });
      }
    }
    if (problems.some(p => p.level === 'error')) return report;

    // 3. The curriculum (modules + verified school codes), editable in admin.
    if (!opts.dryRun) await this.saveCurriculum(outline);

    // 4. Topics, versions and questions.
    for (const it of items) {
      const place = where.get(it.topic.id)!;
      const { course, order } = targetOf(place);
      const label = `${course.moduleId ?? course.code} › ${it.topic.id} ${it.topic.title}`;
      const figureHashes = Object.fromEntries(Object.entries(it.figureData).map(([key, f]) => [key, f.hash]));
      const hash = contentHash(it.topic, figureHashes, it.questions);
      // The topic it updates: tagged with this id anywhere (it may have moved to a module), else the outline's existing topic.
      let topic =
        (await this.topics.findOne({ curriculumId: it.topic.id }).exec()) ??
        (place.topic.edmira.existing_topic
          ? await this.topics
              .findOne({ courseId: { $in: [course._id, courseByCode.get(codeKey(place.topic.edmira.course))?._id].filter(Boolean) }, title: new RegExp(`^${escapeRegex(place.topic.edmira.existing_topic)}$`, 'i') })
              .exec()
          : null);
      const latest = topic ? await this.versions.findOne({ topicId: topic._id }).sort({ version: -1 }).exec() : null;
      if (latest?.contentHash === hash) {
        report.topics.unchanged.push(label);
        continue;
      }
      (topic ? report.topics.newVersions : report.topics.created).push(label);
      report.questions += it.questions.length;
      if (opts.dryRun) {
        for (const f of Object.values(it.figureData)) (await this.assets.exists({ hash: f.hash })) ? report.figures.reused++ : report.figures.stored++;
        continue;
      }

      const figures = [];
      for (const [i, f] of it.topic.figures.entries()) {
        const d = it.figureData[f.key];
        const stored = await this.assets.updateOne(
          { hash: d.hash },
          { $setOnInsert: { hash: d.hash, mimeType: d.mimeType, size: d.data.length, data: d.data, name: d.name } },
          { upsert: true },
        );
        stored.upsertedCount ? report.figures.stored++ : report.figures.reused++;
        figures.push({
          key: f.key,
          label: `Figure ${place.moduleIndex + 1}.${place.topic.order}.${i + 1}`,
          caption: f.caption,
          alt: f.alt,
          source: f.source,
          licence: f.licence,
          attributionText: f.attributionText,
          ...(f.originalUrl ? { originalUrl: f.originalUrl } : {}),
          modified: f.modified,
          assetId: d.hash,
          mimeType: d.mimeType,
        });
      }
      const notes = {
        title: it.topic.title,
        summary: it.topic.summary,
        readMinutes: it.topic.readMinutes ?? estimateMinutes(it.topic),
        objectives: it.topic.objectives,
        keyPoints: it.topic.keyPoints,
        material: it.topic.material,
        extended: it.topic.extended,
        clinical: it.topic.clinical,
        revision: it.topic.revision,
        furtherReading: it.topic.furtherReading,
        figures,
        curriculumId: it.topic.id,
        order,
        contributorIds: it.contributorIds,
        credits: it.credits,
      };

      if (!topic) {
        // A new topic: a draft (hidden from students) whose version 1 goes to review.
        topic = await this.topics.create({ courseId: course._id, status: ContentStatus.DRAFT, createdByName: opts.authorName, ...notes });
      } else if (!topic.curriculumId) {
        await this.topics.updateOne({ _id: topic._id }, { $set: { curriculumId: it.topic.id } }).exec();
      }

      // The notes from before versioning are kept as version 0 (restorable).
      if (!latest && topic.status === ContentStatus.PUBLISHED) {
        await this.versions.create({
          topicId: topic._id,
          version: 0,
          status: 'published',
          ...snapshotOf(topic),
          contentHash: 'original',
          questionCount: await this.questions.countDocuments({ topicId: topic._id, topicVersion: { $exists: false } }),
          createdByName: topic.createdByName ?? 'Before versioning',
          publishedAt: topic.updatedAt ?? new Date(),
        });
      }

      const pending = latest && PENDING.includes(latest.status) ? latest : null;
      const number = pending ? pending.version : (latest?.version ?? 0) + 1;
      const versionFields = { ...notes, status: 'in_review', contentHash: hash, source: bundle.source, createdByName: opts.authorName, originality: flagsFor.get(it.topic.id) ?? [] };
      if (pending) {
        await this.questions.deleteMany({ topicId: topic._id, topicVersion: number, status: { $ne: ContentStatus.PUBLISHED } }).exec();
        await this.versions.updateOne({ _id: pending._id }, { $set: versionFields, $unset: { lastReview: 1 } }).exec();
      } else {
        await this.versions.create({ topicId: topic._id, version: number, ...versionFields });
      }
      const already = new Set((await this.questions.find({ topicId: topic._id, topicVersion: number }).select('stem').lean().exec()).map(q => norm(q.stem)));
      const fresh = it.questions.filter(q => !already.has(norm(q.stem)));
      if (fresh.length) {
        await this.questions.insertMany(
          fresh.map(q => ({
            topicId: topic!._id,
            stem: q.stem,
            options: q.options,
            answerIndex: q.answerIndex,
            explanation: q.explanation,
            difficulty: q.difficulty,
            kind: q.kind,
            tag: it.topic.id,
            topicVersion: number,
            status: ContentStatus.IN_REVIEW,
            createdByName: opts.authorName,
          })),
        );
      }
      // "⚑" markers → flags a reviewer must resolve one by one (question flags point at the saved question).
      const saved = await this.questions.find({ topicId: topic._id, topicVersion: number }).select('stem').lean().exec();
      const idByStem = new Map(saved.map(q => [norm(q.stem), String(q._id)]));
      const flags = findFlags(it.topic, it.questions).map(f => ({
        ...f,
        ...(f.location.kind === 'question' ? { questionId: idByStem.get(norm(it.questions[f.location.questionIndex].stem)) } : {}),
        status: 'open' as const,
      }));
      await this.versions.updateOne({ topicId: topic._id, version: number }, { $set: { questionCount: it.questions.length, flags } }).exec();
    }
    report.imported = !opts.dryRun;
    return report;
  }

  /** Refresh the module tree; add verified schools that aren't there yet (admin edits are kept). */
  private async saveCurriculum(outline: Outline) {
    const modules = outline.modules.map(m => ({
      id: m.id,
      title: m.title,
      typicalLevel: m.typical_level,
      edmiraCourse: m.edmira_course,
      topics: m.topics.map(t => ({ id: t.id, title: t.title })),
    }));
    const doc = (await this.curricula.findOne({ subject: outline.subject }).exec()) ?? new this.curricula({ subject: outline.subject, schools: [] });
    const have = new Set(doc.schools.map(s => s.key));
    for (const s of outline.school_codes ?? []) {
      if (!have.has(s.key)) doc.schools.push({ ...s, courses: s.courses.map(c => ({ code: c.code, title: c.title, modules: c.modules })) } as never);
      else {
        // Fill in which profile school an entry is for, without touching admin edits.
        const e = doc.schools.find(x => x.key === s.key)!;
        if (!e.institution && s.institution) e.institution = s.institution;
      }
    }
    doc.set({ version: outline.version, modules });
    await doc.save();
  }

  // ── Curriculum & school codes (admin) ─────────────────────────────────────

  async curriculum(subject: string) {
    const doc = await this.curricula.findOne({ subject: new RegExp(`^${escapeRegex(subject)}$`, 'i') }).lean().exec();
    if (!doc) throw new NotFoundException('No curriculum for that subject yet (run the content import).');
    return { subject: doc.subject, version: doc.version, modules: doc.modules, schools: doc.schools };
  }

  /** Add or replace one school's code → module mapping. Module IDs must exist. */
  async saveSchool(subject: string, school: SchoolCodes, staffName: string) {
    const doc = await this.curricula.findOne({ subject: new RegExp(`^${escapeRegex(subject)}$`, 'i') }).exec();
    if (!doc) throw new NotFoundException('No curriculum for that subject yet.');
    const moduleIds = new Set(doc.modules.map(m => m.id));
    if (!/^[a-z0-9-]{2,40}$/.test(school.key)) throw new BadRequestException('The school key must be short: lower-case letters, numbers and dashes.');
    if (!school.school?.trim()) throw new BadRequestException('Give the school a name.');
    for (const c of school.courses ?? []) {
      const bad = c.modules.filter(m => !moduleIds.has(m));
      if (bad.length) throw new BadRequestException(`Unknown module ${bad.join(', ')}.`);
      if (!c.modules.length) throw new BadRequestException('Each course code needs at least one module.');
    }
    const entry = {
      key: school.key,
      school: school.school.trim(),
      verified: !!school.verified,
      institution: school.institution || null,
      source: school.source?.trim() || null,
      courses: (school.courses ?? []).map(c => ({ code: c.code?.trim() || null, title: c.title?.trim() || null, modules: [...new Set(c.modules)] })),
      updatedBy: staffName,
      updatedAt: new Date(),
    };
    const i = doc.schools.findIndex(s => s.key === school.key);
    if (i >= 0) doc.schools.splice(i, 1, entry as never);
    else doc.schools.push(entry as never);
    await doc.save();
    return entry;
  }

  async removeSchool(subject: string, key: string) {
    const res = await this.curricula.updateOne({ subject: new RegExp(`^${escapeRegex(subject)}$`, 'i') }, { $pull: { schools: { key } } }).exec();
    if (!res.modifiedCount) throw new NotFoundException('School not found.');
    return { removed: key };
  }

  // ── Contributors (admin) ──────────────────────────────────────────────────

  listContributors() {
    return this.contributors.find().sort({ name: 1 }).lean().exec();
  }

  async saveContributor(input: Partial<Contributor> & { key: string; name: string; permissionGranted: boolean }, staffName: string, id?: string) {
    if (!/^[a-z0-9-]{2,40}$/.test(input.key ?? '')) throw new BadRequestException('The key must be short: lower-case letters, numbers and dashes.');
    if (input.permissionGranted && !input.permissionText?.trim()) {
      throw new BadRequestException('Record what they agreed to (wording, or where the signed form is).');
    }
    const fields = {
      key: input.key,
      name: input.name.trim(),
      role: input.role?.trim() ?? '',
      email: input.email?.trim() || undefined,
      permissionGranted: !!input.permissionGranted,
      permissionDate: input.permissionDate ? new Date(input.permissionDate) : input.permissionGranted ? new Date() : undefined,
      permissionText: input.permissionText?.trim() ?? '',
      credit: !!input.credit,
      creditName: input.creditName?.trim() || undefined,
      topics: input.topics ?? [],
    };
    if (id) {
      const updated = await this.contributors.findByIdAndUpdate(id, { $set: fields }, { new: true }).lean().exec();
      if (!updated) throw new NotFoundException('Contributor not found.');
      return updated;
    }
    if (await this.contributors.exists({ key: fields.key })) throw new ConflictException('That key is already used.');
    return (await this.contributors.create({ ...fields, addedBy: staffName })).toObject();
  }

  // ── Review ────────────────────────────────────────────────────────────────

  /** Versions waiting for review (newest first). */
  async pending() {
    const rows = await this.versions.find({ status: { $in: PENDING } }).sort({ updatedAt: -1 }).limit(500).lean().exec();
    return this.withTitles(rows);
  }

  /** Every version of a topic, newest first. */
  async history(topicId: string) {
    const rows = await this.versions.find({ topicId: new Types.ObjectId(topicId) }).sort({ version: -1 }).lean().exec();
    return this.withTitles(rows);
  }

  /** One version, the live notes to compare it with, and its questions. */
  async detail(versionId: string) {
    const v = await this.versions.findById(versionId).lean().exec();
    if (!v) throw new NotFoundException('Version not found.');
    const topic = await this.topics.findById(v.topicId).lean().exec();
    // What students see now: the published version (version 0 before the first approval).
    const live = await this.versions.findOne({ topicId: v.topicId, status: 'published' }).lean().exec();
    const questions = await this.questions
      .find({ topicId: v.topicId, ...(v.version === 0 ? { topicVersion: { $exists: false } } : { topicVersion: v.version }) })
      .sort({ createdAt: 1 })
      .lean()
      .exec();
    const [version] = await this.withTitles([v]);
    return {
      version,
      live: live && String(live._id) !== String(v._id) ? (await this.withTitles([live]))[0] : null,
      topicStatus: topic?.status ?? null,
      questions: questions.map(q => ({
        id: String(q._id),
        stem: q.stem,
        options: q.options,
        answerIndex: q.answerIndex,
        explanation: q.explanation ?? '',
        difficulty: q.difficulty ?? null,
        kind: q.kind ?? null,
        tag: q.tag ?? null,
        status: q.status,
      })),
    };
  }

  async transition(staff: Staff, versionId: string, action: VersionAction, note?: string) {
    if (!can(staff.role, 'review')) throw new ForbiddenException('Only medical reviewers and admins can review notes.');
    const v = await this.versions.findById(versionId).exec();
    if (!v) throw new NotFoundException('Version not found.');
    const review = {
      decision: action === 'approve' || action === 'restore' ? 'approved' : action === 'reject' ? 'rejected' : 'changes_requested',
      note: note?.trim() || undefined,
      reviewerId: new Types.ObjectId(staff.id),
      reviewerName: staff.name,
      at: new Date(),
    };

    if (action === 'request_changes' || action === 'reject') {
      if (!PENDING.includes(v.status)) throw new ConflictException('Only versions waiting for review can be sent back or rejected.');
      if (!review.note) throw new BadRequestException('Please say what needs to change.');
      v.set({ status: action === 'reject' ? 'rejected' : 'changes_requested', lastReview: review });
      await v.save();
      if (action === 'reject') {
        await this.questions
          .updateMany({ topicId: v.topicId, topicVersion: v.version, status: { $in: [ContentStatus.DRAFT, ContentStatus.IN_REVIEW] } }, { $set: { status: ContentStatus.ARCHIVED } })
          .exec();
      }
      return { status: v.status };
    }
    if (action === 'approve' && v.status !== 'in_review') throw new ConflictException('Only versions in review can be approved.');
    // Every "⚑" must be resolved by a reviewer first (and none may be left in the text).
    if (action === 'approve') {
      const open = (v.flags ?? []).filter(f => f.status === 'open');
      if (open.length) throw new ConflictException(`${open.length} "⚑" check(s) still open: confirm, correct or remove each one first.`);
      const leftover = [...(v.material ?? []), ...(v.extended ?? []), ...(v.clinical ?? [])]
        .map(sec => `${sec.heading}\n${sec.body}`)
        .concat(v.objectives ?? [], v.keyPoints ?? [], v.revision ?? [])
        .join('\n')
        .includes('⚑');
      const questionLeftover = await this.questions.exists({ topicId: v.topicId, topicVersion: v.version, $or: [{ stem: /⚑/ }, { explanation: /⚑/ }, { options: /⚑/ }] });
      if (leftover || questionLeftover) throw new ConflictException('A "⚑" is still in the text. Resolve it before approving.');
    }
    if (action === 'restore' && v.status !== 'superseded') throw new ConflictException('Only earlier versions can be restored.');
    const result = await this.makeLive(v, review);
    return { status: 'published', ...result };
  }

  /**
   * A reviewer resolves one "⚑": confirm (keep the text, drop the marker),
   * correct (replace the sentence) or remove (delete it). Recorded with who
   * and when; the change is made to this version (or its question).
   */
  async resolveFlag(staff: Staff, versionId: string, flagId: string, action: 'confirm' | 'correct' | 'remove', text?: string, note?: string) {
    if (!can(staff.role, 'review')) throw new ForbiddenException('Only medical reviewers and admins can resolve checks.');
    const v = await this.versions.findById(versionId).exec();
    if (!v) throw new NotFoundException('Version not found.');
    if (!PENDING.includes(v.status)) throw new ConflictException('Checks can only be resolved while the version is waiting for review.');
    const flag = (v.flags ?? []).find(f => f.id === flagId);
    if (!flag) throw new NotFoundException('Check not found.');
    if (flag.status !== 'open') throw new ConflictException('This check was already resolved.');
    if (action === 'correct') {
      if (!text?.trim()) throw new BadRequestException('Give the corrected text.');
      if (text.includes('⚑')) throw new BadRequestException('The corrected text can\'t contain ⚑.');
    }
    const loc = flag.location as { kind: string; part?: string; index?: number; field?: string; optionIndex?: number };
    const changed = () => new ConflictException('The text around this check has changed. Reload and try again.');

    if (loc.kind === 'question') {
      const q = flag.questionId ? await this.questions.findById(flag.questionId).exec() : null;
      if (!q) throw new NotFoundException('Question not found.');
      if (loc.field === 'option') {
        const options = [...q.options];
        const next = resolveIn(options[loc.optionIndex!] ?? '', flag.excerpt, action, text);
        if (next === null) throw changed();
        if (!next) throw new BadRequestException('An option can\'t be removed this way: correct it instead.');
        options[loc.optionIndex!] = next;
        q.set({ options });
      } else {
        const field = loc.field as 'stem' | 'explanation';
        const next = resolveIn(q[field] ?? '', flag.excerpt, action, text);
        if (next === null) throw changed();
        if (!next && field === 'stem') throw new BadRequestException('The question text can\'t be removed: correct it instead.');
        q.set({ [field]: next });
      }
      await q.save();
    } else if (loc.kind === 'section') {
      const part = loc.part as 'material' | 'extended' | 'clinical';
      const sections = plainSections(v[part]);
      const sec = sections.find(x => `${x.heading}\n${x.body}`.includes(flag.excerpt)) ?? sections[loc.index!];
      if (!sec) throw changed();
      const body = resolveIn(sec.body, flag.excerpt, action, text);
      const heading = body === null ? resolveIn(sec.heading, flag.excerpt, action, text) : null;
      if (body === null && heading === null) throw changed();
      if (body !== null) sec.body = body;
      else sec.heading = heading || sec.heading;
      v.set({ [part]: sections });
    } else {
      const part = loc.part as 'objectives' | 'keyPoints' | 'revision';
      const items = [...(v[part] ?? [])];
      // Found by its text (an earlier removal may have shifted positions).
      const at = items.findIndex(i => i.includes(flag.excerpt));
      if (at < 0) throw changed();
      const next = resolveIn(items[at], flag.excerpt, action, text)!;
      if (next) items[at] = next;
      else items.splice(at, 1);
      v.set({ [part]: items });
    }

    const resolved = { confirm: 'confirmed', correct: 'corrected', remove: 'removed' } as const;
    v.set({
      flags: v.flags.map(f =>
        f.id === flagId
          ? { ...f, status: resolved[action], resolution: { action, ...(text ? { text: text.trim() } : {}), ...(note?.trim() ? { note: note.trim() } : {}), by: staff.name, at: new Date() } }
          : f,
      ),
    });
    await v.save();
    return { id: flagId, status: resolved[action], where: flag.where, open: v.flags.filter(f => f.status === 'open').length };
  }

  /** Put `v` live: its notes onto the topic, its questions in, the others' out. */
  private async makeLive(v: TopicVersionDocument, review: { reviewerName: string; at: Date } & Record<string, unknown>) {
    const topic = await this.topics.findById(v.topicId).exec();
    if (!topic) throw new NotFoundException('Topic not found.');
    const mine = v.version === 0 ? { topicVersion: { $exists: false } } : { topicVersion: v.version };

    // This version's questions (still in review, or retired earlier) go live…
    const live = await this.questions
      .updateMany(
        { topicId: topic._id, ...mine, $or: [{ status: ContentStatus.IN_REVIEW }, { status: ContentStatus.ARCHIVED, retiredByVersion: { $exists: true } }] },
        { $set: { status: ContentStatus.PUBLISHED }, $unset: { retiredByVersion: 1 } },
      )
      .exec();
    // …and, if it has any, every other live question of the topic is retired (kept for quiz history).
    if (await this.questions.countDocuments({ topicId: topic._id, ...mine, status: ContentStatus.PUBLISHED })) {
      const others = v.version === 0 ? { topicVersion: { $exists: true } } : { $or: [{ topicVersion: { $ne: v.version } }, { topicVersion: { $exists: false } }] };
      await this.questions
        .updateMany({ topicId: topic._id, status: ContentStatus.PUBLISHED, ...others }, { $set: { status: ContentStatus.ARCHIVED, retiredByVersion: v.version } })
        .exec();
    }

    await this.versions.updateMany({ topicId: topic._id, status: 'published', _id: { $ne: v._id } }, { $set: { status: 'superseded' } }).exec();
    v.set({ status: 'published', publishedAt: new Date(), lastReview: review });
    await v.save();

    const optional = <T>(list?: T[]) => (list?.length ? [...list] : undefined);
    topic.set({
      title: v.title,
      summary: v.summary,
      readMinutes: v.readMinutes,
      objectives: optional(v.objectives),
      keyPoints: optional(v.keyPoints),
      material: plainSections(v.material),
      extended: v.extended?.length ? plainSections(v.extended) : undefined,
      clinical: v.clinical?.length ? plainSections(v.clinical) : undefined,
      revision: optional(v.revision),
      furtherReading: optional(v.furtherReading),
      figures: v.figures?.length ? plainFigures(v.figures) : undefined,
      credits: optional(v.credits),
      ...(v.curriculumId ? { curriculumId: v.curriculumId } : {}),
      ...(v.order ? { order: v.order } : {}),
      liveVersion: v.version,
      status: ContentStatus.PUBLISHED,
      lastReview: review,
      reviewedBy: review.reviewerName,
      reviewedAt: review.at,
    });
    await topic.save();
    return { questionsPublished: live.modifiedCount };
  }

  private async withTitles<T extends { topicId: Types.ObjectId }>(rows: T[]) {
    const topics = await this.topics.find({ _id: { $in: rows.map(r => r.topicId) } }).select('title courseId status liveVersion').lean().exec();
    const byTopic = new Map(topics.map(t => [String(t._id), t]));
    const courses = await this.courses.find({ _id: { $in: topics.map(t => t.courseId) } }).select('title code moduleId').lean().exec();
    const byCourse = new Map(courses.map(c => [String(c._id), c]));
    return rows.map(r => {
      const t = byTopic.get(String(r.topicId));
      const c = t ? byCourse.get(String(t.courseId)) : undefined;
      const { _id, ...rest } = r as T & { _id: Types.ObjectId };
      return {
        ...rest,
        id: String(_id),
        topicId: String(r.topicId),
        topicTitle: t?.title ?? '',
        topicStatus: t?.status ?? null,
        liveVersion: t?.liveVersion ?? null,
        courseTitle: c?.title ?? '',
        courseCode: c?.code ?? c?.moduleId ?? '',
      };
    });
  }

  // ── Figures ───────────────────────────────────────────────────────────────

  async asset(hash: string) {
    if (!/^[0-9a-f]{32}$/.test(hash)) throw new NotFoundException();
    const a = await this.assets.findOne({ hash }).lean().exec();
    if (!a) throw new NotFoundException();
    // .lean() gives a BSON Binary, not a Buffer.
    const raw = a.data as unknown as Buffer | { buffer: Uint8Array };
    return { mimeType: a.mimeType, data: Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer) };
  }
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** ~200 words a minute over the standard notes. */
function estimateMinutes(t: ParsedTopic) {
  const words = t.material.map(s => `${s.heading} ${s.body}`).join(' ').split(/\s+/).length;
  return Math.max(3, Math.round(words / 200));
}

/** A topic's current notes as a version 0 snapshot. */
function snapshotOf(topic: TopicDocument) {
  return {
    title: topic.title,
    summary: topic.summary ?? '',
    readMinutes: topic.readMinutes,
    objectives: topic.objectives ?? [],
    keyPoints: topic.keyPoints ?? (topic.material ?? []).flatMap(s => s.keyPoints ?? []),
    material: plainSections(topic.material),
    extended: plainSections(topic.extended),
    clinical: plainSections(topic.clinical),
    revision: topic.revision ?? [],
    furtherReading: topic.furtherReading ?? [],
    figures: plainFigures(topic.figures),
    credits: topic.credits ?? [],
    order: topic.order,
  };
}
