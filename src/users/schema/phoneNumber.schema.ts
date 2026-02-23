import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";

@Schema({ _id: false })
export class PhoneNumber {
  @Prop()
  countryCode: string;

  @Prop()
  number: string;

  @Prop()
  extension?: string;
}

export const PhoneNumberSchema = SchemaFactory.createForClass(PhoneNumber);