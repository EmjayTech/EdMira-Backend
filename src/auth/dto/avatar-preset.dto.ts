import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';
import { AVATAR_PRESETS } from '../../avatars/avatar-view';

export class AvatarPresetDto {
  @ApiProperty({ example: 'a07', enum: AVATAR_PRESETS })
  @IsString()
  @IsIn(AVATAR_PRESETS)
  preset: string;
}
