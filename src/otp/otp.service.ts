import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as crypto from 'crypto';
import { Otp } from './schema/otp.schema';

@Injectable()
export class OtpService {
  // 60-second cooldown between OTP requests per user
  private static readonly OTP_COOLDOWN_MS = 60_000;
  private static readonly OTP_EXPIRY_MINUTES = 10;
  private static readonly MAX_ATTEMPTS = 3;

  constructor(
    @InjectModel(Otp.name) private readonly otpModel: Model<Otp>,
  ) { }

  /**
   * Generate a cryptographically secure 6-digit OTP code.
   * Uses Node.js crypto.randomInt() instead of Math.random().
   */
  private generateOtpCode(): string {
    return crypto.randomInt(100000, 999999).toString();
  }

  /**
   * Hash OTP code with SHA-256 before storage.
   * Prevents exposure of active OTPs if the database is compromised.
   */
  private hashOtp(code: string): string {
    return crypto.createHash('sha256').update(code).digest('hex');
  }

  async createOtp(userId: Types.ObjectId, email: string): Promise<string> {
    // Enforce 60s cooldown to prevent OTP spam
    const lastOtp = await this.otpModel
      .findOne({ userId })
      .sort({ createdAt: -1 })
      .exec();

    if (lastOtp) {
      const elapsed = Date.now() - new Date(lastOtp['createdAt']).getTime();
      if (elapsed < OtpService.OTP_COOLDOWN_MS) {
        const remainingSeconds = Math.ceil((OtpService.OTP_COOLDOWN_MS - elapsed) / 1000);
        throw new BadRequestException(
          `Please wait ${remainingSeconds} seconds before requesting a new OTP.`,
        );
      }
    }

    const otpCode = this.generateOtpCode();
    const hashedCode = this.hashOtp(otpCode);
    const expiresAt = new Date(Date.now() + OtpService.OTP_EXPIRY_MINUTES * 60 * 1000);

    // Remove all previous OTPs for this user
    await this.otpModel.deleteMany({ userId });

    await this.otpModel.create({
      userId,
      email,
      code: hashedCode,
      expiresAt,
      attemptCount: 0,
      verified: false,
    });

    // Return the plaintext code to be sent via email
    return otpCode;
  }

  async verifyOtp(userId: Types.ObjectId, code: string): Promise<boolean> {
    const otp = await this.otpModel.findOne({ userId });

    if (!otp) {
      throw new BadRequestException('OTP not found');
    }

    if (otp.attemptCount >= OtpService.MAX_ATTEMPTS) {
      throw new BadRequestException('Account locked due to multiple failed OTP attempts');
    }

    if (new Date() > otp.expiresAt) {
      throw new BadRequestException('OTP has expired');
    }

    // Compare hashes instead of plaintext
    const hashedInput = this.hashOtp(code);
    if (otp.code !== hashedInput) {
      otp.attemptCount += 1;
      await otp.save();
      const remaining = OtpService.MAX_ATTEMPTS - otp.attemptCount;
      throw new BadRequestException(
        `Invalid OTP. ${remaining > 0 ? `${remaining} attempt(s) left.` : 'Account locked.'}`,
      );
    }

    // Correct code — mark as verified
    otp.verified = true;
    otp.attemptCount = 0;
    await otp.save();

    return true;
  }

  async resendOtp(userId: Types.ObjectId, email: string): Promise<string> {
    // createOtp already handles cooldown, cleanup, and hashing
    return this.createOtp(userId, email);
  }
}