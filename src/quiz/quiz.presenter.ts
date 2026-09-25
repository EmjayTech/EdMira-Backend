import { QuizAttemptDocument } from './quiz-attempt.schema';

export const presentAttempt = (attempt: QuizAttemptDocument) => ({
  id: attempt.id,
  topicId: String(attempt.topicId),
  courseId: String(attempt.courseId),
  topicTitle: attempt.topicTitle,
  courseTitle: attempt.courseTitle,
  startedAt: attempt.startedAt.toISOString(),
  submittedAt: attempt.submittedAt.toISOString(),
  total: attempt.total,
  correctCount: attempt.correctCount,
  answeredCount: attempt.answeredCount,
  score: attempt.score,
  answers: attempt.answers.map(a => ({
    questionId: String(a.questionId),
    selectedIndex: a.selectedIndex,
    correct: a.correct,
  })),
});
