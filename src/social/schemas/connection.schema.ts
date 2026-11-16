import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';
import { CONNECTION_STATUSES, ConnectionStatus, REQUEST_NOTES, RequestNote } from '../social-policy';

/**
 * A connection request and, once accepted, the connection itself.
 * Rows are kept after they end (declined, removed…) — they drive the 30-day
 * re-request cooldown, the decline-rate flag and moderation evidence.
 */
@Schema({ collection: 'connections', timestamps: true })
export class Connection {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true })
  requesterId: mongoose.Types.ObjectId;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true })
  recipientId: mongoose.Types.ObjectId;

  /** Same for both directions (social-policy pairKey). */
  @Prop({ required: true, index: true })
  pairKey: string;

  /** = pairKey while pending or accepted: a unique sparse index keeps one live row per pair. */
  @Prop()
  livePair?: string;

  @Prop({ type: String, enum: CONNECTION_STATUSES, required: true })
  status: ConnectionStatus;

  @Prop({ type: String, enum: REQUEST_NOTES })
  note?: RequestNote;

  /**
   * A request the recipient never sees (they declined this sender recently,
   * or don't take requests from them). The sender sees it as pending until
   * it expires — so they can't tell.
   */
  @Prop({ default: false })
  shadow: boolean;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop() respondedAt?: Date;
  @Prop() endedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export type ConnectionDocument = HydratedDocument<Connection>;
export const ConnectionSchema = SchemaFactory.createForClass(Connection);
ConnectionSchema.index({ livePair: 1 }, { unique: true, sparse: true });
ConnectionSchema.index({ recipientId: 1, status: 1, shadow: 1, createdAt: -1 });
ConnectionSchema.index({ requesterId: 1, status: 1, createdAt: -1 });
