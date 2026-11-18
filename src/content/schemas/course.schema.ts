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

  // ── Topic-based subjects (Physiology): a module of a subject, not a school course ──
  /** e.g. "Physiology". Set for modules; courses keep it empty. */
  @Prop({ index: true, sparse: true }) subject?: string;
  /** e.g. "PHY-05" (content-import/curriculum/<subject>_outline.json). */
  @Prop({ unique: true, sparse: true }) moduleId?: string;
  /** Card label instead of a code, e.g. "Cardiovascular". */
  @Prop() shortName?: string;
  /** Icon key for the module card (heart, lungs, kidney …). */
  @Prop() icon?: string;
  /** Typical levels from the outline (a recommendation, never a restriction). */
  @Prop({ type: [String], default: undefined }) typicalLevels?: string[];
  /** A school course replaced by modules (archived by a migration): where its topics went. */
  @Prop({ type: [String], default: undefined }) replacedBy?: string[];

  createdAt?: Date;
  updatedAt?: Date;
}

export type CourseDocument = HydratedDocument<Course>;
export const CourseSchema = SchemaFactory.createForClass(Course);
