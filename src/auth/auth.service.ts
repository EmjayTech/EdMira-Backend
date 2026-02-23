// src/auth/auth.service.ts
import { Injectable, ConflictException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
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
import { User, UserDocument } from '../users/model/user.model';



@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly emailService: EmailService,
    private readonly otpService: OtpService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) { }


  async signup(signupDto: SignupDto): Promise<{ message: string; user: Partial<User> }> {
    this.validateProfiles(signupDto);

    const existingUser = await this.userModel.findOne({ email: signupDto.email });
    if (existingUser) {
      throw new ConflictException('Email already in use');
    }

    const { password, userType, studentProfile, professionalProfile, ...rest } = signupDto;
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const user = new this.userModel({
      ...rest,
      password: hashedPassword,
      userType,
      studentProfile: (userType === UserType.STUDENT || userType === UserType.HYBRID)
        ? studentProfile
        : undefined,
      professionalProfile: (userType === UserType.PROFESSIONAL || userType === UserType.HYBRID)
        ? professionalProfile
        : undefined,
    });

    const savedUser = await user.save();

    try {
      // Generate OTP and send welcome message together
      const otpCode = await this.otpService.createOtp(savedUser.id, savedUser.email);
      await this.emailService.sendWelcomeAndVerificationEmail(savedUser.email, savedUser.firstName, userType, otpCode);
    } catch (error) {
      console.error('Failed to send welcome email:', error);
      // We don't throw here to avoid rolling back valid user creation, but in real world maybe we should.
      // For now, let's just log it so we can debug.
    }

    // Return sanitized user object (using class-transformer would be better globally, but manual here ensures safety immediately)
    // ...existing code...

    // Return sanitized user object
    const { password: _password, ...safeUser } = savedUser.toObject();

    return {
      message: 'Signup successful. Please check your email for the verification code.',
      user: safeUser,
    };

// ...existing code...


  
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

  async verifyOtp(dto: VerifyOtpDto): Promise<{ message: string }> {
    const user = await this.userModel.findOne({ email: dto.email });
    if (!user) {
      throw new BadRequestException('User not found');
    }

    if (user.isVerified) {
      return { message: 'User is already verified' };
    }

    try {
      await this.otpService.verifyOtp(user._id, dto.code);
      user.isVerified = true;
      await user.save();
      return { message: 'OTP verified successfully. Account activated.' };
    } catch (error) {
      console.error(`OTP Verification failed for ${dto.email}:`, error.message);
      throw error; // Re-throw the BadRequestException from OtpService
    }
  }

  async resendOtp(dto: ResendOtpDto) {
    const user = await this.userModel.findOne({ email: dto.email });
    if (!user) throw new BadRequestException('User not found');

    const otp = await this.otpService.createOtp(user._id, user.email);
    await this.emailService.sendResendOtpEmail(user.email, user.firstName, otp);

    return { message: 'New verification code sent successfully.' };
  }
  async login(dto: LoginDto): Promise<{ accessToken: string; refreshToken: string }> {
    const user = await this.userModel.findOne({ email: dto.email });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');
    if (!user.isVerified) throw new UnauthorizedException('Please verify your email first');

    const tokens = await this.getTokens(user._id, user.email, user.userType);
    await this.updateRtHash(user._id, tokens.refreshToken);
    return tokens;
  }

  async logout(userId: string) {
    await this.userModel.updateOne({ _id: userId }, { refreshToken: null });
  }

  async refreshTokens(userId: string, rt: string) {
    const user = await this.userModel.findById(userId);
    if (!user || !user.refreshToken) throw new UnauthorizedException('Access Denied');

    const rtMatches = await bcrypt.compare(rt, user.refreshToken);
    if (!rtMatches) throw new UnauthorizedException('Access Denied');

    const tokens = await this.getTokens(user._id, user.email, user.userType);
    await this.updateRtHash(user._id, tokens.refreshToken);
    return tokens;
  }

  async updateRtHash(userId: Types.ObjectId, rt: string) {
    const hash = await bcrypt.hash(rt, SALT_ROUNDS);
    await this.userModel.updateOne({ _id: userId }, { refreshToken: hash });
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

    return {
      accessToken: at,
      refreshToken: rt,
    };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.userModel.findOne({ email: dto.email });
    if (!user) throw new BadRequestException('User not found');

    const otp = await this.otpService.createOtp(user._id, user.email);
    await this.emailService.sendPasswordReset(user.email, otp);
    return { message: 'Password reset code sent' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.userModel.findOne({ email: dto.email });
    if (!user) throw new BadRequestException('Email not found');

    await this.otpService.verifyOtp(user._id, dto.code);
    user.password = await bcrypt.hash(dto.newPassword, SALT_ROUNDS);
    await user.save();

    return { message: 'Password reset successful' };
  }

  async validateSocialLogin(profile: any): Promise<any> {
    const { email, firstName, lastName, socialId, provider, picture } = profile;

    // 1. Check if user exists by email
    let user = await this.userModel.findOne({ email });

    if (user) {
      // 2. If exists, update social ID if not present (Account linking)
      if (!user.socialId) {
        user.socialId = socialId;
        user.provider = provider;
        await user.save();
      }
      return user;
    }

    // 3. Create new user
    // Note: We need a password for the schema even if social login.
    // We'll generate a random strong password.
    const randomPassword = crypto.randomBytes(16).toString('hex') + '1A!';
    const hashedPassword = await bcrypt.hash(randomPassword, SALT_ROUNDS);

    user = new this.userModel({
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

    await user.save();
    return user;
  }
}