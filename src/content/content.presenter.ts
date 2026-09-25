import { CourseDocument } from './schemas/course.schema';
import { QuestionDocument } from './schemas/question.schema';
import { TopicDocument } from './schemas/topic.schema';

/**
 * JSON shapes sent to the mobile app (docs/BACKEND_INTEGRATION.md §3 in the
 * app repo). Keep these in sync with the app's DTO mappers.
 */

export const presentCourse = (course: CourseDocument) => ({
  id: course.id,
  title: course.title,
  description: course.description,
  code: course.code,
  color: course.color,
  status: course.status,
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
