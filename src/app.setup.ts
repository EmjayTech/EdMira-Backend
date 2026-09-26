import { ClassSerializerInterceptor, INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';
import { requestLogger } from './common/middleware/request-logger';

/**
 * Everything main.ts applies to the app. Shared with the e2e tests so they
 * exercise exactly the production configuration.
 */
export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('api/v1');

  // One log line per request (skipped under Jest to keep test output clean).
  if (process.env.NODE_ENV !== 'test') app.use(requestLogger);

  // Security & Optimization
  app.use(helmet());
  app.use(compression());

  // CORS — restrict origins from env; allow all only in development.
  // (The mobile app is not a browser, so CORS doesn't affect it.)
  const configService = app.get(ConfigService);
  const allowedOrigins = configService.get<string>('ALLOWED_ORIGINS');
  const nodeEnv = configService.get<string>('NODE_ENV');
  app.enableCors({
    origin:
      nodeEnv === 'development' && !allowedOrigins
        ? true
        : allowedOrigins?.split(',').map(o => o.trim()) || [],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  const config = new DocumentBuilder()
    .setTitle('EdMira API')
    .setDescription('Auth, content, quizzes, feedback and news for the EdMira apps')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));

  app.enableShutdownHooks();
  return app;
}
