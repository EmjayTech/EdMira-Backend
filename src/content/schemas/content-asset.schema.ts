import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * A figure image for study notes (SVG / PNG / JPEG / WebP, small). The id is
 * the content hash, so a changed image gets a new URL (cache-busting) and the
 * same image is stored once. Served publicly at /content-assets/:id.
 */
@Schema({ collection: 'content_assets', timestamps: { createdAt: true, updatedAt: false } })
export class ContentAsset {
  /** sha256 of the bytes (first 32 hex chars). */
  @Prop({ required: true, unique: true }) hash: string;
  @Prop({ required: true }) mimeType: string;
  @Prop({ required: true }) size: number;
  @Prop({ type: Buffer, required: true }) data: Buffer;
  /** File name it came from, for admins. */
  @Prop() name?: string;
}

export type ContentAssetDocument = HydratedDocument<ContentAsset>;
export const ContentAssetSchema = SchemaFactory.createForClass(ContentAsset);
