import { isForStudent, StudentAcademics } from './audience';
import { CourseDocument } from './schemas/course.schema';
import { ResourceDocument, youTubeId } from './schemas/resource.schema';
import { QuestionDocument } from './schemas/question.schema';
import { TopicDocument } from './schemas/topic.schema';

/**
 * JSON shapes sent to the mobile app (docs/BACKEND_INTEGRATION.md §3 in the
 * app repo). Keep these in sync with the app's DTO mappers.
 */

/** `forYou`: the course matches the student's level / department / school. */
export const presentCourse = (course: CourseDocument, student?: StudentAcademics) => ({
  id: course.id,
  title: course.title,
  description: course.description,
  code: course.code,
  color: course.color,
  status: course.status,
  forYou: isForStudent(course.audience, student),
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
      }
    : {}),
  status: topic.status,
});

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
 * Review for a student: everyone sees the right answer; the explanation is
 * EdMira Pro. `explanationLocked` tells the app to show the "Go Pro" teaser.
 */
export const presentStudentReviewQuestion = (question: QuestionDocument, isPro: boolean) => ({
  ...presentQuizQuestion(question),
  answerIndex: question.answerIndex,
  explanation: isPro ? question.explanation : undefined,
  explanationLocked: !isPro && !!question.explanation,
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
