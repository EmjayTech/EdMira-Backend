import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { InjectModel } from '@nestjs/mongoose';
import { Cache } from 'cache-manager';
import { Model } from 'mongoose';
import { AccountStatus, StaffRole } from '../common/enum/staff-role.enum';
import { suspendedKey } from '../common/guards/jwt-auth.guard';
import {
  Feedback,
  FeedbackDocument,
  QuestionReport,
  QuestionReportDocument,
} from '../feedback/feedback.schemas';
import { QuizAttempt, QuizAttemptDocument } from '../quiz/quiz-attempt.schema';
import { User, UserDocument } from '../users/model/user.model';
import { adminAttempt, adminFeedback, adminReport, adminStudent } from './admin.presenter';
import { AuditService } from './audit/audit.service';
import { FeedbackUpdateDto, ReportUpdateDto } from './dto/admin.dto';
import type { Staff } from './staff.guard';

const short = (text: string, n = 60) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** Long enough to outlive any access token issued before a suspension (15 min). */
const SUSPENSION_FLAG_TTL_MS = 20 * 60 * 1000;
const ATTEMPTS_LIMIT = 20_000;
const NOT_STAFF = { role: { $nin: Object.values(StaffRole) } };

/** Reports, feedback, students, attempts. */
@Injectable()
export class AdminPeopleService {
  constructor(
    @InjectModel(QuestionReport.name) private readonly reports: Model<QuestionReportDocument>,
    @InjectModel(Feedback.name) private readonly feedback: Model<FeedbackDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(QuizAttempt.name) private readonly attempts: Model<QuizAttemptDocument>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly audit: AuditService,
  ) {}

  // ── Reports ────────────────────────────────────────────────────────────────

  async listReports() {
    return (await this.reports.find().sort({ createdAt: -1 }).exec()).map(adminReport);
  }

  async updateReport(staff: Staff, id: string, dto: ReportUpdateDto) {
    const report = await this.reports.findById(id).exec();
    if (!report) throw new NotFoundException('That report no longer exists.');
    const note = dto.resolutionNote?.trim() ?? '';
    if (dto.status !== 'open' && !note) {
      throw new BadRequestException('Add a short note on what was done.');
    }
    report.set(
      dto.status === 'open'
        ? { status: 'open', resolutionNote: undefined, handledById: undefined, handledByName: undefined, handledAt: undefined }
        : { status: dto.status, resolutionNote: note, handledById: staff.id, handledByName: staff.name, handledAt: new Date() },
    );
    await report.save();
    const label = dto.status === 'open' ? 'Reopened' : dto.status === 'resolved' ? 'Resolved' : 'Dismissed';
    await this.audit.log(staff, 'report', id, dto.status === 'open' ? 'reopened' : dto.status, `${label} a question report`);
    return adminReport(report);
  }

  // ── Feedback ───────────────────────────────────────────────────────────────

  async listFeedback() {
    return (await this.feedback.find().sort({ createdAt: -1 }).exec()).map(adminFeedback);
  }

  async updateFeedback(staff: Staff, id: string, dto: FeedbackUpdateDto) {
    const item = await this.feedback.findById(id).exec();
    if (!item) throw new NotFoundException('That feedback no longer exists.');
    item.status = dto.status;
    await item.save();
    await this.audit.log(
      staff,
      'feedback',
      id,
      'triaged',
      `Marked feedback “${short(item.message, 40)}” as ${dto.status.replace('_', ' ')}`,
    );
    return adminFeedback(item);
  }

  // ── Students ───────────────────────────────────────────────────────────────

  /** Everyone without a staff role. */
  async listStudents() {
    const students = await this.users
      .find(NOT_STAFF)
      .select('-password -refreshToken')
      .sort({ _id: -1 })
      .exec();
    return students.map(adminStudent);
  }

  async setStudentStatus(staff: Staff, id: string, status: AccountStatus) {
    const student = await this.users.findOne({ _id: id, ...NOT_STAFF }).exec();
    if (!student) throw new NotFoundException('That student no longer exists.');
    student.status = status;
    if (status === AccountStatus.SUSPENDED) {
      student.refreshToken = null; // no more refreshes
      await this.cache.set(suspendedKey(id), '1', SUSPENSION_FLAG_TTL_MS); // live tokens stop now
    } else {
      await this.cache.del(suspendedKey(id));
    }
    await student.save();
    const name = `${student.firstName} ${student.lastName}`;
    await this.audit.log(
      staff,
      'student',
      id,
      status === AccountStatus.SUSPENDED ? 'suspended' : 'reactivated',
      `${status === AccountStatus.SUSPENDED ? 'Suspended' : 'Reactivated'} student ${name}`,
    );
    return adminStudent(student);
  }

  // ── Attempts ───────────────────────────────────────────────────────────────

  async listAttempts() {
    const attempts = await this.attempts
      .find()
      .select('-answers')
      .sort({ submittedAt: -1 })
      .limit(ATTEMPTS_LIMIT)
      .exec();
    return attempts.map(adminAttempt);
  }
}
