import { Injectable, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User, UserDocument } from './model/user.model';


@Injectable()
export class UsersRepository {
  constructor(@InjectModel(User.name) private userModel: Model<UserDocument>) {}

  async create(userData: Partial<User>): Promise<UserDocument> {
    // Check for existing email
    const existingEmail = await this.userModel.findOne({
      email: userData.email,
    });
    if (existingEmail) {
      throw new ConflictException('Email already registered');
    }

    // Check for existing username
    const existingUsername = await this.userModel.findOne({
      username: userData.username,
    });
    if (existingUsername) {
      throw new ConflictException('Username already taken');
    }

    // Hash password
    const hashedPassword = userData.password ? await require('bcrypt').hash(userData.password, 10) : undefined;

    // Calculate initial profile completion
    const profileCompletion = this.calculateProfileCompletion ? this.calculateProfileCompletion(userData) : 100;

    const user = new this.userModel({
      ...userData,
      password: hashedPassword,
      profileCompletionPercentage: profileCompletion,
      isProfileComplete: profileCompletion === 100,
    });
    return user.save();
  }

  // Dummy profile completion calculator (replace with real logic if needed)
  calculateProfileCompletion(userData: Partial<User>): number {
    // Example: 100 if all required fields are present, else 0
    if (userData.firstName && userData.lastName && userData.email && userData.password ) {
      return 100;
    }
    return 0;
  }

  findByEmail(email: string) {
    return this.userModel.findOne({ email }).exec();
  }

  findById(id: string | Types.ObjectId) {
    return this.userModel.findById(id).exec();
  }

  async markEmailVerified(userId: string) {
    return this.userModel.findByIdAndUpdate(userId, { isEmailVerified: true }, { new: true }).exec();
  }

  async updatePassword(userId: string, hashedPassword: string) {
    return this.userModel.findByIdAndUpdate(userId, { password: hashedPassword }, { new: true }).exec();
  }

  // Apply referral: find user with matching referral code, increment their credit, and link
  async applyReferral(newUserId: string, referralCode: string) {
    const referrer = await this.userModel.findOne({ 'referral.code': referralCode }).exec();
    if (!referrer) return null;
    await this.userModel.findByIdAndUpdate(referrer._id, { $inc: { 'referral.creditPoints': 1 } }).exec();
    return this.userModel.findByIdAndUpdate(newUserId, { 'referral.referredBy': referrer._id }).exec();
  }
}