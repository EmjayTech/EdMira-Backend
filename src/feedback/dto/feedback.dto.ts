import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { FEEDBACK_AREAS, REPORT_REASONS } from '../feedback.schemas';

/** POST /questions/:questionId/reports */
export class CreateReportDto {
  @ApiProperty()
  @IsMongoId()
  topicId: string;

  @ApiProperty({ enum: REPORT_REASONS })
  @IsIn(REPORT_REASONS)
  reason: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** POST /feedback */
export class CreateFeedbackDto {
  @ApiProperty({ enum: FEEDBACK_AREAS })
  @IsIn(FEEDBACK_AREAS)
  area: string;

  @ApiProperty({ nullable: true, minimum: 1, maximum: 5 })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number | null;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  message: string;
}
