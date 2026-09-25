import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsMongoId,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class SubmittedAnswerDto {
  @ApiProperty()
  @IsMongoId()
  questionId: string;

  @ApiProperty({ nullable: true, description: 'Index into options; null when skipped' })
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  selectedIndex: number | null;
}

/** POST /quiz-attempts */
export class SubmitAttemptDto {
  @ApiProperty()
  @IsMongoId()
  topicId: string;

  @ApiProperty({ example: '2026-09-24T10:00:00.000Z' })
  @IsDateString()
  startedAt: string;

  @ApiProperty({ type: [SubmittedAnswerDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SubmittedAnswerDto)
  answers: SubmittedAnswerDto[];
}
