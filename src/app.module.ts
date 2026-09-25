import { Module } from '@nestjs/common';
import { THROTTLER_LIMIT, THROTTLER_TTL } from './common/config/constants';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { ContentModule } from './content/content.module';
import { FeedbackModule } from './feedback/feedback.module';
import { NewsModule } from './news/news.module';
import { QuizModule } from './quiz/quiz.module';
import { ReferenceModule } from './reference/reference.module';
import { CacheModule } from '@nestjs/cache-manager';
import { redisStore } from 'cache-manager-redis-store';
import * as Joi from 'joi';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'production', 'test', 'provision')
          .default('development'),
        PORT: Joi.number().default(4000),
        MONGODB_URI: Joi.string().required(),
        REDIS_HOST: Joi.string().allow('').optional(),
        REDIS_PORT: Joi.alternatives().try(Joi.number(), Joi.string().allow('')).optional(),
        REDIS_PASSWORD: Joi.string().allow('').optional(),
        JWT_SECRET: Joi.string().required(),
        JWT_EXPIRES_IN: Joi.string().required(),
        JWT_REFRESH_SECRET: Joi.string().required(),
        JWT_REFRESH_EXPIRES_IN: Joi.string().required(),
        RESEND_API_KEY: Joi.string().required(),
        MAIL_FROM: Joi.string().required(),
      }),
    }),
    CacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const host = configService.get<string>('REDIS_HOST');
        const port = configService.get<number>('REDIS_PORT');

        if (host && port) {
          return {
            store: redisStore as any,
            host,
            port,
            password: configService.get<string>('REDIS_PASSWORD'),
            ttl: 600,
          };
        }

        return {
          ttl: 600,
        };
      },
      inject: [ConfigService],
    }),
    ThrottlerModule.forRoot([{
      ttl: THROTTLER_TTL,
      limit: THROTTLER_LIMIT,
    }]),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        uri: configService.get<string>('MONGODB_URI'),
      }),
      inject: [ConfigService],
    }),
    AuthModule,
    HealthModule,
    ReferenceModule,
    ContentModule,
    QuizModule,
    FeedbackModule,
    NewsModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule { }