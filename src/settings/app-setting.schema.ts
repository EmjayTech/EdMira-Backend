import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/** Admin-editable settings, one document per key (e.g. "points", "leaderboard"). */
@Schema({ collection: 'app_settings', timestamps: true })
export class AppSetting {
  @Prop({ required: true, unique: true }) key: string;
  @Prop({ type: Object, default: {} }) value: Record<string, unknown>;
  @Prop() updatedBy?: string;
}

export type AppSettingDocument = HydratedDocument<AppSetting>;
export const AppSettingSchema = SchemaFactory.createForClass(AppSetting);
