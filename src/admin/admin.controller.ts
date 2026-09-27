import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { extname } from 'path';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ALLOWED_UPLOAD_TYPES, FileStorageService, MAX_UPLOAD_BYTES } from '../storage/file-storage.service';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { AdminContentService } from './admin-content.service';
import { AdminNewsService } from './admin-news.service';
import { AdminPeopleService } from './admin-people.service';
import { AuditService } from './audit/audit.service';
import {
  CourseInputDto,
  CourseStatusDto,
  FeedbackUpdateDto,
  NewsInputDto,
  NewsStatusDto,
  QuestionInputDto,
  ReportUpdateDto,
  ResourceInputDto,
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
    private readonly newsAdmin: AdminNewsService,
    private readonly auditLog: AuditService,
    private readonly storage: FileStorageService,
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

  // ── Study materials ──
  @Get('resources')
  listResources() {
    return this.content.listResources();
  }

  @Post('resources')
  @RequirePermission('editContent')
  createResource(@CurrentStaff() staff: Staff, @Body() dto: ResourceInputDto) {
    return this.content.saveResource(staff, dto);
  }

  @Patch('resources/:id')
  @RequirePermission('editContent')
  updateResource(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: ResourceInputDto) {
    return this.content.saveResource(staff, dto, id);
  }

  @Post('resources/:id/transitions')
  transitionResource(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: TransitionDto) {
    return this.content.transition(staff, 'resource', id, dto);
  }

  @Get('resources/:id/file')
  @ApiOperation({ summary: 'A 15-minute link to preview an uploaded material' })
  resourceFile(@Param('id', ParseObjectIdPipe) id: string, @Req() req: Request) {
    return this.content.resourceFileLink(id, `${req.protocol}://${req.get('host')}`);
  }

  @Get('uploads/status')
  @ApiOperation({ summary: 'Whether file uploads are configured on this server' })
  uploadStatus() {
    return { enabled: this.storage.uploadsEnabled, maxBytes: MAX_UPLOAD_BYTES, types: Object.keys(ALLOWED_UPLOAD_TYPES) };
  }

  @Post('uploads')
  @RequirePermission('editContent')
  @ApiOperation({ summary: 'Upload a slide deck / textbook / notes file; returns the `file` for a material' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Choose a file to upload.');
    if (!ALLOWED_UPLOAD_TYPES[extname(file.originalname).toLowerCase()]) {
      throw new BadRequestException('Upload a PDF, PowerPoint, Word or EPUB file.');
    }
    return this.storage.save(file);
  }

  // ── News ──
  @Get('news')
  @RequirePermission('manageNews')
  @ApiOperation({ summary: 'All campus news, every status' })
  listNews() {
    return this.newsAdmin.list();
  }

  @Post('news')
  @RequirePermission('manageNews')
  createNews(@CurrentStaff() staff: Staff, @Body() dto: NewsInputDto) {
    return this.newsAdmin.save(staff, dto);
  }

  @Patch('news/:id')
  @RequirePermission('manageNews')
  updateNews(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: NewsInputDto) {
    return this.newsAdmin.save(staff, dto, id);
  }

  @Post('news/:id/status')
  @RequirePermission('manageNews')
  @ApiOperation({ summary: 'Publish / unpublish (draft) / archive a story (admin, no review)' })
  setNewsStatus(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: NewsStatusDto) {
    return this.newsAdmin.setStatus(staff, id, dto.status);
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
