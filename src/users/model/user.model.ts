import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Exclude } from 'class-transformer';
import mongoose, { QueryWithHelpers } from "mongoose";
import { GenderType } from "src/common/enum/gender.enum";
import { PhoneNumber, PhoneNumberSchema } from "../schema/phoneNumber.schema";
import { Address, AddressSchema } from "../schema/address.schema";
import { UserType } from "src/common/enum/user-type.enum";
import { StudentProfile, StudentProfileSchema } from "../schema/studentProfile.schema";
import { ProfessionalProfile, ProfessionalProfileSchema } from "../schema/professionalProfile.schema";
import { AccountStatus, StaffRole } from "src/common/enum/staff-role.enum";


@Schema({ timestamps: true })
export class User {
  _id?: mongoose.Schema.Types.ObjectId;

  @Prop({ unique: true, required: true })
  email: string;

  @Exclude()
  @Prop()
  password: string;

  @Prop()
  firstName: string;

  @Prop()
  lastName: string;

  @Prop({ computed: true })
  get fullName(): string {
    return `${this.firstName} ${this.lastName}`;
  }

  @Prop()
  username: string;

  @Prop({ type: String, enum: Object.values(GenderType) })
  gender: GenderType;

  @Prop({ type: PhoneNumberSchema })
  phone: PhoneNumber;

  @Prop({ type: AddressSchema })
  address: Address;

  @Prop()
  lastLogin: Date;

  /**
   * Admin-dashboard role (StaffRole); unset for students. Not enum-validated
   * so older accounts with legacy values still save — StaffGuard only
   * accepts StaffRole values.
   */
  @Prop({ type: String })
  role?: StaffRole;

  /** Suspended accounts can't log in or refresh (admin → Students). */
  @Prop({ type: String, enum: Object.values(AccountStatus), default: AccountStatus.ACTIVE })
  status: AccountStatus;

  createdAt?: Date;
  updatedAt?: Date;
  @Prop({ type: String, enum: Object.values(UserType) })
  userType: UserType;

  @Prop({ type: StudentProfileSchema })
  studentProfile?: StudentProfile;

  @Prop({ type: ProfessionalProfileSchema })
  professionalProfile?: ProfessionalProfile;



  @Prop({ default: false })
  isVerified: boolean;


  @Exclude()
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User' })
  createdBy: mongoose.Schema.Types.ObjectId;

  @Exclude()
  @Prop({ type: Date })
  deletedAt: Date;

  @Exclude()
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'State' })
  stateId: mongoose.Schema.Types.ObjectId;

  @Exclude()
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User' })
  lastModifiedBy: mongoose.Schema.Types.ObjectId;

  @Exclude()
  @Prop()
  refreshToken?: string;
}

export type UserDocument = User & mongoose.Document;
export const userModel = SchemaFactory.createForClass(User);