import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import * as mongoose from 'mongoose';

@Schema({ _id: false })
export class Address {
  @Prop()
  street: string;

  @Prop()
  city: string;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'State' })
  stateId?: mongoose.Schema.Types.ObjectId;

  @Prop()
  zipCode?: string;

  @Prop()
  country?: string;
}

export const AddressSchema = SchemaFactory.createForClass(Address);