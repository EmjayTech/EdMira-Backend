import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ _id: false })
export class SchoolCourseCode {
  /** null when the source names the course but not its code (never guessed). */
  @Prop({ type: String, default: null }) code: string | null;
  @Prop({ type: String, default: null }) title: string | null;
  /** Module IDs it covers, e.g. ["PHY-05", "PHY-06"]. */
  @Prop({ type: [String], default: [] }) modules: string[];
}

@Schema({ _id: false })
export class SchoolCodes {
  /** e.g. "uniben" */
  @Prop({ required: true }) key: string;
  @Prop({ required: true }) school: string;
  /** The profile's institution value this entry is for (e.g. "University of Benin"); chips and code search use it. */
  @Prop({ type: String, default: null }) institution?: string | null;
  /** Confirmed from a curriculum document (vs added by an ambassador, pending a check). */
  @Prop({ default: false }) verified: boolean;
  @Prop({ type: String, default: null }) source: string | null;
  @Prop({ type: [SchoolCourseCode], default: [] }) courses: SchoolCourseCode[];
  @Prop() updatedBy?: string;
  @Prop() updatedAt?: Date;
}

/**
 * A subject's curriculum (from content-import/curriculum/<subject>_outline.json):
 * the module/topic tree content is tagged with, and each school's own course
 * codes mapped onto modules — editable by admins (Curriculum page), so
 * ambassadors' school outlines can be added without code changes. Imports
 * refresh the modules but never overwrite a school an admin has edited.
 */
@Schema({ collection: 'curricula', timestamps: true })
export class Curriculum {
  @Prop({ required: true, unique: true }) subject: string;
  @Prop({ required: true }) version: string;
  @Prop({ type: [Object], default: [] }) modules: { id: string; title: string; typicalLevel?: string; edmiraCourse: string; topics: { id: string; title: string }[] }[];
  @Prop({ type: [SchoolCodes], default: [] }) schools: SchoolCodes[];
}

export type CurriculumDocument = HydratedDocument<Curriculum>;
export const CurriculumSchema = SchemaFactory.createForClass(Curriculum);
