// src/auth/auth.service.ts
import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  Inject,
  ForbiddenException,
  ServiceUnavailableException,
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
import { UsernameService } from '../users/username.service';
import { UserDocument } from '../users/model/user.model';
import { AnalyticsService } from '../analytics/analytics.service';
import { LoginAttemptsService } from './login-attempts.service';
import { ChangeUsernameDto } from './dto/change-username.dto';
import { PrivacyDto } from './dto/privacy.dto';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { ReferralsService } from '../social/referrals.service';

/** TTL for blacklisted access tokens in seconds (15 minutes = AT lifetime) */
const AT_BLACKLIST_TTL = 15 * 60;

/** Pending-signup OTP/cache settings */
const PENDING_SIGNUP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 3;
const pendingKey = (email: string) => `pending_signup:${email.toLowerCase()}`;

/**
 * The only login error, whatever went wrong (unknown email/username, wrong
 * password, a username shared by older accounts) — never reveals which
 * accounts exist. `code` lets the apps show translated text.
 */
const INVALID_CREDENTIALS = {
  statusCode: 401,
  code: 'INVALID_CREDENTIALS',
  message: 'Incorrect email/username or password.',
};

/** Compared against when no account matches, so failures take the same time. */
const TIMING_GUARD_HASH = bcrypt.hashSync('edmira-timing-guard', SALT_ROUNDS);

const RESET_SENT_MESSAGE = "If an account matches, we've sent a password reset code to its email.";

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
    private readonly usernames: UsernameService,
    private readonly loginAttempts: LoginAttemptsService,
    private readonly analytics: AnalyticsService,
    private readonly leaderboards: LeaderboardService,
    private readonly referrals: ReferralsService,
  ) { }

  // ──────────────────────────────────── Signup ────────────────────────────────────

  async signup(signupDto: SignupDto): Promise<{ message: string }> {
    this.validateProfiles(signupDto);

    const existingUser = await this.usersRepository.findByEmail(signupDto.email);
    if (existingUser) {
      throw new ConflictException('Email already in use');
    }
    this.usernames.assertUsable(await this.usernames.verdict(signupDto.username));

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
      // Don't claim a code was sent when it wasn't — the student would wait
      // for an email that never arrives. Let them try again instead.
      console.error('Failed to send verification email:', error);
      await this.cacheManager.del(pendingKey(signupDto.email));
      throw new ServiceUnavailableException(
        "We couldn't send the verification email. Please check the address and try again in a moment.",
      );
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
    if ((await this.usernames.verdict(pending.payload.username)) === 'taken') {
      await this.cacheManager.del(key);
      throw new ConflictException({
        statusCode: 409,
        code: 'USERNAME_TAKEN',
        message: 'Someone took that username while you were verifying. Please sign up again with a different username.',
      });
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

    // "Invited by": credit the inviter and send their connection request. Never fails sign-up.
    await this.referrals.attribute(savedUser, referralCode).catch(error => console.error('Referral failed:', error));

    // The account already exists, so a failed welcome email shouldn't fail verification.
    this.emailService
      .sendWelcomeEmail(savedUser.email, savedUser.firstName, savedUser.userType)
      .catch(error => console.error('Failed to send welcome email:', error));

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

  /**
   * Log in with an email or a username (any letter case) and password.
   * `ip` feeds the lockout: 5 failures per identifier + IP → 15-minute wait.
   */
  async login(dto: LoginDto, ip = 'unknown'): Promise<{ accessToken: string; refreshToken: string }> {
    const identifier = (dto.identifier ?? dto.email ?? '').trim();
    await this.loginAttempts.assertNotLocked(identifier, ip);

    const user = await this.findLoginAccount(identifier, dto.password);
    if (!user) {
      await this.loginAttempts.recordFailure(identifier, ip);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    await this.loginAttempts.clear(identifier, ip);
    // Only reached with the right password, so these reveal nothing new.
    if (!user.isVerified) throw new UnauthorizedException('Please verify your email first');
    await this.assertActive(user);

    const tokens = await this.getTokens(user._id as Types.ObjectId, user.email, user.userType);
    await this.updateRtHash(user._id as Types.ObjectId, tokens.refreshToken);
    await this.usersRepository.touchLastLogin(user._id as Types.ObjectId);
    if (!identifier.includes('@')) this.analytics.track('login_with_username', user._id as Types.ObjectId);
    return tokens;
  }

  /** Email if it contains "@", otherwise username (any case). Older usernames may match several accounts. */
  private async accountsFor(identifier: string): Promise<UserDocument[]> {
    if (!identifier) return [];
    if (identifier.includes('@')) {
      const user = await this.usersRepository.findByEmail(identifier);
      return user ? [user] : [];
    }
    return this.usersRepository.findByUsername(identifier);
  }

  /**
   * The one account this identifier + password opens, or null. When a
   * shared (pre-Nov 2026) username + password opens two accounts we can't
   * tell which is meant, so that fails too — the student can use their email.
   */
  private async findLoginAccount(identifier: string, password: string) {
    const candidates = await this.accountsFor(identifier);
    if (!candidates.length) {
      await bcrypt.compare(password, TIMING_GUARD_HASH);
      return null;
    }
    const opened: UserDocument[] = [];
    for (const account of candidates) {
      // Invited staff have no password until they accept the invite.
      if (account.password && (await bcrypt.compare(password, account.password))) opened.push(account);
    }
    return opened.length === 1 ? opened[0] : null;
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
    await this.assertActive(user);

    const tokens = await this.getTokens(user._id as Types.ObjectId, user.email, user.userType);
    await this.updateRtHash(user._id as Types.ObjectId, tokens.refreshToken);
    return tokens;
  }

  /**
   * Suspended (until a date, or until reactivated) and banned accounts can't
   * log in or refresh. A timed suspension that has ended is lifted here.
   */
  private async assertActive(user: UserDocument) {
    if (user.status === AccountStatus.BANNED) {
      throw new ForbiddenException('This account has been closed. Contact EdMira support.');
    }
    if (user.status !== AccountStatus.SUSPENDED) return;
    if (user.suspendedUntil && user.suspendedUntil <= new Date()) {
      await this.usersRepository.updateFields(user._id as Types.ObjectId, { status: AccountStatus.ACTIVE, suspendedUntil: null });
      return;
    }
    throw new ForbiddenException(
      user.suspendedUntil
        ? `This account is suspended until ${user.suspendedUntil.toDateString()}. Contact EdMira support.`
        : 'This account has been suspended. Contact EdMira support.',
    );
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

  /** The account a password reset is for: one exact match, or none. */
  private async resetAccountFor(identifier: string) {
    const accounts = await this.accountsFor(identifier.trim());
    return accounts.length === 1 ? accounts[0] : null;
  }

  /**
   * Emails a reset code. Always the same reply — including while the
   * 60-second resend cooldown runs or if the email fails — so the response
   * never reveals whether an account matched. (The last code stays valid.)
   */
  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.resetAccountFor(dto.identifier ?? dto.email ?? '');
    if (user?.email) {
      try {
        const otp = await this.otpService.createOtp(user._id as Types.ObjectId, user.email);
        await this.emailService.sendPasswordReset(user.email, otp);
      } catch (error) {
        if (!(error instanceof BadRequestException)) console.error('Password reset email failed:', error);
      }
    }
    return { message: RESET_SENT_MESSAGE };
  }

  // ──────────────────────────────── Reset Password ────────────────────────────────

  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.resetAccountFor(dto.identifier ?? dto.email ?? '');
    // Same error as a wrong code, so this doesn't reveal which accounts exist.
    if (!user) throw new BadRequestException('That code is invalid or has expired.');

    await this.otpService.verifyOtp(user._id as Types.ObjectId, dto.code);
    const hashedPassword = await bcrypt.hash(dto.newPassword, SALT_ROUNDS);
    await this.usersRepository.updatePassword(user._id as any, hashedPassword);

    return { message: 'Password reset successful' };
  }

  async getFullProfile(userId: string) {
    const user = await this.usersRepository.findById(userId);
    if (!user) throw new UnauthorizedException('User not found');
    return { ...this.toSafeProfile(user), referralCount: await this.referrals.count(userId) };
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
    // A new school / programme / level moves this week's leaderboard row too.
    if (dto.studentProfile) await this.leaderboards.syncAcademics(userId);
    return this.toSafeProfile(user);
  }

  /** Profile → Privacy. Takes effect on the next leaderboard request. */
  async updatePrivacy(userId: string, dto: PrivacyDto) {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) if (value !== undefined) set[`privacy.${key}`] = value;
    const user = await this.usersRepository.updateFields(userId, set);
    if (!user) throw new UnauthorizedException('User not found');
    return this.toSafeProfile(user);
  }

  // ─────────────────────────────────── Username ───────────────────────────────────

  /** For the live check while typing (sign-up and Change username). */
  async usernameAvailability(username: string) {
    const verdict = await this.usernames.verdict(username ?? '');
    return verdict ? { available: false, reason: verdict } : { available: true };
  }

  /** Students can change their username once every 30 days. */
  async changeUsername(userId: string, dto: ChangeUsernameDto) {
    const user = await this.usersRepository.findById(userId);
    if (!user) throw new UnauthorizedException('User not found');
    const updated = await this.usernames.change(user, dto.username);
    return this.toSafeProfile(updated);
  }

  /** Profile without password / refresh-token hashes, plus a string `id`. */
  private toSafeProfile(user: UserDocument & { toObject: () => any }) {
    // `_id` is replaced by a string `id`: raw ObjectIds serialize as {}.
    // Never sent: secrets, another student's id (referredBy), moderation internals.
    const { password, refreshToken, __v, _id, usernameLower, referredBy, flag, requestsPausedUntil, ...safeUser } = user.toObject();
    const next = this.usernames.nextChangeAt(user);
    return { id: String(_id), ...safeUser, usernameChangeAvailableAt: next ? next.toISOString() : null };
  }
}