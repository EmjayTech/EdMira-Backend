import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ProfessionalTitle } from 'src/common/enum/title.enum';

@Schema()
export class ProfessionalProfile {
  @Prop({
    type: String,
    enum: Object.values(ProfessionalTitle),
  })
  title: ProfessionalTitle;

  @Prop()
  fieldOfSpecialization: string;

  @Prop()
  yearsOfExperience?: number;

  @Prop()
  bio?: string;

  @Prop()
  referralCode?: string;

  @Prop({ default: 0 })
  referralCredits: number;

}

export const ProfessionalProfileSchema = SchemaFactory.createForClass(ProfessionalProfile);