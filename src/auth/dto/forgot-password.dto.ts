import { IsEmail, IsNotEmpty, IsString, ValidateIf } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Send a reset code to the account's email. Accepts the email or the
 * username (`identifier`); older apps send `email`.
 */
export class ForgotPasswordDto {
  @ApiProperty({ example: 'johndoe', required: false, description: 'Email address or username' })
  @ValidateIf(o => o.email === undefined)
  @IsString()
  @IsNotEmpty({ message: 'Enter your email or username.' })
  identifier?: string;

  @ApiProperty({ example: 'john@example.com', required: false })
  @ValidateIf(o => o.identifier === undefined)
  @IsEmail()
  email?: string;
}
