import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** POST /subscription/google/verify — sent by the app after a Play purchase (or restore). */
export class VerifyGooglePurchaseDto {
  @ApiProperty({ example: 'edmira_pro' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  productId: string;

  @ApiProperty({ description: 'purchaseToken from Google Play Billing' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  purchaseToken: string;
}
