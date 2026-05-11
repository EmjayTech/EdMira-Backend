import { IsEnum, IsNotEmpty, IsString } from "class-validator";
import { Transform } from "class-transformer";
import { ApiProperty } from "@nestjs/swagger";
import { Institution } from "src/common/enum/institution.enum";
import { Department } from "src/common/enum/department.enum";
import { Level, LevelType } from "src/common/enum/level.enum";

const LEVEL_BY_DIGITS: Record<string, Level> = {
  '100': Level.LEVEL_100,
  '200': Level.LEVEL_200,
  '300': Level.LEVEL_300,
  '400': Level.LEVEL_400,
  '500': Level.LEVEL_500,
  '600': Level.LEVEL_600,
};

function normalizeLevel(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const match = value.trim().match(/^(\d{3})\s*(l|level)?$/i);
  if (!match) return value;
  return LEVEL_BY_DIGITS[match[1]] ?? value;
}

function normalizeLevelType(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const v = value.trim().toLowerCase();
  if (v === 'undergraduate' || v === 'ug') return LevelType.UNDERGRADUATE;
  if (v === 'postgraduate' || v === 'pg') return LevelType.POSTGRADUATE;
  return value;
}

export class StudentProfileDto {
  @ApiProperty({ enum: Institution, example: Institution.UNIVERSITY_OF_LAGOS })
  @IsEnum(Institution, { message: `institution must be one of: ${Object.values(Institution).join(', ')}` })
  institution: Institution;

  @ApiProperty({ example: 'Medical Sciences' })
  @IsString()
  @IsNotEmpty()
  faculty: string;

  @ApiProperty({ enum: Department, example: Department.MEDICINE_AND_SURGERY })
  @IsEnum(Department, { message: `department must be one of: ${Object.values(Department).join(', ')}` })
  department: Department;

  @ApiProperty({ enum: LevelType, example: LevelType.UNDERGRADUATE })
  @Transform(({ value }) => normalizeLevelType(value))
  @IsEnum(LevelType, { message: `levelType must be one of: ${Object.values(LevelType).join(', ')}` })
  levelType: LevelType;

  @ApiProperty({
    enum: Level,
    example: Level.LEVEL_500,
    description: 'Accepts flexible formats: "100", "100l", "100L", "100level", "100Level", "100 level", "100 Level"',
  })
  @Transform(({ value }) => normalizeLevel(value))
  @IsEnum(Level, { message: `level must be one of: ${Object.values(Level).join(', ')}` })
  level: Level;
}