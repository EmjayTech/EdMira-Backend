import { IsEmail, IsNotEmpty, IsString, ValidateIf } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Log in with an email address OR a username.
 *
 * - `identifier`: an email or a username (the mobile app sends this for usernames).
 * - `email`: what older app versions, EdMira-Web and the admin portal send.
 *
 * Send one of them; if both are sent, `identifier` wins.
 */
export class LoginDto {
  @ApiProperty({ example: 'johndoe', required: false, description: 'Email address or username' })
  @ValidateIf(o => o.email === undefined)
  @IsString()
  @IsNotEmpty({ message: 'Enter your email or username.' })
  identifier?: string;

  @ApiProperty({ example: 'john@example.com', required: false })
  @ValidateIf(o => o.identifier === undefined)
  @IsEmail()
  email?: string;

  @ApiProperty({ example: 'StrongPass1!' })
  @IsString()
  password: string;
}
