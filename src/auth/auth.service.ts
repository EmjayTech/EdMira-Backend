// src/auth/auth.service.ts
import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { JWT_ACCESS_EXPIRATION, JWT_REFRESH_EXPIRATION, SALT_ROUNDS } from '../common/config/constants';
import { SignupDto } from './dto/signup.dto';
import { EmailService } from '../mailer/mailer.service';
import { UserType } from '../common/enum/user-type.enum';
import { OtpService } from '../otp/otp.service';
import { LoginDto } from './dto/login.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/rest-password.dto';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UsersRepository } from '../users/user.repository';

/** TTL for blacklisted access tokens in seconds (15 minutes = AT lifetime) */
const AT_BLACKLIST_TTL = 15 * 60;

@Injectable()
export class AuthService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly emailService: EmailService,
    private readonly otpService: OtpService,
    private jwtService: JwtService,
    private configService: ConfigService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) { }

  // ──────────────────────────────────── Signup ────────────────────────────────────

  async signup(signupDto: SignupDto): Promise<{ message: string; user: any }> {
    this.validateProfiles(signupDto);

    const existingUser = await this.usersRepository.findByEmail(signupDto.email);
    if (existingUser) {
      throw new ConflictException('Email already in use');
    }

    const { password, userType, studentProfile, professionalProfile, ...rest } = signupDto;
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const savedUser = await this.usersRepository.create({
      ...rest,
      password: hashedPassword,
      userType,
      studentProfile: (userType === UserType.STUDENT || userType === UserType.HYBRID)
        ? studentProfile as any
        : undefined,
      professionalProfile: (userType === UserType.PROFESSIONAL || userType === UserType.HYBRID)
        ? professionalProfile as any
        : undefined,
    });

    try {
      const otpCode = await this.otpService.createOtp(savedUser._id as Types.ObjectId, savedUser.email);
      await this.emailService.sendWelcomeAndVerificationEmail(savedUser.email, savedUser.firstName, userType, otpCode);
    } catch (error) {
      console.error('Failed to send welcome email:', error);
    }

    const { password: _password, refreshToken: _rt, ...safeUser } = savedUser.toObject();

    return {
      message: 'Signup successful. Please check your email for the verification code.',
      user: safeUser,
    };
  }

  private validateProfiles(dto: SignupDto) {
    if (dto.userType === UserType.STUDENT && !dto.studentProfile) {
      throw new BadRequestException('Student profile is required for Student users');
    }
    if (dto.userType === UserType.PROFESSIONAL && !dto.professionalProfile) {
      throw new BadRequestException('Professional profile is required for Professional users');
    }
    if (dto.userType === UserType.HYBRID) {
      if (!dto.studentProfile || !dto.professionalProfile) {
        throw new BadRequestException('Both Student and Professional profiles are required for Hybrid users');
      }
    }
  }

  // ──────────────────────────────────── OTP Verify ────────────────────────────────

  async verifyOtp(dto: VerifyOtpDto): Promise<{ message: string }> {
    const user = await this.usersRepository.findByEmail(dto.email);
    if (!user) {
      throw new BadRequestException('User not found');
    }

    if (user.isVerified) {
      return { message: 'User is already verified' };
    }

    try {
      await this.otpService.verifyOtp(user._id as Types.ObjectId, dto.code);
      await this.usersRepository.markVerified(user._id as any);
      return { message: 'OTP verified successfully. Account activated.' };
    } catch (error) {
      console.error(`OTP Verification failed for ${dto.email}:`, error.message);
      throw error;
    }
  }

  // ──────────────────────────────── Resend OTP (anti-enumeration) ─────────────────

  async resendOtp(dto: ResendOtpDto) {
    const user = await this.usersRepository.findByEmail(dto.email);
    // Return generic message even if user not found — prevents email enumeration
    if (!user) {
      return { message: 'If an account with this email exists, a new verification code has been sent.' };
    }

    const otp = await this.otpService.createOtp(user._id as Types.ObjectId, user.email);
    await this.emailService.sendResendOtpEmail(user.email, user.firstName, otp);

    return { message: 'If an account with this email exists, a new verification code has been sent.' };
  }

  // ──────────────────────────────────── Login ─────────────────────────────────────

  async login(dto: LoginDto): Promise<{ accessToken: string; refreshToken: string }> {
    const user = await this.usersRepository.findByEmail(dto.email);
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');
    if (!user.isVerified) throw new UnauthorizedException('Please verify your email first');

    const tokens = await this.getTokens(user._id as Types.ObjectId, user.email, user.userType);
    await this.updateRtHash(user._id as Types.ObjectId, tokens.refreshToken);
    return tokens;
  }

  // ────────────────────────────── Logout (with AT blacklist) ──────────────────────

  async logout(userId: string, accessToken?: string) {
    await this.usersRepository.clearRefreshToken(userId);

    // Blacklist the access token in Redis so it cannot be reused until it expires
    if (accessToken) {
      await this.cacheManager.set(
        `bl_${accessToken}`,
        '1',
        AT_BLACKLIST_TTL * 1000, // cache-manager expects ms
      );
    }
  }

  // ──────────────────────────────── Refresh Tokens ────────────────────────────────

  async refreshTokens(userId: string, rt: string) {
    const user = await this.usersRepository.findById(userId);
    if (!user || !user.refreshToken) throw new UnauthorizedException('Access Denied');

    const rtMatches = await bcrypt.compare(rt, user.refreshToken);
    if (!rtMatches) throw new UnauthorizedException('Access Denied');

    const tokens = await this.getTokens(user._id as Types.ObjectId, user.email, user.userType);
    await this.updateRtHash(user._id as Types.ObjectId, tokens.refreshToken);
    return tokens;
  }

  async updateRtHash(userId: Types.ObjectId, rt: string) {
    const hash = await bcrypt.hash(rt, SALT_ROUNDS);
    await this.usersRepository.updateRefreshToken(userId, hash);
  }

  async getTokens(userId: any, email: string, userType: string) {
    const [at, rt] = await Promise.all([
      this.jwtService.signAsync(
        { sub: userId, email, userType },
        {
          secret: this.configService.get<string>('JWT_SECRET'),
          expiresIn: JWT_ACCESS_EXPIRATION,
        },
      ),
      this.jwtService.signAsync(
        { sub: userId, email, userType },
        {
          secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
          expiresIn: JWT_REFRESH_EXPIRATION,
        },
      ),
    ]);

    return { accessToken: at, refreshToken: rt };
  }

  // ────────────────────────── Forgot Password (anti-enumeration) ─────────────────

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.usersRepository.findByEmail(dto.email);
    // Return generic success even if user not found — prevents email enumeration
    if (!user) {
      return { message: 'If an account with this email exists, a password reset code has been sent.' };
    }

    const otp = await this.otpService.createOtp(user._id as Types.ObjectId, user.email);
    await this.emailService.sendPasswordReset(user.email, otp);
    return { message: 'If an account with this email exists, a password reset code has been sent.' };
  }

  // ──────────────────────────────── Reset Password ────────────────────────────────

  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.usersRepository.findByEmail(dto.email);
    if (!user) throw new BadRequestException('Email not found');

    await this.otpService.verifyOtp(user._id as Types.ObjectId, dto.code);
    const hashedPassword = await bcrypt.hash(dto.newPassword, SALT_ROUNDS);
    await this.usersRepository.updatePassword(user._id as any, hashedPassword);

    return { message: 'Password reset successful' };
  }

  // ──────────────────────────────── Social Login ─────────────────────────────────

  async validateSocialLogin(profile: any): Promise<any> {
    const { email, firstName, lastName, socialId, provider } = profile;

    let user: any = await this.usersRepository.findByEmail(email);

    if (user) {
      // Account linking: attach social ID if not already linked
      if (!user.socialId) {
        await this.usersRepository.updateSocialId(user._id as any, socialId, provider);
      }
      return user;
    }

    // Create new social user
    // Note: Generate a strong random password for the schema even though social users don't use it
    const randomPassword = crypto.randomBytes(32).toString('hex');
    const hashedPassword = await bcrypt.hash(randomPassword, SALT_ROUNDS);

    // TODO: Allow social users to choose their profile type (Student/Professional/Hybrid) after first login.
    // Currently defaults to STUDENT for auto-created social accounts.
    user = await this.usersRepository.create({
      email,
      firstName,
      lastName,
      username: email.split('@')[0],
      password: hashedPassword,
      socialId,
      provider,
      userType: UserType.STUDENT,
      isVerified: true,
    });

    return user;
  }
}