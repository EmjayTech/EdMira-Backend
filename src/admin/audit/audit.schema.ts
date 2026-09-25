import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

export const AUDIT_ENTITIES = ['course', 'topic', 'question', 'report', 'feedback', 'student'] as const;
export type AuditEntity = (typeof AUDIT_ENTITIES)[number];

/** One staff action, shown in the dashboard's Activity log. Append-only. */
@Schema({ timestamps: { createdAt: 'at', updatedAt: false } })
export class AuditEntry {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true })
  actorId: mongoose.Types.ObjectId;

  @Prop({ required: true })
  actorName: string;

  @Prop({ type: String, enum: AUDIT_ENTITIES, required: true })
  entity: AuditEntity;

  @Prop({ required: true })
  entityId: string;

  @Prop({ required: true })
  action: string;

  @Prop({ required: true })
  summary: string;

  at?: Date;
}

export type AuditEntryDocument = HydratedDocument<AuditEntry>;
export const AuditEntrySchema = SchemaFactory.createForClass(AuditEntry);
AuditEntrySchema.index({ at: -1 });
