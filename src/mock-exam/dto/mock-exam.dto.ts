import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsMongoId, IsOptional, ValidateNested } from 'class-validator';
import { SubmittedAnswerDto } from '../../quiz/dto/submit-attempt.dto';

export const MOCK_EXAM_SIZES = [10, 20, 40, 60];

/** POST /mock-exams */
export class StartMockExamDto {
  @ApiProperty()
  @IsMongoId()
  courseId: string;

  @ApiPropertyOptional({ enum: MOCK_EXAM_SIZES, default: 20 })
  @IsOptional()
  @IsIn(MOCK_EXAM_SIZES)
  questionCount?: number;
}

/** POST /mock-exams/:id/submit */
export class SubmitMockExamDto {
  @ApiProperty({ type: [SubmittedAnswerDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SubmittedAnswerDto)
  answers: SubmittedAnswerDto[];
}
