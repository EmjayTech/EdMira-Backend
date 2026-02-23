import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Department } from 'src/common/enum/department.enum';
import { Institution } from 'src/common/enum/institution.enum';
import { Level, LevelType } from 'src/common/enum/level.enum';

@Schema({ _id: false })
export class StudentProfile {
  @Prop({
    type: String,
    enum: Object.values(Institution),
  })
  institution: Institution;

  @Prop()
  faculty: string;

  @Prop({
    type: String,
    enum: Object.values(Department),
  })
  department: Department;


  @Prop({
    type: String,
    enum: Object.values(LevelType),
  })
  levelType: LevelType;

  @Prop({
    type: String,
    enum: Object.values(Level),

  })
  level: Level;

  @Prop({ required: false })
  referralCode?: string;
}

export const StudentProfileSchema = SchemaFactory.createForClass(StudentProfile);

export type StudentProfileDocument = StudentProfile & Document;