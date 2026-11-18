import { publicBaseUrl } from '../common/public-url';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
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
import { AdminTeamService } from './admin-team.service';
import { AiDraftService } from './ai-draft.service';
import { AiNewsService } from './ai-news.service';
import { AiDraftDto, BulkTransitionDto, ImportDto } from './dto/import.dto';
import { AuditService } from './audit/audit.service';
import { TopicVersionsService } from '../content/topic-versions.service';
import {
  CourseInputDto,
  CourseStatusDto,
  FeedbackUpdateDto,
  NewsBulkStatusDto,
  NewsInputDto,
  NewsSourceInputDto,
  NewsStatusDto,
  QuestionInputDto,
  ReportUpdateDto,
  ResourceInputDto,
  StudentStatusDto,
  TeamInviteDto,
  TeamRoleDto,
  TopicInputDto,
  TransitionDto,
} from './dto/admin.dto';
import { ChangeUsernameDto } from '../auth/dto/change-username.dto';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { isWeekId, weekOf } from '../leaderboard/week';
import { AdminLeaderboardQuery } from './dto/admin.dto';
import { ModerationService } from '../social/moderation.service';
import { ModerationActionDto, ModerationListQuery, SecurityEventsQuery } from './dto/admin.dto';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ReferralsService } from '../social/referrals.service';
import { Challenge, ChallengeDocument } from '../social/schemas/challenge.schema';
import { DateRangeQuery } from './dto/admin.dto';
import { GroupsService } from '../social/groups.service';
import { BadgesService } from '../social/badges.service';
import { NotificationsService } from '../social/notifications.service';
import { AvatarService } from '../avatars/avatar.service';
import { User, UserDocument } from '../users/model/user.model';
import { BadgeDto, GroupSearchQuery } from './dto/admin.dto';
import { CurrentStaff, RequirePermission, Staff, StaffGuard } from './staff.guard';
import { QotdService } from '../study/qotd/qotd.service';
import { LeaderboardAdminService } from '../leaderboard/leaderboard-admin.service';
import { SettingsService } from '../settings/settings.service';
import { previousWeek } from '../leaderboard/week';
import {
  FlagActionDto,
  FlagListQuery,
  LeaderboardExclusionDto,
  ReasonDto,
  ReferralActionDto,
  VersionTransitionDto,
  ResolveFlagDto,
  SchoolCodesDto,
  ContributorDto,
  SavedWinnersQuery,
  SettingsDto,
} from './dto/admin.dto';
import { AdminQotdPinDto, AdminQotdQuery, AdminQotdTarget } from './dto/admin.dto';
import { lagosDay } from '../leaderboard/week';

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
    private readonly team: AdminTeamService,
    private readonly newsAdmin: AdminNewsService,
    private readonly auditLog: AuditService,
    private readonly storage: FileStorageService,
    private readonly ai: AiDraftService,
    private readonly aiNews: AiNewsService,
    private readonly leaderboards: LeaderboardService,
    private readonly moderation: ModerationService,
    private readonly referrals: ReferralsService,
    private readonly groupsAdmin: GroupsService,
    private readonly badges: BadgesService,
    private readonly qotd: QotdService,
    private readonly leaderboardAdmin: LeaderboardAdminService,
    private readonly settings: SettingsService,
    private readonly versions: TopicVersionsService,
    private readonly avatars: AvatarService,
    private readonly notifications: NotificationsService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Challenge.name) private readonly challengeModel: Model<ChallengeDocument>,
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

  // ── Versioned notes (imports land here; live notes change only on approval) ──
  @Get('topic-versions')
  @ApiOperation({ summary: 'Notes versions waiting for review (in review / changes requested)' })
  pendingVersions() {
    return this.versions.pending();
  }

  @Get('topics/:id/versions')
  @ApiOperation({ summary: "Every version of a topic's notes, newest first" })
  topicVersions(@Param('id', ParseObjectIdPipe) id: string) {
    return this.versions.history(id);
  }

  @Get('topic-versions/:id')
  @ApiOperation({ summary: 'One version, the live notes to compare it with, and its questions' })
  topicVersion(@Param('id', ParseObjectIdPipe) id: string) {
    return this.versions.detail(id);
  }

  @Post('topic-versions/:id/transitions')
  @RequirePermission('review')
  @ApiOperation({ summary: 'approve (goes live, replaces the old version) | request_changes | reject | restore (roll back to this earlier version)' })
  async transitionVersion(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: VersionTransitionDto) {
    const result = await this.versions.transition(staff, id, dto.action, dto.note);
    const v = await this.versions.detail(id);
    await this.auditLog.log(
      staff,
      'topic',
      v.version.topicId,
      `version_${dto.action}`,
      `${dto.action === 'restore' ? 'Restored' : dto.action === 'approve' ? 'Approved' : dto.action === 'reject' ? 'Rejected' : 'Sent back'} notes v${v.version.version} of “${v.version.topicTitle}”${dto.note ? `: ${dto.note}` : ''}`,
    );
    return result;
  }

  @Post('topic-versions/:id/flags/:flagId')
  @RequirePermission('review')
  @ApiOperation({ summary: 'Resolve one "⚑" check: confirm, correct (with text) or remove — recorded with who resolved it' })
  async resolveFlag(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Param('flagId') flagId: string, @Body() dto: ResolveFlagDto) {
    const result = await this.versions.resolveFlag(staff, id, flagId, dto.action, dto.text, dto.note);
    await this.auditLog.log(staff, 'topic', id, `flag_${result.status}`, `${result.status[0].toUpperCase()}${result.status.slice(1)} a ⚑ check (${result.where})${dto.note ? `: ${dto.note}` : ''}`);
    return result;
  }

  // ── Curriculum: each school's course codes → modules (editable, for ambassadors' outlines) ──
  @Get('curriculum/:subject')
  @ApiOperation({ summary: "A subject's module tree and every school's course codes" })
  curriculum(@Param('subject') subject: string) {
    return this.versions.curriculum(subject);
  }

  @Put('curriculum/:subject/schools/:key')
  @RequirePermission('editContent')
  @ApiOperation({ summary: "Add or replace a school's course code → module mapping" })
  async saveSchoolCodes(@CurrentStaff() staff: Staff, @Param('subject') subject: string, @Param('key') key: string, @Body() dto: SchoolCodesDto) {
    const saved = await this.versions.saveSchool(subject, { key, school: dto.school, verified: !!dto.verified, institution: dto.institution ?? null, source: dto.source ?? null, courses: dto.courses.map(c => ({ code: c.code ?? null, title: c.title ?? null, modules: c.modules })) }, staff.name);
    await this.auditLog.log(staff, 'curriculum', `${subject}/${key}`, 'school_saved', `Saved ${saved.courses.length} course codes for ${saved.school} (${subject})`);
    return saved;
  }

  @Delete('curriculum/:subject/schools/:key')
  @RequirePermission('editContent')
  @ApiOperation({ summary: "Remove a school's course codes" })
  async removeSchoolCodes(@CurrentStaff() staff: Staff, @Param('subject') subject: string, @Param('key') key: string) {
    const result = await this.versions.removeSchool(subject, key);
    await this.auditLog.log(staff, 'curriculum', `${subject}/${key}`, 'school_removed', `Removed ${key}'s course codes (${subject})`);
    return result;
  }

  // ── Contributors (lecturers' own notes, with permission on record) ──
  @Get('contributors')
  listContributors() {
    return this.versions.listContributors();
  }

  @Post('contributors')
  @RequirePermission('editContent')
  async createContributor(@CurrentStaff() staff: Staff, @Body() dto: ContributorDto) {
    const saved = await this.versions.saveContributor(dto as never, staff.name);
    await this.auditLog.log(staff, 'contributor', dto.key, 'created', `Added contributor ${dto.name} (permission ${dto.permissionGranted ? 'granted' : 'not granted'})`);
    return saved;
  }

  @Patch('contributors/:id')
  @RequirePermission('editContent')
  async updateContributor(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: ContributorDto) {
    const saved = await this.versions.saveContributor(dto as never, staff.name, id);
    await this.auditLog.log(staff, 'contributor', dto.key, 'updated', `Updated contributor ${dto.name} (permission ${dto.permissionGranted ? 'granted' : 'not granted'})`);
    return saved;
  }

  // ── Bulk tools ──
  @Post('import')
  @RequirePermission('editContent')
  @ApiOperation({ summary: 'Import courses → topics → questions (spreadsheet / JSON). Lands in the review queue.' })
  importContent(@CurrentStaff() staff: Staff, @Body() dto: ImportDto) {
    return this.content.importContent(staff, dto);
  }

  @Post('transitions/bulk')
  @ApiOperation({ summary: 'Apply one workflow action to many topics / questions / materials' })
  bulkTransition(@CurrentStaff() staff: Staff, @Body() dto: BulkTransitionDto) {
    return this.content.bulkTransition(staff, dto);
  }

  @Get('ai/status')
  @ApiOperation({ summary: 'Whether AI question drafting is configured on this server' })
  aiStatus() {
    return { enabled: this.ai.enabled };
  }

  @Post('topics/:id/ai-questions')
  @RequirePermission('editContent')
  @ApiOperation({ summary: 'Draft practice questions for a topic with AI; they go to the review queue' })
  draftQuestions(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: AiDraftDto) {
    return this.ai.draftQuestions(staff, id, dto.count, dto.focus);
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
    return this.content.resourceFileLink(id, publicBaseUrl(req));
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

  @Get('news/ai')
  @RequirePermission('manageNews')
  @ApiOperation({ summary: 'AI news: on/off, schedule, last run and the list of trusted sources' })
  newsAiStatus() {
    return this.aiNews.status();
  }

  @Post('news/fetch')
  @RequirePermission('manageNews')
  @ApiOperation({ summary: 'Check every enabled source now; new stories arrive as drafts (or published for auto-publish sources)' })
  fetchNews(@CurrentStaff() staff: Staff) {
    return this.aiNews.runNow(staff);
  }

  @Post('news/sources')
  @RequirePermission('manageNews')
  createNewsSource(@CurrentStaff() staff: Staff, @Body() dto: NewsSourceInputDto) {
    return this.aiNews.saveSource(staff, dto);
  }

  @Post('news/sources/defaults')
  @RequirePermission('manageNews')
  @ApiOperation({ summary: 'Add the suggested list of official sources (skips ones already added)' })
  addDefaultNewsSources(@CurrentStaff() staff: Staff) {
    return this.aiNews.addDefaults(staff);
  }

  @Patch('news/sources/:id')
  @RequirePermission('manageNews')
  updateNewsSource(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: NewsSourceInputDto) {
    return this.aiNews.saveSource(staff, dto, id);
  }

  @Delete('news/sources/:id')
  @RequirePermission('manageNews')
  deleteNewsSource(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string) {
    return this.aiNews.deleteSource(staff, id);
  }

  @Post('news/bulk-status')
  @RequirePermission('manageNews')
  @ApiOperation({ summary: 'Publish / unpublish / archive several stories → { done, failed }' })
  bulkNewsStatus(@CurrentStaff() staff: Staff, @Body() dto: NewsBulkStatusDto) {
    return this.newsAdmin.bulkStatus(staff, dto.ids, dto.status);
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

  @Patch('students/:id/username')
  @RequirePermission('viewStudents')
  @ApiOperation({ summary: 'Change a student\'s username (moderation; skips the 30-day limit)' })
  changeStudentUsername(
    @CurrentStaff() staff: Staff,
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: ChangeUsernameDto,
  ) {
    return this.people.changeStudentUsername(staff, id, dto.username);
  }

  @Get('students/:id/usernames')
  @RequirePermission('viewStudents')
  @ApiOperation({ summary: 'A student\'s previous usernames' })
  studentUsernameHistory(@Param('id', ParseObjectIdPipe) id: string) {
    return this.people.studentUsernameHistory(id);
  }

  // ── Leaderboards (names included, for prizes) ──
  @Get('leaderboards')
  @RequirePermission('viewStudents')
  @ApiOperation({ summary: 'A week\'s leaderboard (top 50) with names, optionally for one school / programme / level' })
  adminLeaderboard(@Query() query: AdminLeaderboardQuery) {
    const week = query.week ?? weekOf(new Date());
    if (!isWeekId(week)) throw new BadRequestException('week must be a Monday, e.g. 2026-11-16.');
    return this.leaderboards.adminBoard(week, query);
  }

  @Get('leaderboards/winners')
  @RequirePermission('viewStudents')
  @ApiOperation({ summary: 'Top 3 of All of EdMira for each of the last 8 weeks' })
  leaderboardWinners() {
    return this.leaderboards.winners(8);
  }

  @Get('leaderboards/schools')
  @RequirePermission('viewStudents')
  @ApiOperation({ summary: 'School against school for a week' })
  leaderboardSchools(@Query() query: AdminLeaderboardQuery) {
    const week = query.week ?? weekOf(new Date());
    if (!isWeekId(week)) throw new BadRequestException('week must be a Monday, e.g. 2026-11-16.');
    return this.leaderboards.schools(week);
  }

  @Get('leaderboards/saved-winners')
  @RequirePermission('viewStudents')
  @ApiOperation({ summary: 'The top 10 of every board, saved when the week closed (default: last week)' })
  savedWinners(@Query() query: SavedWinnersQuery) {
    const week = query.week ?? previousWeek(weekOf(new Date()));
    if (!isWeekId(week)) throw new BadRequestException('week must be a Monday, e.g. 2026-11-16.');
    return this.leaderboardAdmin.savedWinners(week, query.scope);
  }

  @Get('leaderboards/insights')
  @RequirePermission('viewStudents')
  @ApiOperation({ summary: 'Per closed week: students on the board, and next-week study days of viewers vs others' })
  leaderboardInsights() {
    return this.leaderboardAdmin.insights(8);
  }

  @Get('leaderboards/flags')
  @RequirePermission('manageLeaderboards')
  @ApiOperation({ summary: 'Suspicious activity for review (too fast, point bursts, near-perfect volume, shared network)' })
  leaderboardFlags(@Query() query: FlagListQuery) {
    return this.leaderboardAdmin.listFlags(query.status ?? 'open');
  }

  @Post('leaderboards/flags/:id')
  @RequirePermission('manageLeaderboards')
  @ApiOperation({ summary: 'Handle a flag: dismiss · exclude the student from leaderboards · reset their points this week' })
  async actOnFlag(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: FlagActionDto) {
    const result = await this.leaderboardAdmin.actOnFlag(id, dto.action, dto.reason ?? '', staff.name);
    const verb = { dismiss: 'Dismissed a leaderboard flag', exclude: 'Excluded a student from leaderboards (flag)', reset: "Reset a student's weekly points (flag)" }[dto.action];
    await this.auditLog.log(staff, 'student', result.studentId, `flag_${dto.action}`, dto.reason ? `${verb}: ${dto.reason}` : verb);
    return result;
  }

  @Patch('students/:id/leaderboard')
  @RequirePermission('manageLeaderboards')
  @ApiOperation({ summary: 'Exclude a student from every leaderboard (with a reason), or return them' })
  async setLeaderboardExclusion(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: LeaderboardExclusionDto) {
    const result = await this.leaderboardAdmin.setExclusion(id, dto.excluded, dto.reason ?? '', staff.name);
    await this.auditLog.log(
      staff,
      'student',
      id,
      dto.excluded ? 'leaderboard_excluded' : 'leaderboard_restored',
      dto.excluded ? `Excluded from leaderboards: ${dto.reason}` : 'Returned to leaderboards',
    );
    return result;
  }

  @Post('students/:id/leaderboard/reset')
  @RequirePermission('manageLeaderboards')
  @ApiOperation({ summary: "Reset a student's points this week to 0 (with a reason)" })
  async resetStudentWeek(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: ReasonDto) {
    const result = await this.leaderboardAdmin.resetWeek(id, dto.reason, staff.name);
    await this.auditLog.log(staff, 'student', id, 'leaderboard_reset', `Reset weekly points (${result.removed}): ${dto.reason}`);
    return result;
  }

  @Get('settings')
  @RequirePermission('manageLeaderboards')
  @ApiOperation({ summary: 'Points values, daily cap and leaderboard rules (with defaults)' })
  getSettings() {
    return this.settings.all();
  }

  @Put('settings')
  @RequirePermission('manageLeaderboards')
  @ApiOperation({ summary: 'Change points values / leaderboard rules (validated ranges). Applies to new activity.' })
  async updateSettings(@CurrentStaff() staff: Staff, @Body() dto: SettingsDto) {
    const result = await this.settings.update(dto as never, staff.name);
    const changed = [...Object.entries(dto.points ?? {}), ...Object.entries(dto.leaderboard ?? {})].map(([k, v]) => `${k}=${v}`).join(', ');
    await this.auditLog.log(staff, 'settings', 'points', 'updated', `Changed settings: ${changed || 'nothing'}`);
    return result;
  }

  // ── Question of the Day (pins; picked automatically otherwise) ──
  @Get('qotd')
  @RequirePermission('review')
  @ApiOperation({ summary: "Every group's Question of the Day for a Lagos date (default today)" })
  listQotd(@Query() query: AdminQotdQuery) {
    return this.qotd.listForDay(query.day ?? lagosDay(new Date()));
  }

  @Put('qotd')
  @RequirePermission('review')
  @ApiOperation({ summary: 'Pin a published question as a group’s QOTD for today or a future day (not once students have answered)' })
  async pinQotd(@CurrentStaff() staff: Staff, @Body() dto: AdminQotdPinDto) {
    const result = await this.qotd.pin(dto.day, dto.group, dto.questionId, staff.name);
    await this.auditLog.log(staff, 'qotd', `${dto.day}/${dto.group}`, 'pinned', `Pinned a Question of the Day for ${dto.group} on ${dto.day}`);
    return result;
  }

  @Delete('qotd')
  @RequirePermission('review')
  @ApiOperation({ summary: 'Remove a pin (the question is then picked automatically)' })
  async unpinQotd(@CurrentStaff() staff: Staff, @Query() query: AdminQotdTarget) {
    const result = await this.qotd.unpin(query.day, query.group);
    await this.auditLog.log(staff, 'qotd', `${query.day}/${query.group}`, 'unpinned', `Removed the Question of the Day pin for ${query.group} on ${query.day}`);
    return result;
  }

  // ── Moderation (student reports, flags, security log) ──
  @Get('moderation/reports')
  @RequirePermission('moderateStudents')
  @ApiOperation({ summary: 'Student reports with evidence (open by default)' })
  moderationReports(@Query() query: ModerationListQuery) {
    return this.moderation.listReports(query.status ?? 'open');
  }

  @Post('moderation/reports/:id/action')
  @RequirePermission('moderateStudents')
  @ApiOperation({ summary: 'Dismiss · warn · rename (username) · remove_photo · suspend (days) · ban — resolves the report' })
  async moderate(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: ModerationActionDto) {
    const { summary, studentId } = await this.moderation.act(staff, id, dto);
    await this.auditLog.log(staff, 'student', studentId, `moderation_${dto.action}`, summary);
    return { ok: true, summary };
  }

  @Get('moderation/flagged')
  @RequirePermission('moderateStudents')
  @ApiOperation({ summary: 'Auto-flagged students (requests paused until reviewed)' })
  flaggedStudents() {
    return this.moderation.flagged();
  }

  @Post('moderation/flagged/:id/clear')
  @RequirePermission('moderateStudents')
  @ApiOperation({ summary: 'Reviewed: lift the flag and the pause on requests' })
  async clearFlag(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string) {
    const { username } = await this.moderation.clearFlag(id);
    await this.auditLog.log(staff, 'student', id, 'flag_cleared', `Cleared the review flag on @${username}`);
    return { ok: true };
  }

  @Get('moderation/security-events')
  @RequirePermission('moderateStudents')
  @ApiOperation({ summary: 'Security log (newest 200), optionally by type or @username' })
  securityEvents(@Query() query: SecurityEventsQuery) {
    return this.moderation.securityEvents(query);
  }

  // ── Referrals & challenges ──
  @Get('referrals')
  @RequirePermission('viewStudents')
  @ApiOperation({ summary: 'Invites that led to sign-ups: per student and per school (optionally from/to dates)' })
  referralReport(@Query() query: DateRangeQuery) {
    return this.referrals.adminReport(query.from ? new Date(query.from) : undefined, query.to ? new Date(query.to) : undefined);
  }

  @Get('referrals/students/:id')
  @RequirePermission('viewStudents')
  @ApiOperation({ summary: "Everyone one student invited, with each referral's status, reward and shared phone / network signs" })
  referralStudent(@Param('id', ParseObjectIdPipe) id: string) {
    return this.referrals.adminStudent(id);
  }

  @Post('referrals/:refereeId/action')
  @RequirePermission('manageLeaderboards')
  @ApiOperation({ summary: "Approve a held referral, reject one, or reverse a reward (duplicate / fake account) — reason needed to reject or reverse" })
  async referralAction(@CurrentStaff() staff: Staff, @Param('refereeId', ParseObjectIdPipe) refereeId: string, @Body() dto: ReferralActionDto) {
    const result = await this.referrals.adminAction(refereeId, dto.action, dto.reason, staff.name);
    await this.auditLog.log(staff, 'student', refereeId, `referral_${dto.action}`, `Referral ${dto.action}${dto.reason ? `: ${dto.reason}` : ''} → ${result.status}`);
    return result;
  }

  @Get('challenges/stats')
  @RequirePermission('viewStudents')
  @ApiOperation({ summary: 'Challenges sent and completed (last 7 days and all time)' })
  async challengeStats() {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const [sentWeek, completedWeek, total, completed] = await Promise.all([
      this.challengeModel.countDocuments({ createdAt: { $gte: weekAgo } }),
      this.challengeModel.countDocuments({ status: 'completed', updatedAt: { $gte: weekAgo } }),
      this.challengeModel.countDocuments({}),
      this.challengeModel.countDocuments({ status: 'completed' }),
    ]);
    return { sentWeek, completedWeek, total, completed };
  }

  // ── Study groups (moderation) ──
  @Get('groups')
  @RequirePermission('moderateStudents')
  adminGroups(@Query() query: GroupSearchQuery) {
    return this.groupsAdmin.adminList(query.q);
  }

  @Get('groups/:id')
  @RequirePermission('moderateStudents')
  adminGroup(@Param('id', ParseObjectIdPipe) id: string) {
    return this.groupsAdmin.adminDetail(id);
  }

  @Delete('groups/:id')
  @RequirePermission('moderateStudents')
  @ApiOperation({ summary: 'Delete a study group (moderation)' })
  async deleteGroup(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string) {
    const { name, memberCount, ownerId } = await this.groupsAdmin.adminDelete(id);
    // Logged against the owner so the activity log links to a real student.
    await this.auditLog.log(staff, 'student', ownerId, 'group_deleted', `Deleted study group “${name}” (${memberCount} members)`);
    return { ok: true };
  }

  // ── Profile photo ──
  @Delete('students/:id/avatar')
  @RequirePermission('moderateStudents')
  @ApiOperation({ summary: "Remove a student's uploaded profile photo (back to initials); logged and the student is told" })
  async removeStudentPhoto(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string) {
    const u = await this.userModel.findById(id).select('username role').lean().exec();
    if (!u || u.role) throw new BadRequestException('That student no longer exists.');
    if (!(await this.avatars.removeForModeration(id))) throw new BadRequestException('This student has no uploaded photo now.');
    await this.notifications.notify(u._id, 'avatar_removed');
    await this.auditLog.log(staff, 'student', id, 'avatar_removed', `Removed the profile photo of @${u.username}`);
    return { ok: true };
  }

  // ── Badges ──
  @Get('students/:id/badges')
  @RequirePermission('viewStudents')
  async studentBadges(@Param('id', ParseObjectIdPipe) id: string) {
    const u = await this.userModel.findById(id).select('badgeOverrides').lean().exec();
    return { badges: await this.badges.badgesOf(id), overrides: u?.badgeOverrides ?? {} };
  }

  @Patch('students/:id/badges')
  @RequirePermission('viewStudents')
  @ApiOperation({ summary: 'Give or take away a manual badge (founding_tester, campus_ambassador)' })
  async setBadge(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: BadgeDto) {
    const u = await this.userModel.findById(id).exec();
    if (!u || u.role) throw new BadRequestException('That student no longer exists.');
    const granted = new Set(u.badgeOverrides?.granted ?? []);
    const revoked = new Set(u.badgeOverrides?.revoked ?? []);
    if (dto.give) {
      granted.add(dto.badge);
      revoked.delete(dto.badge);
    } else {
      granted.delete(dto.badge);
      revoked.add(dto.badge);
    }
    u.badgeOverrides = { granted: [...granted], revoked: [...revoked] };
    u.markModified('badgeOverrides');
    await u.save();
    await this.auditLog.log(staff, 'student', id, 'badge_changed', `${dto.give ? 'Gave' : 'Took away'} the ${dto.badge.replace('_', ' ')} badge ${dto.give ? 'to' : 'from'} @${u.username}`);
    return { badges: await this.badges.badgesOf(id), overrides: u.badgeOverrides };
  }

  // ── Team (staff accounts) ──
  @Get('team')
  @RequirePermission('manageTeam')
  listTeam() {
    return this.team.list();
  }

  @Post('team')
  @RequirePermission('manageTeam')
  @ApiOperation({ summary: 'Invite a staff member (or give an existing account staff access)' })
  inviteMember(@CurrentStaff() staff: Staff, @Body() dto: TeamInviteDto, @Req() req: Request) {
    return this.team.invite(staff, dto, req.headers.origin);
  }

  @Patch('team/:id')
  @RequirePermission('manageTeam')
  @ApiOperation({ summary: "Change a staff member's role" })
  setMemberRole(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: TeamRoleDto) {
    return this.team.setRole(staff, id, dto.role);
  }

  @Post('team/:id/invite')
  @RequirePermission('manageTeam')
  @ApiOperation({ summary: 'Send a new invite link (the old one stops working)' })
  resendInvite(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string, @Req() req: Request) {
    return this.team.resendInvite(staff, id, req.headers.origin);
  }

  @Delete('team/:id')
  @RequirePermission('manageTeam')
  @ApiOperation({ summary: 'Remove dashboard access (cancels an unaccepted invite)' })
  removeMember(@CurrentStaff() staff: Staff, @Param('id', ParseObjectIdPipe) id: string) {
    return this.team.remove(staff, id);
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
