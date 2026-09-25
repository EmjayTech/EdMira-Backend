import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Department } from '../../common/enum/department.enum';
import { Institution } from '../../common/enum/institution.enum';
import { Level } from '../../common/enum/level.enum';
import { normalizeLevel } from './studentProfile.dto';

/** Academic fields a student can change after sign-up. All optional. */
export class UpdateStudentProfileDto {
  @ApiProperty({ enum: Institution, required: false })
  @IsOptional()
  @IsEnum(Institution, { message: `institution must be one of: ${Object.values(Institution).join(', ')}` })
  institution?: Institution;

  @ApiProperty({ enum: Department, required: false })
  @IsOptional()
  @IsEnum(Department, { message: `department must be one of: ${Object.values(Department).join(', ')}` })
  department?: Department;

  @ApiProperty({ enum: Level, required: false, description: 'Also accepts "300", "300L", "300 level"…' })
  @IsOptional()
  @Transform(({ value }) => normalizeLevel(value))
  @IsEnum(Level, { message: `level must be one of: ${Object.values(Level).join(', ')}` })
  level?: Level;
}

/** PATCH /auth/profile */
export class UpdateProfileDto {
  @ApiProperty({ example: 'Ada', required: false })
  @IsOptional() @IsString() @IsNotEmpty()
  firstName?: string;

  @ApiProperty({ example: 'Obi', required: false })
  @IsOptional() @IsString() @IsNotEmpty()
  lastName?: string;

  @ApiProperty({ type: () => UpdateStudentProfileDto, required: false })
  @IsOptional() @ValidateNested() @Type(() => UpdateStudentProfileDto)
  studentProfile?: UpdateStudentProfileDto;
}
