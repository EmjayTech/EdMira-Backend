import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import moment from 'moment';
import { Otp } from './schema/otp.schema';

@Injectable()
export class OtpService {
  constructor(
    @InjectModel(Otp.name) private readonly otpModel: Model<Otp>,
  ) { }

  private generateOtpCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  async createOtp(userId: Types.ObjectId, email: string): Promise<string> {
    const otpCode = this.generateOtpCode();
    const expiresAt = moment().add(10, 'minutes').toDate();

    await this.otpModel.deleteMany({ userId });

    await this.otpModel.create({
      userId,
      email,
      code: otpCode,
      expiresAt,
      attemptCount: 0,
      verified: false,
    });

    return otpCode;
  }

  async verifyOtp(userId: Types.ObjectId, code: string): Promise<boolean> {
    const otp = await this.otpModel.findOne({
      userId,
    });

    if (!otp) {
      throw new BadRequestException('OTP not found');
    }


    if (otp.attemptCount >= 3) {
      throw new BadRequestException('Account locked due to multiple failed OTP attempts');
    }

    if (moment().isAfter(otp.expiresAt)) {
      throw new BadRequestException('OTP has expired');
    }

    if (otp.code !== code) {
      otp.attemptCount += 1;
      await otp.save();
      const remaining = 3 - otp.attemptCount;
      throw new BadRequestException(
        `Invalid OTP. ${remaining > 0 ? `${remaining} attempt(s) left.` : 'Account locked.'}`,
      );
    }

    // Correct code
    otp.verified = true;
    otp.attemptCount = 0;
    await otp.save();

    return true;
  }

  async resendOtp(userId: Types.ObjectId, email: string): Promise<string> {
    // Remove all existing OTPs and reset
    await this.otpModel.deleteMany({ userId });

    // Create a new OTP with reset state
    const newCode = this.generateOtpCode();
    const expiresAt = moment().add(10, 'minutes').toDate();

    await this.otpModel.create({
      userId,
      email,
      code: newCode,
      expiresAt,
      attemptCount: 0,
      verified: false,
    });

    return newCode;
  }
}