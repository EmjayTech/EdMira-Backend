import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ContentStatus } from '../../common/enum/content-status.enum';
import { Department } from '../../common/enum/department.enum';
import { Institution } from '../../common/enum/institution.enum';
import { Level } from '../../common/enum/level.enum';
import { AccountStatus, StaffRole } from '../../common/enum/staff-role.enum';
import { RESOURCE_KINDS } from '../../content/schemas/resource.schema';
import { NEWS_CATEGORIES } from '../../news/news.schema';
import { REVIEW_ACTIONS } from '../workflow';

// Business rules (required text, option counts, …) are checked in workflow.ts
// so the messages match the dashboard; these DTOs only check types.

/** Blank ("any") department / institution skips validation. */
const unlessBlank = ValidateIf((_, value) => value !== '' && value != null);

/** One "who is this course for" rule. Department / institution omitted or '' = any. */
export class AudienceRuleDto {
  @ApiProperty({ enum: Level }) @IsIn(Object.values(Level)) level: Level;
  @ApiProperty({ enum: Department, required: false })
  @unlessBlank @IsIn(Object.values(Department))
  department?: Department;
  @ApiProperty({ enum: Institution, required: false })
  @unlessBlank @IsIn(Object.values(Institution))
  institution?: Institution;
}

export class CourseInputDto {
  @ApiProperty() @IsString() @MaxLength(120) title: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(6) code?: string;
  @ApiProperty({ required: false, example: '#0A369D' })
  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'color must be a hex colour like #0A369D' })
  color?: string;
  @ApiProperty({ required: false, type: [AudienceRuleDto], description: 'Empty = every student. Omit to leave unchanged.' })
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => AudienceRuleDto)
  audience?: AudienceRuleDto[];
}

export class CourseStatusDto {
  @ApiProperty({ enum: ContentStatus }) @IsIn(Object.values(ContentStatus)) status: ContentStatus;
}

export class MaterialSectionDto {
  @ApiProperty() @IsString() heading: string;
  @ApiProperty() @IsString() body: string;
  @ApiProperty({ required: false, type: [String] })
  @IsOptional() @IsArray() @IsString({ each: true })
  keyPoints?: string[];
}

export class TopicInputDto {
  @ApiProperty() @IsMongoId() courseId: string;
  @ApiProperty() @IsString() @MaxLength(200) title: string;
  @ApiProperty() @IsInt() order: number;
  @ApiProperty() @IsString() @MaxLength(1000) summary: string;
  @ApiProperty({ required: false, description: '0 = estimate from the text' })
  @IsOptional() @IsInt() @Min(0) readMinutes?: number;
  @ApiProperty({ type: [MaterialSectionDto] })
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => MaterialSectionDto)
  material: MaterialSectionDto[];
}

export class QuestionInputDto {
  @ApiProperty() @IsMongoId() topicId: string;
  @ApiProperty() @IsString() @MaxLength(2000) stem: string;
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) options: string[];
  @ApiProperty() @IsInt() answerIndex: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(4000) explanation?: string;
}

export class ResourceFileDto {
  @ApiProperty() @IsString() @Matches(/^materials\/[\w-]+\.\w+$/, { message: 'Upload the file again.' }) key: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiProperty() @IsInt() @Min(1) size: number;
  @ApiProperty() @IsString() mimeType: string;
}

export class ResourceInputDto {
  @ApiProperty() @IsMongoId() courseId: string;
  @ApiProperty({ required: false, description: 'Omit or "" for the whole course' })
  @unlessBlank @IsMongoId()
  topicId?: string;
  @ApiProperty({ enum: RESOURCE_KINDS }) @IsIn(RESOURCE_KINDS) kind: (typeof RESOURCE_KINDS)[number];
  @ApiProperty() @IsString() @MaxLength(200) title: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @ApiProperty({ enum: Institution, required: false, description: 'Omit or "" for every school' })
  @unlessBlank @IsIn(Object.values(Institution))
  institution?: Institution;
  @ApiProperty({ required: false, description: 'YouTube / web link (instead of a file)' })
  @IsOptional() @IsString() @MaxLength(2000)
  link?: string;
  @ApiProperty({ required: false, type: ResourceFileDto, description: 'From POST /admin/uploads' })
  @IsOptional() @ValidateNested() @Type(() => ResourceFileDto)
  file?: ResourceFileDto;
}

export class TransitionDto {
  @ApiProperty({ enum: REVIEW_ACTIONS }) @IsIn(REVIEW_ACTIONS) action: (typeof REVIEW_ACTIONS)[number];
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class ReportUpdateDto {
  @ApiProperty({ enum: ['open', 'resolved', 'dismissed'] })
  @IsIn(['open', 'resolved', 'dismissed'])
  status: 'open' | 'resolved' | 'dismissed';
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(1000) resolutionNote?: string;
}

export class FeedbackUpdateDto {
  @ApiProperty({ enum: ['new', 'reviewed', 'planned', 'wont_do'] })
  @IsIn(['new', 'reviewed', 'planned', 'wont_do'])
  status: 'new' | 'reviewed' | 'planned' | 'wont_do';
}

export class TeamInviteDto {
  @ApiProperty({ example: 'ada@edmira.org' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'Enter a valid email address.' })
  email: string;

  @ApiProperty({ example: 'Ada' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'Add their first name.' })
  @MaxLength(60)
  firstName: string;

  @ApiProperty({ example: 'Obi', required: false })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(60)
  lastName?: string;

  @ApiProperty({ enum: StaffRole }) @IsIn(Object.values(StaffRole)) role: StaffRole;
}

export class TeamRoleDto {
  @ApiProperty({ enum: StaffRole }) @IsIn(Object.values(StaffRole)) role: StaffRole;
}

/** Same password rule as student sign-up (auth/dto/signup.dto.ts). */
export class AcceptInviteDto {
  @ApiProperty({ example: 'Ada' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'Add your first name.' })
  @MaxLength(60)
  firstName: string;

  @ApiProperty({ example: 'Obi', required: false })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(60)
  lastName?: string;

  @ApiProperty({ example: 'StrongPass1!' })
  @IsString()
  @MinLength(8, { message: 'Use at least 8 characters.' })
  @MaxLength(128)
  @Matches(/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, {
    message: 'Password too weak. Must contain at least 1 uppercase, 1 lowercase, and 1 number or special character',
  })
  password: string;
}

export class StudentStatusDto {
  @ApiProperty({ enum: AccountStatus }) @IsIn(Object.values(AccountStatus)) status: AccountStatus;
}

/** Empty string = clear the field. */
const optionalUrl = (field: 'sourceUrl' | 'imageUrl') =>
  ValidateIf((o: NewsInputDto) => o[field] != null && o[field] !== '');

export class NewsInputDto {
  @ApiProperty() @IsString() @MaxLength(200) title: string;
  @ApiProperty() @IsString() @MaxLength(500) summary: string;
  @ApiProperty({ type: [String], description: 'Paragraphs' })
  @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(5000, { each: true })
  body: string[];
  @ApiProperty({ enum: NEWS_CATEGORIES }) @IsIn(NEWS_CATEGORIES) category: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(120) institution?: string;
  @ApiProperty({ required: false, example: 'EdMira' }) @IsOptional() @IsString() @MaxLength(80) source?: string;
  @ApiProperty({ required: false }) @optionalUrl('sourceUrl')
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true }, { message: 'Link to the original story must be a full web address (https://…).' })
  sourceUrl?: string;
  @ApiProperty({ required: false }) @optionalUrl('imageUrl')
  @IsUrl({ protocols: ['https'], require_protocol: true }, { message: 'Image must be an https:// web address.' })
  imageUrl?: string;
  @ApiProperty({ required: false, description: 'ISO date. In the future = scheduled. Omit to use the publish time.' })
  @IsOptional() @IsISO8601({}, { message: 'Publish date must be a valid date.' })
  publishedAt?: string;
}

export const NEWS_STATUSES = [ContentStatus.DRAFT, ContentStatus.PUBLISHED, ContentStatus.ARCHIVED] as const;

export class NewsStatusDto {
  @ApiProperty({ enum: NEWS_STATUSES }) @IsIn(NEWS_STATUSES) status: (typeof NEWS_STATUSES)[number];
}

export class NewsBulkStatusDto {
  @ApiProperty({ type: [String] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsMongoId({ each: true })
  ids: string[];
  @ApiProperty({ enum: NEWS_STATUSES }) @IsIn(NEWS_STATUSES) status: (typeof NEWS_STATUSES)[number];
}

export class NewsSourceInputDto {
  @ApiProperty({ example: 'NCDC' }) @IsString() @MaxLength(80) name: string;
  @ApiProperty({ example: 'https://ncdc.gov.ng/', description: 'Homepage, news page or RSS/Atom feed' })
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true }, { message: 'Source address must be a full web address (https://…).' })
  @MaxLength(500)
  url: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(120) institution?: string;
  @ApiProperty({ required: false, default: true }) @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiProperty({ required: false, default: false, description: 'Publish found stories without waiting as drafts' })
  @IsOptional() @IsBoolean() autoPublish?: boolean;
}

/** Admin leaderboard filters. `week` is a Lagos Monday, e.g. "2026-11-16" (default: this week). */
export class AdminLeaderboardQuery {
  @ApiProperty({ required: false, example: '2026-11-16' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) week?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(120) institution?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(120) department?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(60) level?: string;
}

export class ModerationListQuery {
  @ApiProperty({ required: false, enum: ['open', 'resolved'] }) @IsOptional() @IsIn(['open', 'resolved']) status?: 'open' | 'resolved';
}

export class ModerationActionDto {
  @ApiProperty({ enum: ['dismiss', 'warn', 'rename', 'suspend', 'ban'] })
  @IsIn(['dismiss', 'warn', 'rename', 'suspend', 'ban'])
  action: 'dismiss' | 'warn' | 'rename' | 'suspend' | 'ban';

  @ApiProperty({ required: false, description: 'Suspend: 1–365 days' }) @IsOptional() @IsInt() @Min(1) days?: number;
  @ApiProperty({ required: false, description: 'Rename: the new username' }) @IsOptional() @IsString() @MaxLength(64) username?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class SecurityEventsQuery {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(40) type?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(64) username?: string;
}

export class DateRangeQuery {
  @ApiProperty({ required: false, example: '2026-11-01' }) @IsOptional() @IsISO8601() from?: string;
  @ApiProperty({ required: false, example: '2026-12-01' }) @IsOptional() @IsISO8601() to?: string;
}

export class GroupSearchQuery {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(60) q?: string;
}

export class BadgeDto {
  @ApiProperty({ enum: ['founding_tester', 'campus_ambassador'] }) @IsIn(['founding_tester', 'campus_ambassador']) badge: 'founding_tester' | 'campus_ambassador';
  @ApiProperty() @IsBoolean() give: boolean;
}
