import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

@Schema({ _id: false })
export class GroupMember {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }) userId: mongoose.Types.ObjectId;
  @Prop({ type: String, enum: ['owner', 'member'], required: true }) role: 'owner' | 'member';
  @Prop({ required: true }) joinedAt: Date;
}
const GroupMemberSchema = SchemaFactory.createForClass(GroupMember);

/** Waiting for the invitee to accept (nobody joins without saying yes). */
@Schema({ _id: false })
export class GroupInvite {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }) userId: mongoose.Types.ObjectId;
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }) invitedBy: mongoose.Types.ObjectId;
  @Prop({ required: true }) createdAt: Date;
}
const GroupInviteSchema = SchemaFactory.createForClass(GroupInvite);

/** A study group (≤ 30 members). Everything is authorised in GroupsService. */
@Schema({ collection: 'study_groups', timestamps: true })
export class StudyGroup {
  @Prop({ required: true, trim: true }) name: string;
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Course' }) courseId?: mongoose.Types.ObjectId;
  @Prop() courseTitle?: string;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }) ownerId: mongoose.Types.ObjectId;

  /** Join code (the stand-in for a link until the web pages exist). */
  @Prop({ required: true, unique: true }) code: string;
  @Prop({ default: true }) codeEnabled: boolean;

  @Prop({ type: [GroupMemberSchema], default: [] }) members: GroupMember[];
  @Prop({ type: [GroupInviteSchema], default: [] }) invites: GroupInvite[];

  createdAt?: Date;
}

export type StudyGroupDocument = HydratedDocument<StudyGroup>;
export const StudyGroupSchema = SchemaFactory.createForClass(StudyGroup);
StudyGroupSchema.index({ 'members.userId': 1 });
StudyGroupSchema.index({ 'invites.userId': 1 });
