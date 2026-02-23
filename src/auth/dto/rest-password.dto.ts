import { IsEmail, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ResetPasswordDto {
  @ApiProperty({ example: 'john@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'NewStrongPassword1!' })
  @IsString()
  @MinLength(6)
  newPassword: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  code: string;
}