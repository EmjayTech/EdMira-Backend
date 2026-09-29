import { Model, Types } from 'mongoose';
import { ContentStatus } from '../common/enum/content-status.enum';
import { AudienceRule, cleanAudience } from '../content/audience';
import { CourseDocument } from '../content/schemas/course.schema';
import { QuestionDocument } from '../content/schemas/question.schema';
import { ResourceDocument, youTubeId } from '../content/schemas/resource.schema';
import { TopicDocument } from '../content/schemas/topic.schema';
import type { ImportCourseDto } from './dto/import.dto';
import { estimateReadMinutes, questionProblems } from './workflow';

/**
 * Bulk import of courses → topics → questions and videos (dashboard "Import" page and
 * `yarn content:load`).
 *
 * - Courses are matched by title, topics by title within their course, so the
 *   same file can be imported twice: existing items are reused and questions
 *   whose text is already in the topic are skipped.
 * - New topics with study notes and every new question go straight into the
 *   review queue. Nothing reaches students until a reviewer approves it.
 * - Existing topics keep their notes (they may be live); only questions are added.
 * - All-or-nothing: if anything is invalid, nothing is saved.
 */

/** Who the imported topics and questions are credited to. */
export interface ImportAuthor {
  /** Omitted for library content, so any reviewer (including the importer) can approve it. */
  id?: string;
  name: string;
}

export const LIBRARY_AUTHOR_NAME = 'EdMira content library';

export interface ImportModels {
  courses: Model<CourseDocument>;
  topics: Model<TopicDocument>;
  questions: Model<QuestionDocument>;
  resources: Model<ResourceDocument>;
}

export interface ImportOptions {
  dryRun?: boolean;
  /** New courses go live straight away (admins). They only show to students once a topic is approved. */
  publishNewCourses: boolean;
}

export interface ImportProblem {
  /** e.g. "courses[0].topics[2].questions[4]" — lets the dashboard point at the spreadsheet row. */
  path: string;
  where: string;
  message: string;
}

export interface ImportResult {
  dryRun: boolean;
  imported: boolean;
  courses: { created: number; matched: number };
  topics: { created: number; matched: number; withoutNotes: number };
  questions: { created: number; duplicates: number };
  /** Recommended YouTube videos (topic study materials). */
  videos: { created: number; duplicates: number };
  errors: ImportProblem[];
  warnings: string[];
  /** Per course, for the audit log. */
  perCourse: { courseId?: string; title: string; created: boolean; topics: number; questions: number; videos: number }[];
}

const norm = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
const ruleKey = (r: { level: string; department?: string; institution?: string }) =>
  [r.level, r.department ?? '', r.institution ?? ''].join('|');

export async function importContent(
  models: ImportModels,
  input: ImportCourseDto[],
  author: ImportAuthor,
  options: ImportOptions,
): Promise<ImportResult> {
  const result: ImportResult = {
    dryRun: !!options.dryRun,
    imported: false,
    courses: { created: 0, matched: 0 },
    topics: { created: 0, matched: 0, withoutNotes: 0 },
    questions: { created: 0, duplicates: 0 },
    videos: { created: 0, duplicates: 0 },
    errors: [],
    warnings: [],
    perCourse: [],
  };
  const problem = (path: string, where: string, message: string) => result.errors.push({ path, where, message });

  // ── Load what already exists ──
  const existingCourses = await models.courses.find().exec();
  const courseByTitle = new Map(existingCourses.map(c => [norm(c.title), c]));
  const existingTopics = await models.topics
    .find({ courseId: { $in: existingCourses.map(c => c._id) } })
    .select('-material')
    .exec();
  const topicByKey = new Map(existingTopics.map(t => [`${t.courseId}|${norm(t.title)}`, t]));
  const maxOrder = new Map<string, number>();
  for (const t of existingTopics) {
    maxOrder.set(String(t.courseId), Math.max(maxOrder.get(String(t.courseId)) ?? 0, t.order));
  }

  // ── Plan (and validate) everything before writing anything ──
  type PlannedTopic = {
    existing?: TopicDocument;
    title: string;
    order?: number;
    summary: string;
    material: { heading: string; body: string; keyPoints: string[] }[];
    questions: { stem: string; options: string[]; answerIndex: number; explanation?: string }[];
    videos: { title: string; link: string; description: string }[];
  };
  type PlannedCourse = {
    existing?: CourseDocument;
    title: string;
    code: string;
    description: string;
    color?: string;
    audience: AudienceRule[];
    topics: Map<string, PlannedTopic>;
  };
  const planned = new Map<string, PlannedCourse>();
  // Question texts already present per topic key, filled lazily.
  const knownStems = new Map<string, Set<string>>();

  // YouTube ids already attached per topic key, filled lazily.
  const knownVideos = new Map<string, Set<string>>();
  const videosFor = async (key: string, topic?: TopicDocument) => {
    if (!knownVideos.has(key)) {
      const found = topic ? await models.resources.find({ topicId: topic._id, kind: 'video' }).select('link').exec() : [];
      knownVideos.set(key, new Set(found.map(r => youTubeId(r.link)).filter((id): id is string => !!id)));
    }
    return knownVideos.get(key)!;
  };

  const stemsFor = async (key: string, topic?: TopicDocument) => {
    if (!knownStems.has(key)) {
      const stems = topic ? await models.questions.find({ topicId: topic._id }).select('stem').exec() : [];
      knownStems.set(key, new Set(stems.map(q => norm(q.stem))));
    }
    return knownStems.get(key)!;
  };

  for (const [ci, c] of input.entries()) {
    const title = c.title?.trim() ?? '';
    const cPath = `courses[${ci}]`;
    const cWhere = `Course “${title || ci + 1}”`;
    if (!title) {
      problem(cPath, cWhere, 'Give the course a title.');
      continue;
    }
    const courseKey = norm(title);
    let course = planned.get(courseKey);
    if (!course) {
      const existing = courseByTitle.get(courseKey);
      course = {
        existing,
        title,
        code: (c.code?.trim() || title.replace(/[^A-Za-z]/g, '').slice(0, 3)).toUpperCase(),
        description: c.description?.trim() ?? '',
        color: c.color,
        audience: [],
        topics: new Map(),
      };
      planned.set(courseKey, course);
    }
    course.audience.push(...((c.audience ?? []) as AudienceRule[]));

    for (const [ti, t] of (c.topics ?? []).entries()) {
      const tTitle = t.title?.trim() ?? '';
      const tPath = `${cPath}.topics[${ti}]`;
      const tWhere = `${cWhere} › topic “${tTitle || ti + 1}”`;
      if (!tTitle) {
        problem(tPath, tWhere, 'Give the topic a title.');
        continue;
      }
      const existingTopic = course.existing ? topicByKey.get(`${course.existing.id}|${norm(tTitle)}`) : undefined;
      const topicKey = `${courseKey}|${norm(tTitle)}`;
      let topic = course.topics.get(topicKey);
      if (!topic) {
        topic = { existing: existingTopic, title: tTitle, order: t.order, summary: '', material: [], questions: [], videos: [] };
        course.topics.set(topicKey, topic);
      }

      const material = (t.material ?? []).map(s => ({
        heading: s.heading?.trim() ?? '',
        body: s.body?.trim() ?? '',
        keyPoints: (s.keyPoints ?? []).map(k => k.trim()).filter(Boolean),
      }));
      if (material.length) {
        if (existingTopic) {
          result.warnings.push(`${tWhere} already exists — its study notes were left unchanged.`);
        } else {
          if (material.some(s => !s.heading || !s.body)) {
            problem(tPath, tWhere, 'Every study section needs a heading and body text.');
          }
          if (!t.summary?.trim()) problem(tPath, tWhere, 'Write a short summary for the topic.');
          topic.material.push(...material);
          topic.summary ||= t.summary?.trim() ?? '';
        }
      } else if (!topic.summary && t.summary?.trim()) {
        topic.summary = t.summary.trim();
      }

      const stems = await stemsFor(topicKey, existingTopic);
      for (const [qi, q] of (t.questions ?? []).entries()) {
        const qPath = `${tPath}.questions[${qi}]`;
        const errors = questionProblems(q);
        if (errors.length) {
          problem(qPath, `${tWhere} › question ${qi + 1}`, errors.join(' '));
          continue;
        }
        const stem = q.stem.trim();
        if (stems.has(norm(stem))) {
          result.questions.duplicates++;
          continue;
        }
        stems.add(norm(stem));
        topic.questions.push({
          stem,
          options: q.options.map(o => o.trim()),
          answerIndex: q.answerIndex,
          explanation: q.explanation?.trim() || undefined,
        });
      }

      const videoIds = await videosFor(topicKey, existingTopic);
      for (const [vi, v] of (t.videos ?? []).entries()) {
        const id = youTubeId(v.link);
        const vTitle = v.title?.trim();
        if (!id || !vTitle) {
          problem(`${tPath}.videos[${vi}]`, `${tWhere} › video ${vi + 1}`, !vTitle ? 'Give the video a title.' : 'Videos must be YouTube links.');
          continue;
        }
        if (videoIds.has(id)) {
          result.videos.duplicates++;
          continue;
        }
        videoIds.add(id);
        topic.videos.push({ title: vTitle, link: `https://www.youtube.com/watch?v=${id}`, description: v.description?.trim() ?? '' });
      }
    }
  }

  // Counts (also what a dry run reports).
  for (const course of planned.values()) {
    course.existing ? result.courses.matched++ : result.courses.created++;
    for (const topic of course.topics.values()) {
      if (topic.existing) result.topics.matched++;
      else {
        result.topics.created++;
        if (!topic.material.length) result.topics.withoutNotes++;
      }
      result.questions.created += topic.questions.length;
      result.videos.created += topic.videos.length;
    }
  }
  if (result.topics.withoutNotes) {
    result.warnings.push(
      `${result.topics.withoutNotes} new topic${result.topics.withoutNotes > 1 ? 's have' : ' has'} no study notes. ` +
        'They are saved as drafts — add notes and submit them before students can open them.',
    );
  }
  if (result.errors.length || options.dryRun) return result;

  // ── Write ──
  const createdBy = author.id ? { createdById: new Types.ObjectId(author.id) } : {};
  for (const course of planned.values()) {
    let doc = course.existing;
    const rules = cleanAudience(course.audience);
    if (!doc) {
      doc = await models.courses.create({
        title: course.title,
        description: course.description,
        code: course.code,
        ...(course.color && { color: course.color }),
        audience: rules,
        status: options.publishNewCourses ? ContentStatus.PUBLISHED : ContentStatus.DRAFT,
      });
    } else if (rules.length && doc.audience.length) {
      // An empty rule list means "everyone"; don't narrow such a course by adding rules.
      const have = new Set(doc.audience.map(ruleKey));
      const extra = rules.filter(r => !have.has(ruleKey(r)));
      if (extra.length) {
        doc.audience = [...cleanAudience(doc.audience), ...extra] as AudienceRule[];
        await doc.save();
      }
    }

    let order = maxOrder.get(doc.id) ?? 0;
    let topicCount = 0;
    let questionCount = 0;
    let videoCount = 0;
    for (const topic of course.topics.values()) {
      let topicId = topic.existing?._id;
      if (!topicId) {
        const hasNotes = topic.material.length > 0;
        order = Math.max(order + 1, topic.order ?? 0);
        const created = await models.topics.create({
          courseId: doc._id,
          title: topic.title,
          order,
          summary: topic.summary,
          material: topic.material,
          readMinutes: hasNotes ? estimateReadMinutes(topic.material) : undefined,
          status: hasNotes ? ContentStatus.IN_REVIEW : ContentStatus.DRAFT,
          ...createdBy,
          createdByName: author.name,
        });
        topicId = created._id;
        topicCount++;
      }
      if (topic.questions.length) {
        await models.questions.insertMany(
          topic.questions.map(q => ({
            ...q,
            topicId,
            status: ContentStatus.IN_REVIEW,
            ...createdBy,
            createdByName: author.name,
          })),
        );
        questionCount += topic.questions.length;
      }
      if (topic.videos.length) {
        await models.resources.insertMany(
          topic.videos.map(v => ({
            ...v,
            kind: 'video',
            courseId: doc._id,
            topicId,
            status: ContentStatus.IN_REVIEW,
            ...createdBy,
            createdByName: author.name,
          })),
        );
        videoCount += topic.videos.length;
      }
    }
    result.perCourse.push({
      courseId: doc.id,
      title: doc.title,
      created: !course.existing,
      topics: topicCount,
      questions: questionCount,
      videos: videoCount,
    });
  }
  result.imported = true;
  return result;
}
