import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../auth.service';
import { getModelToken } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../../mailer/mailer.service';
import { OtpService } from '../../otp/otp.service';
import { UserType } from '../../common/enum/user-type.enum';
import * as bcrypt from 'bcrypt';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { User as UserSchema } from '../../users/model/user.model';

jest.mock('bcrypt', () => ({
    compare: jest.fn(),
    hash: jest.fn().mockResolvedValue('hashedValue'),
}));

// Mocks
const mockUser = {
    _id: 'someUserId',
    email: 'test@example.com',
    password: 'hashedPassword',
    userType: UserType.STUDENT,
    isVerified: true,
    refreshToken: 'someRefreshToken',
    save: jest.fn().mockResolvedValue(true),
    toObject: jest.fn().mockReturnValue({ email: 'test@example.com', _id: 'someUserId' }),
};

const mockUserModel = {
    findOne: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    updateOne: jest.fn(),
};

const mockJwtService = {
    signAsync: jest.fn().mockResolvedValue('someToken'),
};

const mockConfigService = {
    get: jest.fn().mockReturnValue('someSecret'),
};

const mockEmailService = {
    sendWelcomeAndVerificationEmail: jest.fn(),
};

const mockOtpService = {
    createOtp: jest.fn().mockResolvedValue('123456'),
    verifyOtp: jest.fn(),
};

describe('AuthService', () => {
    let service: AuthService;
    let model: any;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AuthService,
                {
                    provide: getModelToken(UserSchema.name),
                    useValue: mockUserModel,
                },
                {
                    provide: JwtService,
                    useValue: mockJwtService,
                },
                {
                    provide: ConfigService,
                    useValue: mockConfigService,
                },
                {
                    provide: EmailService,
                    useValue: mockEmailService,
                },
                {
                    provide: OtpService,
                    useValue: mockOtpService,
                },
            ],
        }).compile();

        service = module.get<AuthService>(AuthService);
        model = module.get(getModelToken(UserSchema.name));
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    describe('signup', () => {
        it('should successfully signup a new user', async () => {
            mockUserModel.findOne.mockResolvedValue(null);
            // Mock the constructor of the model
            const mockSave = jest.fn().mockResolvedValue({ ...mockUser });
            class MockUser {
                static findOne = mockUserModel.findOne;
                save = mockSave;
                constructor(public data: any) { }
            }
            // Hacky way to mock the model constructor injection
            (service as any).userModel = MockUser;

            const result = await service.signup({
                email: 'test@example.com',
                password: 'password',
                firstName: 'Test',
                lastName: 'User',
                username: 'testuser',
                userType: UserType.STUDENT,
                studentProfile: { institution: 'Test Uni' } as any
            });

            expect(result).toHaveProperty('message');
            expect(result).toHaveProperty('user');
            expect(mockOtpService.createOtp).toHaveBeenCalled();
            expect(mockEmailService.sendWelcomeAndVerificationEmail).toHaveBeenCalled();
        });

        it('should throw ConflictException if email exists', async () => {
            mockUserModel.findOne.mockResolvedValue(mockUser);

            await expect(service.signup({
                email: 'test@example.com',
                password: 'password',
                firstName: 'Test',
                lastName: 'User',
                username: 'testuser',
                userType: UserType.STUDENT,
                studentProfile: { institution: 'Test Uni' } as any
            })).rejects.toThrow(ConflictException);
        });
    });

    describe('login', () => {
        it('should return tokens for valid credentials', async () => {
            mockUserModel.findOne.mockResolvedValue(mockUser);
            (bcrypt.compare as jest.Mock).mockResolvedValue(true);

            const result = await service.login({
                email: 'test@example.com',
                password: 'password',
            });

            expect(result).toHaveProperty('accessToken');
            expect(result).toHaveProperty('refreshToken');
        });

        it('should throw UnauthorizedException for invalid password', async () => {
            mockUserModel.findOne.mockResolvedValue(mockUser);
            (bcrypt.compare as jest.Mock).mockResolvedValue(false);

            await expect(service.login({
                email: 'test@example.com',
                password: 'wrongpassword',
            })).rejects.toThrow(UnauthorizedException);
        });
    });
});