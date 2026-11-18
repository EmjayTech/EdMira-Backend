import { isForStudent, StudentAcademics } from './audience';
import { CourseDocument } from './schemas/course.schema';
import { ResourceDocument, youTubeId } from './schemas/resource.schema';
import { QuestionDocument } from './schemas/question.schema';
import { TopicDocument } from './schemas/topic.schema';

/**
 * JSON shapes sent to the mobile app (docs/BACKEND_INTEGRATION.md §3 in the
 * app repo). Keep these in sync with the app's DTO mappers.
 */

/** A verified school's own code(s) for a module, e.g. { school: "UNIBEN", codes: ["PHS211"] }. */
export type SchoolChip = { school: string; codes: string[] };

/**
 * `forYou`: the course matches the student's level / department / school.
 * For a module (Physiology PHY-01 …) it's a recommendation only: every
 * module stays open. Modules have no course code; `schoolChip` is shown only
 * when the student's school has a verified mapping.
 */
export const presentCourse = (course: CourseDocument, student?: StudentAcademics, chips?: Map<string, SchoolChip>) => ({
  id: course.id,
  title: course.title,
  description: course.description,
  ...(course.moduleId ? {} : { code: course.code }),
  color: course.color,
  status: course.status,
  forYou: isForStudent(course.audience, student),
  ...(course.moduleId
    ? {
        subject: course.subject,
        moduleId: course.moduleId,
        shortName: course.shortName,
        icon: course.icon,
        typicalLevels: [...(course.typicalLevels ?? [])],
        ...(chips?.get(course.moduleId) ? { schoolChip: chips.get(course.moduleId) } : {}),
      }
    : {}),
});

export const presentTopic = (topic: TopicDocument, { withMaterial = true } = {}) => ({
  id: topic.id,
  courseId: String(topic.courseId),
  title: topic.title,
  order: topic.order,
  summary: topic.summary,
  readMinutes: topic.readMinutes,
  ...(withMaterial
    ? {
        // Plain objects: Mongoose sub-documents have circular parent links.
        material: topic.material.map(({ heading, body, keyPoints }) => ({
          heading,
          body,
          ...(keyPoints?.length ? { keyPoints: [...keyPoints] } : {}),
        })),
        ...notesOf(topic),
      }
    : {}),
  ...(topic.curriculumId ? { curriculumId: topic.curriculumId } : {}),
  status: topic.status,
});

const sectionsOf = (secs?: { heading: string; body: string }[]) => (secs ?? []).map(({ heading, body }) => ({ heading, body }));

/** Where the app loads a figure from (relative to the API). The hash changes when the image does. */
export const assetPath = (assetId: string) => `/api/v1/content-assets/${assetId}`;

/**
 * The standard note format, for topics that have it (older topics only have
 * `material`). Extended notes and the clinical correlation are Pro (Part 4).
 */
function notesOf(topic: TopicDocument) {
  const out: Record<string, unknown> = {};
  if (topic.objectives?.length) out.objectives = [...topic.objectives];
  if (topic.keyPoints?.length) out.keyPoints = [...topic.keyPoints];
  if (topic.extended?.length) out.extended = sectionsOf(topic.extended);
  if (topic.clinical?.length) out.clinical = sectionsOf(topic.clinical);
  if (topic.revision?.length) out.revision = [...topic.revision];
  if (topic.furtherReading?.length) out.furtherReading = [...topic.furtherReading];
  if (topic.credits?.length) out.credits = [...topic.credits];
  if (topic.figures?.length) {
    out.figures = topic.figures.map(f => ({
      key: f.key,
      label: f.label,
      caption: f.caption,
      alt: f.alt,
      // Shown under the figure. Our own figures need no credit line.
      attribution: /^original$/i.test(f.licence ?? '') ? '' : f.attributionText,
      url: assetPath(f.assetId),
      mimeType: f.mimeType ?? 'image/svg+xml',
    }));
  }
  return out;
}

/** During a quiz: no answer and no explanation, ever. */
export const presentQuizQuestion = (question: QuestionDocument) => ({
  id: question.id,
  topicId: String(question.topicId),
  stem: question.stem,
  options: [...question.options],
  status: question.status,
});

/** After submission (attempt review): includes the answer + explanation. */
export const presentReviewQuestion = (question: QuestionDocument) => ({
  ...presentQuizQuestion(question),
  answerIndex: question.answerIndex,
  explanation: question.explanation,
});

/**
 * A study material for the app. Files are fetched through
 * GET /resources/:id/download (short-lived link); links open as they are.
 */
export const presentResource = (r: ResourceDocument) => {
  const videoId = youTubeId(r.link);
  return {
    id: r.id,
    courseId: String(r.courseId),
    ...(r.topicId ? { topicId: String(r.topicId) } : {}),
    kind: r.kind,
    title: r.title,
    description: r.description ?? '',
    ...(r.institution ? { institution: r.institution } : {}),
    source: r.file ? 'file' : videoId ? 'youtube' : 'link',
    ...(r.file ? { file: { name: r.file.name, size: r.file.size, mimeType: r.file.mimeType } } : {}),
    ...(r.link ? { link: r.link } : {}),
    ...(videoId ? { youTubeId: videoId } : {}),
    updatedAt: r.updatedAt?.toISOString(),
  };
};
