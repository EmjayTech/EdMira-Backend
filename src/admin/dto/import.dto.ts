import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { REVIEW_ACTIONS } from '../workflow';
import { AudienceRuleDto, MaterialSectionDto } from './admin.dto';

// Bulk import (POST /admin/import). Business rules — option counts, a marked
// answer, notes on new topics — are checked by AdminImportService so every
// problem is reported with its position, not just the first one.

export class ImportQuestionDto {
  @ApiProperty() @IsString() @MaxLength(2000) stem: string;
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) options: string[];
  @ApiProperty({ description: 'Index into options (0 = A)' }) @IsInt() answerIndex: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(4000) explanation?: string;
}

export class ImportVideoDto {
  @ApiProperty() @IsString() @MaxLength(200) title: string;
  @ApiProperty({ description: 'YouTube link' }) @IsString() @MaxLength(500) link: string;
  @ApiProperty({ required: false, example: 'Ninja Nerd · 31 min' }) @IsOptional() @IsString() @MaxLength(1000) description?: string;
}

export class ImportTopicDto {
  @ApiProperty() @IsString() @MaxLength(200) title: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(1000) summary?: string;
  @ApiProperty({ required: false, description: 'Position in the course; omit to add at the end' })
  @IsOptional() @IsInt() @Min(1)
  order?: number;
  @ApiProperty({ required: false, type: [MaterialSectionDto], description: 'Study notes. Needed for a new topic to go to review.' })
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => MaterialSectionDto)
  material?: MaterialSectionDto[];
  @ApiProperty({ required: false, type: [ImportQuestionDto] })
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => ImportQuestionDto)
  questions?: ImportQuestionDto[];
  @ApiProperty({ required: false, type: [ImportVideoDto], description: 'Recommended YouTube videos for the topic (study materials)' })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => ImportVideoDto)
  videos?: ImportVideoDto[];
}

export class ImportCourseDto {
  @ApiProperty({ description: 'Matched to an existing course by title (case-insensitive)' })
  @IsString() @MaxLength(120)
  title: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(6) code?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @ApiProperty({ required: false })
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'color must be a hex colour like #0A369D' })
  color?: string;
  @ApiProperty({ required: false, type: [AudienceRuleDto], description: 'Added to the course’s existing rules' })
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => AudienceRuleDto)
  audience?: AudienceRuleDto[];
  @ApiProperty({ type: [ImportTopicDto] })
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => ImportTopicDto)
  topics: ImportTopicDto[];
}

export class ImportDto {
  @ApiProperty({ type: [ImportCourseDto] })
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => ImportCourseDto)
  courses: ImportCourseDto[];

  @ApiProperty({ required: false, description: 'Check everything and report what would happen, without saving' })
  @IsOptional() @IsBoolean()
  dryRun?: boolean;

  @ApiProperty({
    required: false,
    description:
      'Admins only. Credit the content to the EdMira content library instead of you, for material you did not ' +
      'write (e.g. the AI-drafted starter library) — so you can review it yourself.',
  })
  @IsOptional() @IsBoolean()
  asLibrary?: boolean;
}

export class BulkTransitionItemDto {
  @ApiProperty({ enum: ['topic', 'question', 'resource'] })
  @IsIn(['topic', 'question', 'resource'])
  kind: 'topic' | 'question' | 'resource';
  @ApiProperty() @Matches(/^[0-9a-fA-F]{24}$/, { message: 'id must be a valid id' }) id: string;
}

export class BulkTransitionDto {
  @ApiProperty({ type: [BulkTransitionItemDto] })
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => BulkTransitionItemDto)
  items: BulkTransitionItemDto[];
  @ApiProperty({ enum: REVIEW_ACTIONS }) @IsIn(REVIEW_ACTIONS) action: (typeof REVIEW_ACTIONS)[number];
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class AiDraftDto {
  @ApiProperty({ minimum: 1, maximum: 20 }) @IsInt() @Min(1) @Max(20) count: number;
  @ApiProperty({ required: false, description: 'Optional steer, e.g. "clinical vignettes on management"' })
  @IsOptional() @IsString() @MaxLength(500)
  focus?: string;
}
