import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ContentStatus } from '../common/enum/content-status.enum';
import { presentCourse, presentQuizQuestion, presentTopic } from './content.presenter';
import { Course, CourseDocument } from './schemas/course.schema';
import { Question, QuestionDocument } from './schemas/question.schema';
import { Topic, TopicDocument } from './schemas/topic.schema';

const PUBLISHED = ContentStatus.PUBLISHED;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Student-facing content. Everything here serves ONLY published topics and
 * questions that belong to published courses (MVP US-05 / US-22).
 */
@Injectable()
export class ContentService {
  constructor(
    @InjectModel(Course.name) private readonly courses: Model<CourseDocument>,
    @InjectModel(Topic.name) private readonly topics: Model<TopicDocument>,
    @InjectModel(Question.name) private readonly questions: Model<QuestionDocument>,
  ) {}

  /** Published courses with their published topics (without study material). */
  async listCourses() {
    const courses = await this.courses.find({ status: PUBLISHED }).sort({ title: 1 }).exec();
    const topics = await this.topics
      .find({ status: PUBLISHED, courseId: { $in: courses.map(c => c._id) } })
      .select('-material')
      .sort({ order: 1 })
      .exec();
    return courses.map(course => ({
      ...presentCourse(course),
      topics: topics
        .filter(t => String(t.courseId) === course.id)
        .map(t => presentTopic(t, { withMaterial: false })),
    }));
  }

  async getCourse(courseId: string) {
    const course = await this.courses.findOne({ _id: courseId, status: PUBLISHED }).exec();
    if (!course) throw new NotFoundException('Course not found');
    const topics = await this.topics
      .find({ courseId: course._id, status: PUBLISHED })
      .select('-material')
      .sort({ order: 1 })
      .exec();
    return { ...presentCourse(course), topics: topics.map(t => presentTopic(t, { withMaterial: false })) };
  }

  /** A topic the student may open, with its (published) course. */
  async findVisibleTopic(topicId: string | Types.ObjectId) {
    const topic = await this.topics.findOne({ _id: topicId, status: PUBLISHED }).exec();
    const course = topic && (await this.courses.findOne({ _id: topic.courseId, status: PUBLISHED }).exec());
    if (!topic || !course) throw new NotFoundException('Topic not found');
    return { topic, course };
  }

  async getTopic(topicId: string) {
    const { topic, course } = await this.findVisibleTopic(topicId);
    const questionCount = await this.questions.countDocuments({ topicId: topic._id, status: PUBLISHED });
    return { topic: presentTopic(topic), course: presentCourse(course), questionCount };
  }

  async search(query: string) {
    const q = (query ?? '').trim();
    if (!q) return { courses: await this.listCourses(), topics: [] };

    const pattern = new RegExp(escapeRegex(q), 'i');
    const publishedCourses = await this.courses.find({ status: PUBLISHED }).exec();
    const courseById = new Map(publishedCourses.map(c => [c.id, c]));

    const [matchingCourses, matchingTopics] = await Promise.all([
      this.listCourses().then(all =>
        all.filter(c => pattern.test(c.title) || pattern.test(c.description)),
      ),
      this.topics
        .find({
          status: PUBLISHED,
          courseId: { $in: publishedCourses.map(c => c._id) },
          $or: [{ title: pattern }, { summary: pattern }],
        })
        .select('-material')
        .sort({ order: 1 })
        .limit(50)
        .exec(),
    ]);

    return {
      courses: matchingCourses,
      topics: matchingTopics.map(topic => ({
        ...presentTopic(topic, { withMaterial: false }),
        course: presentCourse(courseById.get(String(topic.courseId))),
      })),
    };
  }

  /** Quiz questions without answers or explanations. */
  async getQuizQuestions(topicId: string) {
    const { topic } = await this.findVisibleTopic(topicId);
    const questions = await this.questions
      .find({ topicId: topic._id, status: PUBLISHED })
      .select('-answerIndex -explanation')
      .sort({ createdAt: 1 })
      .exec();
    return questions.map(presentQuizQuestion);
  }

  /** Published questions of a topic, WITH answers — for server-side grading only. */
  findGradableQuestions(topicId: Types.ObjectId, questionIds: string[]) {
    return this.questions
      .find({ _id: { $in: questionIds }, topicId, status: PUBLISHED })
      .exec();
  }

  /** Questions by id in any status — for reviewing a student's own past attempt. */
  findQuestionsByIds(questionIds: (string | Types.ObjectId)[]) {
    return this.questions.find({ _id: { $in: questionIds } }).exec();
  }

  questionExists(questionId: string) {
    return this.questions.exists({ _id: questionId });
  }
}
