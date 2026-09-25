// src/auth/auth.service.ts
import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  Inject,
  ForbiddenException,
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
import { UpdateProfileDto } from './dto/update-profile.dto';
import { AccountStatus } from '../common/enum/staff-role.enum';

/** TTL for blacklisted access tokens in seconds (15 minutes = AT lifetime) */
const AT_BLACKLIST_TTL = 15 * 60;

/** Pending-signup OTP/cache settings */
const PENDING_SIGNUP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 3;
const pendingKey = (email: string) => `pending_signup:${email.toLowerCase()}`;

type PendingSignup = {
  payload: SignupDto & { password: string };
  otpHash: string;
  expiresAt: number;
  attemptCount: number;
  lastOtpIssuedAt: number;
};

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

  async signup(signupDto: SignupDto): Promise<{ message: string }> {
    this.validateProfiles(signupDto);

    const existingUser = await this.usersRepository.findByEmail(signupDto.email);
    if (existingUser) {
      throw new ConflictException('Email already in use');
    }

    const existingPending = await this.cacheManager.get<PendingSignup>(pendingKey(signupDto.email));
    if (existingPending) {
      const elapsed = Date.now() - existingPending.lastOtpIssuedAt;
      if (elapsed < OTP_RESEND_COOLDOWN_MS) {
        const remaining = Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000);
        throw new BadRequestException(
          `A verification code was recently sent. Please wait ${remaining} seconds before requesting a new one.`,
        );
      }
    }

    const hashedPassword = await bcrypt.hash(signupDto.password, SALT_ROUNDS);
    const otpCode = this.generateOtpCode();
    const now = Date.now();

    const pending: PendingSignup = {
      payload: { ...signupDto, password: hashedPassword },
      otpHash: this.hashOtp(otpCode),
      expiresAt: now + PENDING_SIGNUP_TTL_MS,
      attemptCount: 0,
      lastOtpIssuedAt: now,
    };

    await this.cacheManager.set(pendingKey(signupDto.email), pending, PENDING_SIGNUP_TTL_MS);

    try {
      await this.emailService.sendWelcomeAndVerificationEmail(
        signupDto.email,
        signupDto.firstName,
        signupDto.userType,
        otpCode,
      );
    } catch (error) {
      console.error('Failed to send verification email:', error);
    }

    return {
      message: 'Signup initiated. Please check your email for the verification code. Your account will be created after verification.',
    };
  }

  private generateOtpCode(): string {
    return crypto.randomInt(100000, 999999).toString();
  }

  private hashOtp(code: string): string {
    return crypto.createHash('sha256').update(code).digest('hex');
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

  async verifyOtp(dto: VerifyOtpDto): Promise<{ message: string; user: any; accessToken: string; refreshToken: string }> {
    const key = pendingKey(dto.email);
    const pending = await this.cacheManager.get<PendingSignup>(key);

    if (!pending) {
      throw new BadRequestException('No pending signup for this email or it has expired. Please sign up again.');
    }

    if (Date.now() > pending.expiresAt) {
      await this.cacheManager.del(key);
      throw new BadRequestException('Verification code has expired. Please sign up again.');
    }

    if (pending.attemptCount >= MAX_OTP_ATTEMPTS) {
      await this.cacheManager.del(key);
      throw new BadRequestException('Too many failed attempts. Please sign up again.');
    }

    if (pending.otpHash !== this.hashOtp(dto.code)) {
      pending.attemptCount += 1;
      const remainingTtl = Math.max(pending.expiresAt - Date.now(), 1000);
      await this.cacheManager.set(key, pending, remainingTtl);
      const remaining = MAX_OTP_ATTEMPTS - pending.attemptCount;
      throw new BadRequestException(
        `Invalid OTP. ${remaining > 0 ? `${remaining} attempt(s) left.` : 'Account locked.'}`,
      );
    }

    // Double-check email wasn't taken while pending (race condition guard)
    const collision = await this.usersRepository.findByEmail(dto.email);
    if (collision) {
      await this.cacheManager.del(key);
      throw new ConflictException('Email already in use');
    }

    const {
      password,
      userType,
      studentProfile,
      professionalProfile,
      countryCode,
      phoneNumber,
      referralCode,
      ...rest
    } = pending.payload;

    const savedUser = await this.usersRepository.create({
      ...rest,
      password,
      userType,
      phone: phoneNumber ? { countryCode, number: phoneNumber } : undefined,
      studentProfile: (userType === UserType.STUDENT || userType === UserType.HYBRID)
        ? { ...studentProfile, referralCode } as any
        : undefined,
      professionalProfile: (userType === UserType.PROFESSIONAL || userType === UserType.HYBRID)
        ? professionalProfile as any
        : undefined,
      isVerified: true,
    });

    await this.cacheManager.del(key);

    const tokens = await this.getTokens(savedUser._id as Types.ObjectId, savedUser.email, savedUser.userType);
    await this.updateRtHash(savedUser._id as Types.ObjectId, tokens.refreshToken);

    return {
      message: 'Email verified successfully. Account created.',
      user: this.toSafeProfile(savedUser),
      ...tokens,
    };
  }

  // ──────────────────────────────── Resend OTP (pending signups) ──────────────────

  async resendOtp(dto: ResendOtpDto) {
    const key = pendingKey(dto.email);
    const pending = await this.cacheManager.get<PendingSignup>(key);

    // Generic response when nothing pending — avoids leaking existence
    if (!pending) {
      return { message: 'If a pending signup with this email exists, a new verification code has been sent.' };
    }

    const elapsed = Date.now() - pending.lastOtpIssuedAt;
    if (elapsed < OTP_RESEND_COOLDOWN_MS) {
      const remaining = Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000);
      throw new BadRequestException(`Please wait ${remaining} seconds before requesting a new OTP.`);
    }

    const otpCode = this.generateOtpCode();
    pending.otpHash = this.hashOtp(otpCode);
    pending.lastOtpIssuedAt = Date.now();
    pending.attemptCount = 0;
    pending.expiresAt = Date.now() + PENDING_SIGNUP_TTL_MS;

    await this.cacheManager.set(key, pending, PENDING_SIGNUP_TTL_MS);
    await this.emailService.sendResendOtpEmail(pending.payload.email, pending.payload.firstName, otpCode);

    return { message: 'If a pending signup with this email exists, a new verification code has been sent.' };
  }

  // ──────────────────────────────────── Login ─────────────────────────────────────

  async login(dto: LoginDto): Promise<{ accessToken: string; refreshToken: string }> {
    const user = await this.usersRepository.findByEmail(dto.email);
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');
    if (!user.isVerified) throw new UnauthorizedException('Please verify your email first');
    this.assertActive(user);

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

    if (!this.refreshTokenMatches(rt, user.refreshToken)) {
      throw new UnauthorizedException('Access Denied');
    }
    this.assertActive(user);

    const tokens = await this.getTokens(user._id as Types.ObjectId, user.email, user.userType);
    await this.updateRtHash(user._id as Types.ObjectId, tokens.refreshToken);
    return tokens;
  }

  private assertActive(user: { status?: string }) {
    if (user.status === AccountStatus.SUSPENDED) {
      throw new ForbiddenException('This account has been suspended. Contact EdMira support.');
    }
  }

  /**
   * Refresh tokens are long random JWTs, so a SHA-256 digest is the right
   * hash. (bcrypt only reads the first 72 bytes, which every refresh token
   * for the same user shares — an old, rotated token would still match.)
   */
  private hashRefreshToken(rt: string) {
    return crypto.createHash('sha256').update(rt).digest('hex');
  }

  private refreshTokenMatches(rt: string, storedHash: string) {
    const actual = Buffer.from(this.hashRefreshToken(rt), 'hex');
    const expected = Buffer.from(storedHash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  async updateRtHash(userId: Types.ObjectId, rt: string) {
    await this.usersRepository.updateRefreshToken(userId, this.hashRefreshToken(rt));
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

  async getFullProfile(userId: string) {
    const user = await this.usersRepository.findById(userId);
    if (!user) throw new UnauthorizedException('User not found');
    return this.toSafeProfile(user);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const set: Record<string, unknown> = {};
    if (dto.firstName !== undefined) set.firstName = dto.firstName.trim();
    if (dto.lastName !== undefined) set.lastName = dto.lastName.trim();
    for (const [key, value] of Object.entries(dto.studentProfile ?? {})) {
      if (value !== undefined) set[`studentProfile.${key}`] = value;
    }
    const user = await this.usersRepository.updateFields(userId, set);
    if (!user) throw new UnauthorizedException('User not found');
    return this.toSafeProfile(user);
  }

  /** Profile without password / refresh-token hashes, plus a string `id`. */
  private toSafeProfile(user: { toObject: () => any }) {
    // `_id` is replaced by a string `id`: raw ObjectIds serialize as {}.
    const { password, refreshToken, __v, _id, ...safeUser } = user.toObject();
    return { id: String(_id), ...safeUser };
  }
}