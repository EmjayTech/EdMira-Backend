import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User, UserDocument } from './model/user.model';
import { normalizeUsername } from './username-policy';

/** Case-insensitive comparison, only for accounts not yet backfilled with `usernameLower`. */
const CASE_INSENSITIVE = { locale: 'en', strength: 2 } as const;


@Injectable()
export class UsersRepository {
  constructor(@InjectModel(User.name) private userModel: Model<UserDocument>) { }

  async create(userData: Partial<User>): Promise<UserDocument> {
    const user = new this.userModel(userData);
    return user.save();
  }

  findByEmail(email: string) {
    return this.userModel.findOne({ email }).exec();
  }

  /**
   * Accounts with this username, ignoring case. Usernames weren't unique
   * before Nov 2026, so older ones may match more than one account.
   */
  async findByUsername(username: string, limit = 5): Promise<UserDocument[]> {
    const lower = normalizeUsername(username);
    if (!lower) return [];
    const found = await this.userModel.find({ usernameLower: lower }).limit(limit).exec();
    if (found.length) return found;
    // Accounts not yet backfilled (`yarn usernames backfill`) have no
    // usernameLower. Once the backfill has run in production this finds nothing.
    return this.userModel
      .find({ usernameLower: { $exists: false }, username: username.trim() })
      .collation(CASE_INSENSITIVE)
      .limit(limit)
      .exec();
  }

  /** Is this username (any case) used by an account other than `exceptUserId`? */
  async usernameInUse(username: string, exceptUserId?: string | Types.ObjectId): Promise<boolean> {
    const lower = normalizeUsername(username);
    const notSelf = exceptUserId ? { _id: { $ne: exceptUserId } } : {};
    if (await this.userModel.exists({ usernameLower: lower, ...notSelf })) return true;
    return !!(await this.userModel
      .exists({ usernameLower: { $exists: false }, username: username.trim(), ...notSelf })
      .collation(CASE_INSENSITIVE));
  }

  /** `changedAt` starts the 30-day wait; leave it out when staff change the name. */
  async setUsername(userId: string | Types.ObjectId, username: string, changedAt?: Date) {
    const set: Record<string, unknown> = { username, usernameLower: normalizeUsername(username) };
    if (changedAt) set.usernameChangedAt = changedAt;
    return this.userModel.findByIdAndUpdate(userId, { $set: set }, { new: true }).exec();
  }

  findById(id: string | Types.ObjectId) {
    return this.userModel.findById(id).exec();
  }

  /** Shown as "Last active" on the dashboard's Team page. */
  async touchLastLogin(id: string | Types.ObjectId) {
    await this.userModel.updateOne({ _id: id }, { lastLogin: new Date() }).exec();
  }

  async markVerified(userId: string | Types.ObjectId) {
    return this.userModel
      .findByIdAndUpdate(userId, { isVerified: true }, { new: true })
      .exec();
  }

  async updatePassword(userId: string | Types.ObjectId, hashedPassword: string) {
    return this.userModel
      .findByIdAndUpdate(userId, { password: hashedPassword }, { new: true })
      .exec();
  }

  async updateRefreshToken(userId: string | Types.ObjectId, hashedRefreshToken: string) {
    return this.userModel
      .updateOne({ _id: userId }, { refreshToken: hashedRefreshToken })
      .exec();
  }

  /** `$set` specific (possibly nested, dotted) fields; returns the updated user. */
  async updateFields(userId: string | Types.ObjectId, fields: Record<string, unknown>) {
    return this.userModel
      .findByIdAndUpdate(userId, { $set: fields }, { new: true, runValidators: true })
      .exec();
  }

  async clearRefreshToken(userId: string | Types.ObjectId) {
    return this.userModel
      .updateOne({ _id: userId }, { refreshToken: null })
      .exec();
  }
}