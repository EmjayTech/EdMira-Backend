import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Rules are checked by UsernameService so the error says which one failed. */
export class ChangeUsernameDto {
  @ApiProperty({ example: 'ada_obi' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  username: string;
}
