import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { AdminContentService } from './admin-content.service';
import { AdminPeopleService } from './admin-people.service';
import { AuditService } from './audit/audit.service';
import {
  CourseInputDto,
  CourseStatusDto,
  FeedbackUpdateDto,
  QuestionInputDto,
  ReportUpdateDto,
  StudentStatusDto,
  TopicInputDto,
  TransitionDto,
} from './dto/admin.dto';
import { CurrentStaff, RequirePermission, Staff, StaffGuard } from './staff.guard';

/**
 * Admin dashboard API (contract: EdMira-Admin/docs/ADMIN_API.md).
 * Every route needs a logged-in, active staff account; RequirePermission
 * narrows it to the roles in permissions.ts.
 */
@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly content: AdminContentService,
    private readonly people: AdminPeopleService,
    private readonly auditLog: AuditService,
  ) {}

  // ── Courses ──
  @Get('courses')
  listCourses() {
    return this.content.listCourses();
  }

  @Post('courses')
  @RequirePermission('editContent')
  createCourse(@CurrentStaff() staff: Staff, @Body() dto: CourseInputDto) {
    return this.content.saveCourse(staff, dto);
  }

  @Patch('courses/:id')
  @RequirePermission('editContent')
  updateCourse(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: CourseInputDto) {
    return this.content.saveCourse(staff, dto, id);
  }

  @Post('courses/:id/status')
  @RequirePermission('manageLifecycle')
  @ApiOperation({ summary: 'Publish / unpublish / archive a course (admin)' })
  setCourseStatus(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: CourseStatusDto) {
    return this.content.setCourseStatus(staff, id, dto.status);
  }

  // ── Topics ──
  @Get('topics')
  listTopics() {
    return this.content.listTopics();
  }

  @Post('topics')
  @RequirePermission('editContent')
  createTopic(@CurrentStaff() staff: Staff, @Body() dto: TopicInputDto) {
    return this.content.saveTopic(staff, dto);
  }

  @Patch('topics/:id')
  @RequirePermission('editContent')
  updateTopic(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: TopicInputDto) {
    return this.content.saveTopic(staff, dto, id);
  }

  @Post('topics/:id/transitions')
  @ApiOperation({ summary: 'submit | approve | request_changes | reject | archive | restore' })
  transitionTopic(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: TransitionDto) {
    return this.content.transition(staff, 'topic', id, dto);
  }

  // ── Questions ──
  @Get('questions')
  @ApiOperation({ summary: 'All questions, including answers and explanations' })
  listQuestions() {
    return this.content.listQuestions();
  }

  @Post('questions')
  @RequirePermission('editContent')
  createQuestion(@CurrentStaff() staff: Staff, @Body() dto: QuestionInputDto) {
    return this.content.saveQuestion(staff, dto);
  }

  @Patch('questions/:id')
  @RequirePermission('editContent')
  updateQuestion(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: QuestionInputDto) {
    return this.content.saveQuestion(staff, dto, id);
  }

  @Post('questions/:id/transitions')
  transitionQuestion(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: TransitionDto) {
    return this.content.transition(staff, 'question', id, dto);
  }

  // ── Reports ──
  @Get('reports')
  @RequirePermission('viewReports')
  listReports() {
    return this.people.listReports();
  }

  @Patch('reports/:id')
  @RequirePermission('handleReports')
  updateReport(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: ReportUpdateDto) {
    return this.people.updateReport(staff, id, dto);
  }

  // ── Feedback ──
  @Get('feedback')
  @RequirePermission('viewFeedback')
  listFeedback() {
    return this.people.listFeedback();
  }

  @Patch('feedback/:id')
  @RequirePermission('viewFeedback')
  updateFeedback(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: FeedbackUpdateDto) {
    return this.people.updateFeedback(staff, id, dto);
  }

  // ── Students ──
  @Get('students')
  @RequirePermission('viewStudents')
  listStudents() {
    return this.people.listStudents();
  }

  @Patch('students/:id')
  @RequirePermission('viewStudents')
  @ApiOperation({ summary: 'Suspend / reactivate a student' })
  setStudentStatus(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: StudentStatusDto) {
    return this.people.setStudentStatus(staff, id, dto.status);
  }

  // ── Activity ──
  @Get('quiz-attempts')
  @ApiOperation({ summary: 'All quiz attempts (for overview metrics), without per-question answers' })
  listAttempts() {
    return this.people.listAttempts();
  }

  @Get('audit-log')
  @RequirePermission('viewAudit')
  listAudit() {
    return this.auditLog.list();
  }
}
