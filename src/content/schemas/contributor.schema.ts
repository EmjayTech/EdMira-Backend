import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Someone who gave EdMira their OWN notes (a lecturer, a contributor), with
 * the record that they granted permission. A topic file can only use a
 * contributor whose permission is on record; they're credited if they want.
 */
@Schema({ collection: 'content_contributors', timestamps: true })
export class Contributor {
  /** Used in topic files ("contributors: dr-okafor"). */
  @Prop({ required: true, unique: true }) key: string;
  @Prop({ required: true }) name: string;
  /** e.g. "Lecturer, Physiology, UNIBEN" */
  @Prop({ default: '' }) role: string;
  @Prop() email?: string;
  /** The contributor agreement. */
  @Prop({ required: true }) permissionGranted: boolean;
  @Prop() permissionDate?: Date;
  /** What they agreed to (wording or a reference to the signed form). */
  @Prop({ default: '' }) permissionText: string;
  /** Show "Notes contributed by …" on their topics. */
  @Prop({ default: false }) credit: boolean;
  /** How to credit them, e.g. "Dr A. Okafor (UNIBEN)". */
  @Prop() creditName?: string;
  @Prop({ type: [String], default: [] }) topics: string[];
  @Prop() addedBy?: string;
}

export type ContributorDocument = HydratedDocument<Contributor>;
export const ContributorSchema = SchemaFactory.createForClass(Contributor);
