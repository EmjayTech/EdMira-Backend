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
import { normalizeUsername } from "../username-policy";


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

  /** Public identity and login name; rules in users/username-policy.ts. */
  @Prop()
  username: string;

  /**
   * `username` lower-cased: what uniqueness and login compare. Set on every
   * save (hook below). Older accounts get it from `yarn usernames backfill`;
   * the unique index is created by `yarn usernames index` once the audit is clean.
   */
  @Prop()
  usernameLower?: string;

  /** Last time the student changed their username (once every 30 days). */
  @Prop({ type: Date })
  usernameChangedAt?: Date;

  /**
   * Privacy settings (Profile → Privacy). Missing = defaults, so older
   * accounts need no migration. Phase 3 adds who-can-find-me etc. here.
   */
  @Prop({ type: Object, default: undefined })
  privacy?: PrivacySettings;

  /** Badges given or taken away by admins (see social/badges.ts). */
  @Prop({ type: Object, default: undefined })
  badgeOverrides?: { granted?: string[]; revoked?: string[] };

  /** Who invited this student (invite link / "Invited by" at sign-up). */
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true })
  referredBy?: mongoose.Types.ObjectId;

  @Prop({ type: Date })
  referredAt?: Date;

  // ── Moderation (admin → Moderation; see src/social) ──

  /** End of a timed suspension (status SUSPENDED); missing = until reactivated. */
  @Prop({ type: Date })
  suspendedUntil?: Date;

  /** Warnings given by moderators. */
  @Prop({ default: 0 })
  warnings?: number;

  /** Auto-flagged for review: can't send connection requests until then (or until an admin clears it). */
  @Prop({ type: Date })
  requestsPausedUntil?: Date;

  /** Why the account was auto-flagged, and when (cleared by an admin). */
  @Prop({ type: Object, default: undefined })
  flag?: { at: Date; reasons: string[] };

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

  /**
   * Staff invite (admin → Team): SHA-256 of the one-time setup token. The
   * account has no password until the invitee follows the link.
   */
  @Exclude()
  @Prop()
  inviteTokenHash?: string;

  @Exclude()
  @Prop({ type: Date })
  inviteExpiresAt?: Date;

  /** Who invited this staff member (shown on the Team page). */
  @Prop()
  invitedByName?: string;
}

export type UserDocument = User & mongoose.Document;
export const userModel = SchemaFactory.createForClass(User);

// Find classmates: prefix search on the lower-case username.
userModel.index({ usernameLower: 1, isVerified: 1 }, { name: 'username_search' });

// Keep `usernameLower` in step with `username` on create / save.
userModel.pre('validate', function (next) {
  if (this.isModified('username') && typeof this.username === 'string') {
    this.usernameLower = normalizeUsername(this.username);
  }
  next();
});
/**
 * Profile → Privacy. Missing settings mean the default shown, so older
 * accounts need no migration.
 */
export interface PrivacySettings {
  /** Leaderboards (default true). Off = "Anonymous student". */
  showOnLeaderboard?: boolean;
  /** Who can find me in search (default 'everyone'). */
  findability?: 'everyone' | 'exact' | 'nobody';
  /** Who can send me connection requests (default 'everyone'). */
  requestsFrom?: 'everyone' | 'school' | 'nobody';
  /** Connections see my streak and topics practised (default true). */
  shareProgress?: boolean;
  /** …and my exact scores (default false). */
  shareScores?: boolean;
  /** No inbox notifications for new requests (default false). */
  muteRequestNotifications?: boolean;
  /** Any signed-in student can see my profile: badges, streak, topics mastered (default false). */
  publicProfile?: boolean;
  /** …with my real name on it (default false). */
  showRealName?: boolean;
}
