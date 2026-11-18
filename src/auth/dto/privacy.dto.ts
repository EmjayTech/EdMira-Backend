import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Profile → Privacy. Omitted settings are unchanged; see social/social-policy.ts DEFAULT_PRIVACY. */
export class PrivacyDto {
  @ApiProperty({ required: false, description: "Show me on leaderboards (default on). Off = left out of other students' boards." })
  @IsOptional()
  @IsBoolean()
  showOnLeaderboard?: boolean;

  @ApiProperty({ required: false, enum: ['everyone', 'exact', 'nobody'], description: 'Who can find me (default everyone)' })
  @IsOptional()
  @IsIn(['everyone', 'exact', 'nobody'])
  findability?: 'everyone' | 'exact' | 'nobody';

  @ApiProperty({ required: false, enum: ['everyone', 'school', 'nobody'], description: 'Who can send me requests (default everyone)' })
  @IsOptional()
  @IsIn(['everyone', 'school', 'nobody'])
  requestsFrom?: 'everyone' | 'school' | 'nobody';

  @ApiProperty({ required: false, description: 'Connections see my streak and topics practised (default on)' })
  @IsOptional()
  @IsBoolean()
  shareProgress?: boolean;

  @ApiProperty({ required: false, description: '…and my exact scores (default off)' })
  @IsOptional()
  @IsBoolean()
  shareScores?: boolean;

  @ApiProperty({ required: false, description: 'No inbox notifications for new requests (default off)' })
  @IsOptional()
  @IsBoolean()
  muteRequestNotifications?: boolean;

  @ApiProperty({ required: false, description: 'No inbox messages about leaderboards (default off)' })
  @IsOptional()
  @IsBoolean()
  muteLeaderboardNotifications?: boolean;

  @ApiProperty({ required: false, description: 'Make my profile public to other students (default off)' })
  @IsOptional()
  @IsBoolean()
  publicProfile?: boolean;

  @ApiProperty({ required: false, description: 'Show my real name on my public profile (default off)' })
  @IsOptional()
  @IsBoolean()
  showRealName?: boolean;
}
