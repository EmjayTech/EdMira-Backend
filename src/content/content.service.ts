import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ContentStatus } from '../common/enum/content-status.enum';
import { UsersRepository } from '../users/user.repository';
import { StudentAcademics } from './audience';
import { FileStorageService } from '../storage/file-storage.service';
import { presentCourse, presentQuizQuestion, presentResource, presentTopic } from './content.presenter';
import { Resource, ResourceDocument } from './schemas/resource.schema';
import { Course, CourseDocument } from './schemas/course.schema';
import { Question, QuestionDocument } from './schemas/question.schema';
import { Topic, TopicDocument } from './schemas/topic.schema';
import { Curriculum, CurriculumDocument } from './schemas/curriculum.schema';
import type { SchoolChip } from './content.presenter';

const PUBLISHED = ContentStatus.PUBLISHED;

/** Questions per quiz; the rest of the bank comes up in later quizzes. */
export const QUIZ_SET_SIZE = 20;

const shuffle = <T>(items: T[]) => {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

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
    @InjectModel(Resource.name) private readonly resources: Model<ResourceDocument>,
    @InjectModel(Curriculum.name) private readonly curricula: Model<CurriculumDocument>,
    private readonly users: UsersRepository,
    private readonly storage: FileStorageService,
  ) {}

  /** Level, department and school used to mark courses `forYou`. */
  async academicsOf(userId?: string): Promise<StudentAcademics | undefined> {
    if (!userId) return undefined;
    const profile = (await this.users.findById(userId))?.studentProfile;
    return profile && { level: profile.level, department: profile.department, institution: profile.institution };
  }

  /**
   * Published courses with their published topics (without study material).
   * Every course is returned; `forYou` marks the student's own ones so the app
   * can show those first and still let them browse the rest. Courses with no
   * approved topic yet are left out, so students never open an empty course.
   */
  async listCourses(student?: StudentAcademics) {
    const courses = await this.courses.find({ status: PUBLISHED }).sort({ title: 1 }).exec();
    const chips = await this.schoolChips(student);
    const topics = await this.topics
      .find({ status: PUBLISHED, courseId: { $in: courses.map(c => c._id) } })
      .select('-material')
      .sort({ order: 1 })
      .exec();
    const counts = await this.questionCounts(topics.map(t => t._id));
    return courses
      .map(course => {
        const own = topics.filter(t => String(t.courseId) === course.id);
        return {
          ...presentCourse(course, student, chips),
          questionCount: own.reduce((sum, t) => sum + (counts.get(t.id) ?? 0), 0),
          topics: own.map(t => ({ ...presentTopic(t, { withMaterial: false }), questionCount: counts.get(t.id) ?? 0 })),
        };
      })
      .filter(course => course.topics.length > 0);
  }

  async getCourse(courseId: string, student?: StudentAcademics) {
    const course = await this.courses.findOne({ _id: courseId, status: PUBLISHED }).exec();
    if (!course) {
      // An old school course (e.g. PIO 214) now split into modules: old links on phones land on its modules.
      const old = await this.courses.findOne({ _id: courseId, status: ContentStatus.ARCHIVED, 'replacedBy.0': { $exists: true } }).exec();
      if (!old) throw new NotFoundException('Course not found');
      const modules = await this.courses.find({ _id: { $in: old.replacedBy }, status: PUBLISHED }).exec();
      return {
        ...presentCourse(old, student),
        questionCount: 0,
        topics: [],
        replacedBy: modules.map(m => ({ id: m.id, title: m.title, shortName: m.shortName ?? '', color: m.color, icon: m.icon ?? '' })),
      };
    }
    const chips = await this.schoolChips(student);
    const topics = await this.topics
      .find({ courseId: course._id, status: PUBLISHED })
      .select('-material')
      .sort({ order: 1 })
      .exec();
    const counts = await this.questionCounts(topics.map(t => t._id));
    return {
      ...presentCourse(course, student, chips),
      questionCount: topics.reduce((sum, t) => sum + (counts.get(t.id) ?? 0), 0),
      topics: topics.map(t => ({ ...presentTopic(t, { withMaterial: false }), questionCount: counts.get(t.id) ?? 0 })),
    };
  }

  // ── Modules: the student's school's verified codes ──────────────────────────

  /** The student's school's VERIFIED entries (never unverified ones), across subjects. */
  private async schoolsOf(student?: StudentAcademics) {
    if (!student?.institution) return [];
    const docs = await this.curricula.find().select('schools').lean().exec();
    const plain = (s: string) => s.replace(/\([^)]*\)/g, '').split(',')[0].replace(/\s+/g, ' ').trim().toLowerCase();
    const mine = plain(student.institution);
    return docs.flatMap(d => d.schools).filter(s => s.verified && (s.institution ? s.institution === student.institution : plain(s.school) === mine));
  }

  /** moduleId → { school: "UNIBEN", codes: ["PHS211"] } for the student's school. */
  async schoolChips(student?: StudentAcademics): Promise<Map<string, SchoolChip>> {
    const chips = new Map<string, SchoolChip>();
    for (const s of await this.schoolsOf(student)) {
      const label = s.school.match(/\(([^)]+)\)/)?.[1] ?? s.school.split(',')[0];
      for (const c of s.courses) {
        if (!c.code) continue;
        for (const m of c.modules) {
          const chip = chips.get(m) ?? { school: label, codes: [] };
          if (!chip.codes.includes(c.code)) chip.codes.push(c.code);
          chips.set(m, chip);
        }
      }
    }
    return chips;
  }

  /**
   * Modules a course code stands for: the student's own school's verified
   * codes (e.g. AAU "PHS 201" → PHY-02), plus the national NUC CCMAS codes.
   */
  private async modulesForCode(q: string, student?: StudentAcademics) {
    const key = (s: string) => s.replace(/[^a-z0-9]/gi, '').toUpperCase();
    const k = key(q);
    if (!/^[A-Z]{2,4}\d{3}/.test(k)) return [];
    const nuc = (await this.curricula.find().select('schools').lean().exec()).flatMap(d => d.schools).filter(s => s.verified && s.key === 'nuc-ccmas');
    const schools = [...(await this.schoolsOf(student)), ...nuc];
    return [...new Set(schools.flatMap(s => s.courses.filter(c => c.code && c.code.split('/').some(part => key(part) === k || key(c.code!) === k)).flatMap(c => c.modules)))];
  }

  /** Published questions per topic (one query). */
  private async questionCounts(topicIds: Types.ObjectId[]) {
    if (!topicIds.length) return new Map<string, number>();
    const rows = await this.questions.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { topicId: { $in: topicIds }, status: PUBLISHED } },
      { $group: { _id: '$topicId', n: { $sum: 1 } } },
    ]);
    return new Map(rows.map(r => [String(r._id), r.n]));
  }

  /** A topic the student may open, with its (published) course. */
  async findVisibleTopic(topicId: string | Types.ObjectId) {
    const topic = await this.topics.findOne({ _id: topicId, status: PUBLISHED }).exec();
    const course = topic && (await this.courses.findOne({ _id: topic.courseId, status: PUBLISHED }).exec());
    if (!topic || !course) throw new NotFoundException('Topic not found');
    return { topic, course };
  }

  async getTopic(topicId: string, student?: StudentAcademics) {
    const { topic, course } = await this.findVisibleTopic(topicId);
    const questionCount = await this.questions.countDocuments({ topicId: topic._id, status: PUBLISHED });
    return { topic: presentTopic(topic), course: presentCourse(course, student, await this.schoolChips(student)), questionCount };
  }

  async search(query: string, student?: StudentAcademics) {
    const q = (query ?? '').trim();
    if (!q) return { courses: await this.listCourses(student), topics: [] };

    const pattern = new RegExp(escapeRegex(q), 'i');
    const publishedCourses = await this.courses.find({ status: PUBLISHED }).exec();
    const courseById = new Map(publishedCourses.map(c => [c.id, c]));

    // A school course code ("PHS 201", "PIO 214") finds the modules it covers, and their topics.
    const codeModules = await this.modulesForCode(q, student);
    const codeCourseIds = publishedCourses.filter(c => c.moduleId && codeModules.includes(c.moduleId)).map(c => c._id);
    const chips = await this.schoolChips(student);
    const [matchingCourses, matchingTopics] = await Promise.all([
      this.listCourses(student).then(all =>
        all.filter(
          c =>
            pattern.test(c.title) ||
            pattern.test(c.description) ||
            ('code' in c && !!c.code && pattern.test(c.code)) ||
            ('moduleId' in c && codeModules.includes(c.moduleId as string)),
        ),
      ),
      this.topics
        .find({
          status: PUBLISHED,
          courseId: { $in: publishedCourses.map(c => c._id) },
          $or: [{ title: pattern }, { summary: pattern }, ...(codeCourseIds.length ? [{ courseId: { $in: codeCourseIds } }] : [])],
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
        course: presentCourse(courseById.get(String(topic.courseId))!, student, chips),
      })),
    };
  }

  /**
   * One quiz from a topic's bank (topics have 50–100 questions): up to
   * QUIZ_SET_SIZE, questions the student hasn't seen first, then ones they got
   * wrong, then the rest, in random order. `ids` (Retry weak questions) asks
   * for exactly those questions instead.
   */
  async getQuizSet(topicId: string, studentId?: string, ids?: string[]) {
    const all = await this.getQuizQuestions(topicId);
    if (ids?.length) {
      const want = new Set(ids);
      return all.filter(q => want.has(q.id));
    }
    if (all.length <= QUIZ_SET_SIZE) return shuffle(all);
    const last = new Map<string, boolean>();
    if (studentId && Types.ObjectId.isValid(studentId)) {
      const attempts = await this.questions.db
        .collection('quizattempts')
        .find({ studentId: new Types.ObjectId(studentId), topicId: new Types.ObjectId(topicId) })
        .project({ answers: 1 })
        .sort({ submittedAt: 1 })
        .toArray();
      for (const a of attempts) for (const ans of a.answers ?? []) last.set(String(ans.questionId), !!ans.correct);
    }
    const rank = (id: string) => (!last.has(id) ? 0 : last.get(id) ? 2 : 1);
    const picked = shuffle(all)
      .sort((a, b) => rank(a.id) - rank(b.id))
      .slice(0, QUIZ_SET_SIZE);
    return shuffle(picked);
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

  // ── Study materials ────────────────────────────────────────────────────────

  /**
   * Published materials of a published course that this student may see:
   * course-wide ones, ones on published topics, and — for school-tagged
   * materials — only their own school's.
   */
  async listResources(courseId: string, student?: StudentAcademics) {
    const course = await this.courses.findOne({ _id: courseId, status: PUBLISHED }).exec();
    if (!course) throw new NotFoundException('Course not found');
    const liveTopicIds = (
      await this.topics.find({ courseId: course._id, status: PUBLISHED }).select('_id').exec()
    ).map(t => t._id);
    const resources = await this.resources
      .find({
        courseId: course._id,
        status: PUBLISHED,
        $and: [
          { $or: [{ topicId: { $exists: false } }, { topicId: null }, { topicId: { $in: liveTopicIds } }] },
          {
            $or: [
              { institution: { $exists: false } },
              { institution: null },
              ...(student?.institution ? [{ institution: student.institution }] : []),
            ],
          },
        ],
      })
      .sort({ kind: 1, createdAt: 1 })
      .exec();
    return resources.map(presentResource);
  }

  /** A short-lived link to an uploaded material, if the student may see it. */
  async resourceDownload(resourceId: string, student: StudentAcademics | undefined, baseUrl: string) {
    const resource = await this.resources.findOne({ _id: resourceId, status: PUBLISHED }).exec();
    const visible =
      resource &&
      (await this.listResources(String(resource.courseId), student).catch(() => [])).some(r => r.id === resource.id);
    if (!resource || !visible) throw new NotFoundException('Material not found');
    if (!resource.file) throw new NotFoundException('This material is a link, not a file.');
    const link = await this.storage.signedUrl(resource.file, baseUrl);
    return { ...link, name: resource.file.name, size: resource.file.size, mimeType: resource.file.mimeType };
  }
}
