import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ContentStatus } from '../common/enum/content-status.enum';
import { Course, CourseDocument } from '../content/schemas/course.schema';
import { Question, QuestionDocument } from '../content/schemas/question.schema';
import { Topic, TopicDocument } from '../content/schemas/topic.schema';
import { adminCourse, adminQuestion, adminTopic } from './admin.presenter';
import { AuditService } from './audit/audit.service';
import {
  CourseInputDto,
  QuestionInputDto,
  TopicInputDto,
  TransitionDto,
} from './dto/admin.dto';
import type { Staff } from './staff.guard';
import {
  ReviewAction,
  assertCanTransition,
  estimateReadMinutes,
  needsNote,
  nextStatus,
  statusAfterEdit,
  validateQuestion,
  validateTopic,
} from './workflow';

const short = (text: string, n = 60) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

const DECISION: Partial<Record<ReviewAction, string>> = {
  approve: 'approved',
  request_changes: 'changes_requested',
  reject: 'rejected',
};

const VERB: Record<ReviewAction, string> = {
  submit: 'Submitted for review:',
  approve: 'Approved and published',
  request_changes: 'Requested changes on',
  reject: 'Rejected',
  archive: 'Archived',
  restore: 'Restored to draft:',
};

/** Courses, topics and questions in every status, plus the review workflow. */
@Injectable()
export class AdminContentService {
  constructor(
    @InjectModel(Course.name) private readonly courses: Model<CourseDocument>,
    @InjectModel(Topic.name) private readonly topics: Model<TopicDocument>,
    @InjectModel(Question.name) private readonly questions: Model<QuestionDocument>,
    private readonly audit: AuditService,
  ) {}

  private async findOr404<T>(query: Promise<T | null>, what: string): Promise<T> {
    const item = await query;
    if (!item) throw new NotFoundException(`That ${what} no longer exists.`);
    return item;
  }

  // ── Courses ────────────────────────────────────────────────────────────────

  async listCourses() {
    return (await this.courses.find().sort({ title: 1 }).exec()).map(adminCourse);
  }

  async saveCourse(staff: Staff, input: CourseInputDto, id?: string) {
    const title = input.title?.trim();
    if (!title) throw new BadRequestException('Give the course a title.');
    const fields = {
      title,
      description: input.description?.trim() ?? '',
      code: (input.code?.trim() || title.slice(0, 3)).toUpperCase(),
      ...(input.color && { color: input.color }),
    };

    if (id) {
      const course = await this.findOr404(this.courses.findById(id).exec(), 'course');
      course.set(fields);
      await course.save();
      await this.audit.log(staff, 'course', course.id, 'edited', `Edited course “${course.title}”`);
      return adminCourse(course);
    }
    // Courses start as drafts; an admin publishes them (organisational, not medical content).
    const course = await this.courses.create({ ...fields, status: ContentStatus.DRAFT });
    await this.audit.log(staff, 'course', course.id, 'created', `Created course “${course.title}”`);
    return adminCourse(course);
  }

  async setCourseStatus(staff: Staff, id: string, status: ContentStatus) {
    const course = await this.findOr404(this.courses.findById(id).exec(), 'course');
    course.status = status;
    await course.save();
    const verb =
      status === ContentStatus.PUBLISHED ? 'published' : status === ContentStatus.ARCHIVED ? 'archived' : 'moved to draft';
    await this.audit.log(
      staff,
      'course',
      id,
      verb,
      `${verb[0].toUpperCase()}${verb.slice(1)} course “${course.title}”`,
    );
    return adminCourse(course);
  }

  // ── Topics ─────────────────────────────────────────────────────────────────

  async listTopics() {
    return (await this.topics.find().sort({ courseId: 1, order: 1 }).exec()).map(adminTopic);
  }

  async saveTopic(staff: Staff, input: TopicInputDto, id?: string) {
    validateTopic(input);
    await this.findOr404(this.courses.findById(input.courseId).exec(), 'course');
    const material = input.material.map(s => ({
      heading: s.heading.trim(),
      body: s.body.trim(),
      keyPoints: (s.keyPoints ?? []).map(k => k.trim()).filter(Boolean),
    }));
    const fields = {
      courseId: new Types.ObjectId(input.courseId),
      title: input.title.trim(),
      order: input.order,
      summary: input.summary.trim(),
      material,
      readMinutes: input.readMinutes || estimateReadMinutes(material),
    };

    if (id) {
      const topic = await this.findOr404(this.topics.findById(id).exec(), 'topic');
      const wasPublished = topic.status === ContentStatus.PUBLISHED;
      topic.set({ ...fields, status: statusAfterEdit(topic.status) });
      await topic.save();
      await this.audit.log(
        staff,
        'topic',
        topic.id,
        'edited',
        wasPublished
          ? `Edited published topic “${topic.title}” — sent back for review`
          : `Edited topic “${topic.title}”`,
      );
      return adminTopic(topic);
    }
    const topic = await this.topics.create({
      ...fields,
      status: ContentStatus.DRAFT,
      createdById: new Types.ObjectId(staff.id),
      createdByName: staff.name,
    });
    await this.audit.log(staff, 'topic', topic.id, 'created', `Created topic “${topic.title}”`);
    return adminTopic(topic);
  }

  // ── Questions ──────────────────────────────────────────────────────────────

  async listQuestions() {
    return (await this.questions.find().sort({ topicId: 1, createdAt: 1 }).exec()).map(adminQuestion);
  }

  async saveQuestion(staff: Staff, input: QuestionInputDto, id?: string) {
    validateQuestion(input);
    await this.findOr404(this.topics.findById(input.topicId).exec(), 'topic');
    const fields = {
      topicId: new Types.ObjectId(input.topicId),
      stem: input.stem.trim(),
      options: input.options.map(o => o.trim()),
      answerIndex: input.answerIndex,
      explanation: input.explanation?.trim() || undefined,
    };

    if (id) {
      const question = await this.findOr404(this.questions.findById(id).exec(), 'question');
      const wasPublished = question.status === ContentStatus.PUBLISHED;
      question.set({ ...fields, status: statusAfterEdit(question.status) });
      await question.save();
      await this.audit.log(
        staff,
        'question',
        question.id,
        'edited',
        wasPublished
          ? `Edited published question “${short(question.stem)}” — sent back for review`
          : `Edited question “${short(question.stem)}”`,
      );
      return adminQuestion(question);
    }
    const question = await this.questions.create({
      ...fields,
      status: ContentStatus.DRAFT,
      createdById: new Types.ObjectId(staff.id),
      createdByName: staff.name,
    });
    await this.audit.log(staff, 'question', question.id, 'created', `Created question “${short(question.stem)}”`);
    return adminQuestion(question);
  }

  // ── Review workflow ────────────────────────────────────────────────────────

  async transition(staff: Staff, kind: 'topic' | 'question', id: string, dto: TransitionDto) {
    const item =
      kind === 'topic'
        ? await this.findOr404(this.topics.findById(id).exec(), 'topic')
        : await this.findOr404(this.questions.findById(id).exec(), 'question');

    const { action } = dto;
    const note = dto.note?.trim() ?? '';
    assertCanTransition(staff, item, action);
    if (needsNote(action) && !note) {
      throw new BadRequestException('Add a note so the author knows what to change.');
    }

    item.status = nextStatus(action);
    if (DECISION[action]) {
      item.lastReview = {
        decision: DECISION[action],
        note,
        reviewerId: new Types.ObjectId(staff.id),
        reviewerName: staff.name,
        at: new Date(),
      };
    }
    await item.save();

    const label =
      kind === 'topic'
        ? `topic “${(item as TopicDocument).title}”`
        : `question “${short((item as QuestionDocument).stem)}”`;
    await this.audit.log(
      staff,
      kind,
      id,
      action.replace('_', ' '),
      `${VERB[action]} ${label}${note ? ` — “${short(note, 80)}”` : ''}`,
    );
    return kind === 'topic' ? adminTopic(item as TopicDocument) : adminQuestion(item as QuestionDocument);
  }
}
