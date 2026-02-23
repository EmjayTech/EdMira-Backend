import { IsString, IsNotEmpty, IsEnum } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { ProfessionalTitle } from "src/common/enum/title.enum";

export class ProfessionalProfileDto {
  @ApiProperty({ enum: ProfessionalTitle, example: ProfessionalTitle.DR })
  @IsEnum(ProfessionalTitle)
  @IsNotEmpty()
  title: ProfessionalTitle;

  @ApiProperty({ example: 'Cardiology' })
  @IsString()
  @IsNotEmpty()
  fieldOfSpecialization: string;

  @ApiProperty({ example: 'Teaching Hospital' })
  @IsString()
  @IsNotEmpty()
  organization: string;

  @ApiProperty({ example: '5' })
  @IsString()
  @IsNotEmpty()
  yearsOfExperience: string;
}