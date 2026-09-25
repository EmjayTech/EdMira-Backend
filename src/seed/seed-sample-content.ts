import { Connection, Types } from 'mongoose';
import { ContentStatus } from '../common/enum/content-status.enum';
import { CourseSchema } from '../content/schemas/course.schema';
import { QuestionSchema } from '../content/schemas/question.schema';
import { TopicSchema } from '../content/schemas/topic.schema';
import { NewsArticleSchema } from '../news/news.schema';
import * as sample from './sample-content.json';

/**
 * Loads the mobile app's sample catalog (5 courses, 12 topics, 60 questions)
 * and 5 placeholder news stories.
 *
 * ⚠️ This content has NOT been medically reviewed. It exists so the app can be
 * tested end to end. Real content should come through the admin review flow.
 *
 * Does nothing if the database already has courses. Returns what it inserted.
 */
export async function seedSampleContent(connection: Connection) {
  const Course = connection.model('Course', CourseSchema);
  const Topic = connection.model('Topic', TopicSchema);
  const Question = connection.model('Question', QuestionSchema);
  const News = connection.model('NewsArticle', NewsArticleSchema);

  if ((await Course.countDocuments()) > 0) {
    return { skipped: true, courses: 0, topics: 0, questions: 0, news: 0 };
  }

  // The sample uses slugs ("anatomy"); the database uses ObjectIds.
  const ids = new Map<string, Types.ObjectId>();
  const idFor = (slug: string) => {
    if (!ids.has(slug)) ids.set(slug, new Types.ObjectId());
    return ids.get(slug);
  };

  await Course.insertMany(
    sample.courses.map(({ id, ...course }) => ({ _id: idFor(id), ...course })),
  );
  await Topic.insertMany(
    sample.topics.map(({ id, courseId, ...topic }) => ({
      _id: idFor(id),
      courseId: idFor(courseId),
      ...topic,
    })),
  );
  await Question.insertMany(
    sample.questions.map(({ id, topicId, ...question }) => ({
      _id: idFor(id),
      topicId: idFor(topicId),
      ...question,
    })),
  );
  await News.insertMany(
    sample.news.map(({ id, hoursAgo, ...story }) => ({
      ...story,
      publishedAt: new Date(Date.now() - hoursAgo * 3_600_000),
      status: ContentStatus.PUBLISHED,
      isSample: true,
    })),
  );

  return {
    skipped: false,
    courses: sample.courses.length,
    topics: sample.topics.length,
    questions: sample.questions.length,
    news: sample.news.length,
  };
}
