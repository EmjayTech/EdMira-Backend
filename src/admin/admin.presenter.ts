import { NewsArticleDocument } from '../news/news.schema';
import { CourseDocument } from '../content/schemas/course.schema';
import { QuestionDocument } from '../content/schemas/question.schema';
import { TopicDocument } from '../content/schemas/topic.schema';
import { FeedbackDocument, QuestionReportDocument } from '../feedback/feedback.schemas';
import { QuizAttemptDocument } from '../quiz/quiz-attempt.schema';
import { UserDocument } from '../users/model/user.model';

/** Shapes in EdMira-Admin/src/data/types.ts. Staff see every status and all fields. */

const iso = (d?: Date) => (d ? d.toISOString() : undefined);
const idString = (id: unknown) => (id == null ? undefined : String(id));

const authored = (item: TopicDocument | QuestionDocument) => ({
  status: item.status,
  createdById: idString(item.createdById) ?? '',
  createdByName: item.createdByName ?? 'EdMira',
  updatedAt: iso(item.updatedAt),
  lastReview: item.lastReview
    ? {
        decision: item.lastReview.decision,
        note: item.lastReview.note ?? '',
        reviewerId: idString(item.lastReview.reviewerId) ?? '',
        reviewerName: item.lastReview.reviewerName ?? '',
        at: iso(item.lastReview.at),
      }
    : undefined,
});

export const adminCourse = (c: CourseDocument) => ({
  id: c.id,
  title: c.title,
  description: c.description,
  code: c.code ?? '',
  color: c.color ?? '#0A369D',
  status: c.status,
  updatedAt: iso(c.updatedAt),
});

export const adminTopic = (t: TopicDocument) => ({
  id: t.id,
  courseId: String(t.courseId),
  title: t.title,
  order: t.order,
  summary: t.summary,
  readMinutes: t.readMinutes ?? 0,
  material: t.material.map(({ heading, body, keyPoints }) => ({
    heading,
    body,
    keyPoints: [...(keyPoints ?? [])],
  })),
  ...authored(t),
});

export const adminQuestion = (q: QuestionDocument) => ({
  id: q.id,
  topicId: String(q.topicId),
  stem: q.stem,
  options: [...q.options],
  answerIndex: q.answerIndex,
  explanation: q.explanation,
  ...authored(q),
});

export const adminReport = (r: QuestionReportDocument) => ({
  id: r.id,
  questionId: String(r.questionId),
  topicId: String(r.topicId),
  studentId: String(r.studentId),
  reason: r.reason,
  note: r.note,
  createdAt: iso(r.createdAt),
  status: r.status,
  resolutionNote: r.resolutionNote,
  handledById: idString(r.handledById),
  handledByName: r.handledByName,
  handledAt: iso(r.handledAt),
});

export const adminFeedback = (f: FeedbackDocument) => ({
  id: f.id,
  studentId: String(f.studentId),
  area: f.area,
  rating: f.rating,
  message: f.message,
  createdAt: iso(f.createdAt),
  status: f.status,
});

export const adminStudent = (u: UserDocument) => ({
  id: String(u._id),
  firstName: u.firstName ?? '',
  lastName: u.lastName ?? '',
  email: u.email,
  institution: u.studentProfile?.institution ?? '',
  department: u.studentProfile?.department ?? '',
  level: u.studentProfile?.level ?? '',
  // Accounts created before timestamps existed: fall back to the id's time.
  joinedAt: iso(u.createdAt) ?? (u._id as any).getTimestamp().toISOString(),
  status: u.status ?? 'active',
});

export const adminAttempt = (a: QuizAttemptDocument) => ({
  id: a.id,
  studentId: String(a.studentId),
  topicId: String(a.topicId),
  courseId: String(a.courseId),
  submittedAt: iso(a.submittedAt),
  total: a.total,
  correctCount: a.correctCount,
  score: a.score,
});

export const adminNews = (n: NewsArticleDocument) => ({
  id: n.id,
  title: n.title,
  summary: n.summary,
  body: [...n.body],
  category: n.category,
  institution: n.institution ?? '',
  source: n.source,
  sourceUrl: n.sourceUrl ?? '',
  imageUrl: n.imageUrl ?? '',
  publishedAt: iso(n.publishedAt),
  status: n.status,
  isSample: n.isSample,
  createdByName: n.createdByName ?? 'EdMira',
  updatedAt: iso(n.updatedAt),
});
