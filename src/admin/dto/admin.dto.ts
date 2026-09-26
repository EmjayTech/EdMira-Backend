import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ContentStatus } from '../../common/enum/content-status.enum';
import { AccountStatus } from '../../common/enum/staff-role.enum';
import { NEWS_CATEGORIES } from '../../news/news.schema';
import { REVIEW_ACTIONS } from '../workflow';

// Business rules (required text, option counts, …) are checked in workflow.ts
// so the messages match the dashboard; these DTOs only check types.

export class CourseInputDto {
  @ApiProperty() @IsString() @MaxLength(120) title: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(6) code?: string;
  @ApiProperty({ required: false, example: '#0A369D' })
  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'color must be a hex colour like #0A369D' })
  color?: string;
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
