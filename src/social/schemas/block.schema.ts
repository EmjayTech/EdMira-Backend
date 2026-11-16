import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

/** `blockerId` blocked `blockedId`: they're hidden from each other everywhere. */
@Schema({ collection: 'blocks', timestamps: { createdAt: true, updatedAt: false } })
export class Block {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true })
  blockerId: mongoose.Types.ObjectId;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true })
  blockedId: mongoose.Types.ObjectId;

  createdAt?: Date;
}

export type BlockDocument = HydratedDocument<Block>;
export const BlockSchema = SchemaFactory.createForClass(Block);
BlockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
