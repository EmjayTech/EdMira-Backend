import { IsEmail, IsNotEmpty, IsString, MinLength, ValidateIf } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Same `identifier` / `email` choice as ForgotPasswordDto. */
export class ResetPasswordDto {
  @ApiProperty({ example: 'johndoe', required: false, description: 'Email address or username' })
  @ValidateIf(o => o.email === undefined)
  @IsString()
  @IsNotEmpty({ message: 'Enter your email or username.' })
  identifier?: string;

  @ApiProperty({ example: 'john@example.com', required: false })
  @ValidateIf(o => o.identifier === undefined)
  @IsEmail()
  email?: string;

  @ApiProperty({ example: 'NewStrongPassword1!' })
  @IsString()
  @MinLength(6)
  newPassword: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  code: string;
}
