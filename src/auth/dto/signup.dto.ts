import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
  IsEnum,
  MinLength,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UserType } from '../../common/enum/user-type.enum';
import { StudentProfileDto } from './studentProfile.dto';
import { ProfessionalProfileDto } from './professionalProfile.dto';
import { ApiProperty } from '@nestjs/swagger';



export class SignupDto {

  @ApiProperty({ example: 'John' })
  @IsString() @IsNotEmpty() firstName: string;

  @ApiProperty({ example: 'Doe' })
  @IsString() @IsNotEmpty() lastName: string;

  @ApiProperty({ example: 'johndoe' })
  @IsString() @IsNotEmpty() username: string;

  @ApiProperty({ example: 'john@example.com' })
  @IsEmail() email: string;

  @ApiProperty({ example: 'StrongPass1!' })
  @IsString()
  @MinLength(8)
  // Enforce: At least one digit OR special char, At least one uppercase, At least one lowercase.
  // Note: The regex provided in the implementation plan was:
  // /((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/
  @Matches(/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, { message: 'Password too weak. Must contain at least 1 uppercase, 1 lowercase, and 1 number or special character' })
  password: string;

  @ApiProperty({ enum: UserType, example: UserType.STUDENT })
  @IsEnum(UserType) userType: UserType;

  @ApiProperty({ type: () => StudentProfileDto, required: false })
  @IsOptional() @ValidateNested() @Type(() => StudentProfileDto)
  studentProfile?: StudentProfileDto;

  @ApiProperty({ type: () => ProfessionalProfileDto, required: false })
  @IsOptional() @ValidateNested() @Type(() => ProfessionalProfileDto)
  professionalProfile?: ProfessionalProfileDto;

  @ApiProperty({ example: '+234', required: false })
  @IsOptional() @IsString() countryCode?: string;

  @ApiProperty({ example: '8012345678', required: false })
  @IsOptional() @IsString() phoneNumber?: string;

  @ApiProperty({ example: 'ADA2026', required: false })
  @IsOptional() @IsString() referralCode?: string;
}