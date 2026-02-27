// src/auth/auth.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import type { StringValue } from 'ms';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from '../otp/otp.service';
import { OtpRepository } from '../otp/otp.repository';
import { JwtStrategy } from './jwt/jwt.strategy';
import { RtStrategy } from './jwt/rt.strategy';
import { GoogleStrategy } from './strategies/google.strategy';
import { LinkedInStrategy } from './strategies/linkedin.strategy';
import { MicrosoftStrategy } from './strategies/microsoft.strategy';
import { AppleStrategy } from './strategies/apple.strategy';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { EmailService } from '../mailer/mailer.service';
import { Otp, OtpSchema } from '../otp/schema/otp.schema';
import { UserModule } from '../users/user.module';


@Module({
  imports: [
    ConfigModule,
    PassportModule,
    UserModule,

    /**
     * ✅ Mongoose Schemas (OTP only — User is provided by UserModule)
     */
    MongooseModule.forFeature([
      { name: Otp.name, schema: OtpSchema },
    ]),

    /**
     * ✅ JWT Setup (Async for security)
     */
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.getOrThrow<string>('JWT_EXPIRES_IN') as StringValue,
        },
      }),
    }),
  ],

  controllers: [AuthController],

  providers: [
    AuthService,
    OtpService,
    OtpRepository,
    EmailService,
    JwtStrategy,
    RtStrategy,
    GoogleStrategy,
    LinkedInStrategy,
    MicrosoftStrategy,
    AppleStrategy,

    /**
     * ✅ Guards registered globally
     */
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],

  exports: [AuthService],
})
export class AuthModule { }