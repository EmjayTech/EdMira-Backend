import { IsString, IsNotEmpty } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class StudentProfileDto {
  @ApiProperty({ example: 'University of Lagos' })
  @IsString()
  @IsNotEmpty()
  institution: string;

  @ApiProperty({ example: 'Medical Sciences' })
  @IsString()
  @IsNotEmpty()
  faculty: string;

  @ApiProperty({ example: 'Medicine and Surgery' })
  @IsString()
  @IsNotEmpty()
  department: string;

  @ApiProperty({ example: 'Undergraduate' })
  @IsString()
  @IsNotEmpty()
  levelType: string;

  @ApiProperty({ example: '500L' })
  @IsString()
  @IsNotEmpty()
  level: string;
}