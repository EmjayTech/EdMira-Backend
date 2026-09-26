import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from '../auth.service';
import { EmailService } from '../../mailer/mailer.service';
import { OtpService } from '../../otp/otp.service';
import { UsersRepository } from '../../users/user.repository';
import { UserType } from '../../common/enum/user-type.enum';
import { Department } from '../../common/enum/department.enum';
import { Institution } from '../../common/enum/institution.enum';
import { Level, LevelType } from '../../common/enum/level.enum';
import { SignupDto } from '../dto/signup.dto';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn().mockResolvedValue('hashedPassword'),
}));

const signupDto: SignupDto = {
  email: 'test@example.com',
  password: 'Str0ng!Pass',
  firstName: 'Test',
  lastName: 'User',
  username: 'testuser',
  userType: UserType.STUDENT,
  countryCode: '+234',
  phoneNumber: '8012345678',
  referralCode: 'FRIEND1',
  studentProfile: {
    institution: Institution.UNIVERSITY_OF_LAGOS,
    faculty: 'Faculty of Clinical Sciences',
    department: Department.MBBS,
    levelType: LevelType.UNDERGRADUATE,
    level: Level.LEVEL_300,
  },
};

describe('AuthService', () => {
  let service: AuthService;
  const cache = new Map<string, unknown>();
  const users = {
    findByEmail: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    updateRefreshToken: jest.fn(),
    updateFields: jest.fn(),
  };
  const email = { sendWelcomeAndVerificationEmail: jest.fn(), sendResendOtpEmail: jest.fn() };

  beforeEach(async () => {
    cache.clear();
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersRepository, useValue: users },
        { provide: EmailService, useValue: email },
        { provide: OtpService, useValue: {} },
        { provide: JwtService, useValue: { signAsync: jest.fn().mockResolvedValue('signed.jwt.token') } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('secret') } },
        {
          provide: CACHE_MANAGER,
          useValue: {
            get: jest.fn(async (key: string) => cache.get(key)),
            set: jest.fn(async (key: string, value: unknown) => void cache.set(key, value)),
            del: jest.fn(async (key: string) => void cache.delete(key)),
          },
        },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  describe('signup', () => {
    it('holds the sign-up until verified and emails a code', async () => {
      users.findByEmail.mockResolvedValue(null);
      const result = await service.signup(signupDto);
      expect(result.message).toMatch(/check your email/i);
      expect(users.create).not.toHaveBeenCalled();
      expect(email.sendWelcomeAndVerificationEmail).toHaveBeenCalledWith(
        signupDto.email,
        'Test',
        UserType.STUDENT,
        expect.stringMatching(/^\d{6}$/),
      );
    });

    it('reports a failed email instead of claiming a code was sent', async () => {
      users.findByEmail.mockResolvedValue(null);
      email.sendWelcomeAndVerificationEmail.mockRejectedValueOnce(new Error('Resend: domain not verified'));
      await expect(service.signup(signupDto)).rejects.toThrow("couldn't send the verification email");
      // Nothing left pending, so the student can simply try again.
      users.findByEmail.mockResolvedValue(null);
      await expect(service.signup(signupDto)).resolves.toHaveProperty('message');
    });

    it('refuses an email that is already registered', async () => {
      users.findByEmail.mockResolvedValue({ email: signupDto.email });
      await expect(service.signup(signupDto)).rejects.toThrow(ConflictException);
    });
  });

  describe('verifyOtp', () => {
    it('creates the account with phone and referral code, and returns tokens', async () => {
      users.findByEmail.mockResolvedValue(null);
      await service.signup(signupDto);
      const code = email.sendWelcomeAndVerificationEmail.mock.calls[0][3];
      users.create.mockImplementation(async data => ({
        ...data,
        _id: 'u1',
        toObject: () => ({ ...data, _id: 'u1' }),
      }));

      const result = await service.verifyOtp({ email: signupDto.email, code });

      expect(users.create).toHaveBeenCalledWith(
        expect.objectContaining({
          phone: { countryCode: '+234', number: '8012345678' },
          studentProfile: expect.objectContaining({ referralCode: 'FRIEND1' }),
          isVerified: true,
        }),
      );
      expect(result).toMatchObject({ accessToken: 'signed.jwt.token', refreshToken: 'signed.jwt.token' });
      expect(result.user).not.toHaveProperty('password');
    });

    it('rejects a wrong code', async () => {
      users.findByEmail.mockResolvedValue(null);
      await service.signup(signupDto);
      await expect(service.verifyOtp({ email: signupDto.email, code: '000000' })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('login', () => {
    it('returns tokens for valid credentials', async () => {
      users.findByEmail.mockResolvedValue({ _id: 'u1', password: 'hash', isVerified: true });
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      const result = await service.login({ email: 'test@example.com', password: 'Str0ng!Pass' });
      expect(result).toEqual({ accessToken: 'signed.jwt.token', refreshToken: 'signed.jwt.token' });
      // Stored as a SHA-256 hex digest, never the raw token.
      expect(users.updateRefreshToken).toHaveBeenCalledWith('u1', expect.stringMatching(/^[0-9a-f]{64}$/));
    });

    it('rejects a wrong password', async () => {
      users.findByEmail.mockResolvedValue({ _id: 'u1', password: 'hash', isVerified: true });
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(service.login({ email: 'test@example.com', password: 'nope' })).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('refreshTokens', () => {
    it('only accepts the refresh token that was last issued', async () => {
      users.findByEmail.mockResolvedValue({ _id: 'u1', password: 'hash', isVerified: true });
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      await service.login({ email: 'test@example.com', password: 'x' });
      const storedHash = users.updateRefreshToken.mock.calls[0][1];
      users.findById.mockResolvedValue({ _id: 'u1', refreshToken: storedHash });

      await expect(service.refreshTokens('u1', 'signed.jwt.token')).resolves.toHaveProperty('accessToken');
      await expect(service.refreshTokens('u1', 'some.other.token')).rejects.toThrow(UnauthorizedException);
    });
  });
});
