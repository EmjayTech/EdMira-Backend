import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { ContentStatus } from '../../common/enum/content-status.enum';
import { AudienceRule, AudienceRuleSchema } from '../audience';

@Schema({ timestamps: true })
export class Course {
  @Prop({ required: true, trim: true })
  title: string;

  @Prop({ default: '' })
  description: string;

  /** Short badge code, e.g. "ANA". */
  @Prop()
  code?: string;

  /** Hex brand colour for the course card. */
  @Prop()
  color?: string;

  /** Who the course is for (see audience.ts). Empty = everyone. */
  @Prop({ type: [AudienceRuleSchema], default: [] })
  audience: AudienceRule[];

  @Prop({ type: String, enum: Object.values(ContentStatus), default: ContentStatus.DRAFT, index: true })
  status: ContentStatus;

  createdAt?: Date;
  updatedAt?: Date;
}

export type CourseDocument = HydratedDocument<Course>;
export const CourseSchema = SchemaFactory.createForClass(Course);
