import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection } from 'mongoose';

/**
 * Boots the real AppModule (production config from app.setup.ts) against an
 * in-memory MongoDB, with email replaced by an in-process outbox.
 *
 * Used by the e2e tests and by `yarn dev:memory`.
 */

export type SentMail = { to: string; kind: 'verify' | 'resend' | 'reset'; code: string };

export class FakeEmailService {
  readonly sent: SentMail[] = [];
  constructor(private readonly log = false) {}

  private record(mail: SentMail) {
    this.sent.push(mail);
    if (this.log) console.log(`✉️  [${mail.kind}] code for ${mail.to}: ${mail.code}`);
  }

  async sendWelcomeAndVerificationEmail(to: string, _firstName: string, _userType: string, code: string) {
    this.record({ to, kind: 'verify', code });
  }

  async sendResendOtpEmail(to: string, _firstName: string, code: string) {
    this.record({ to, kind: 'resend', code });
  }

  async sendPasswordReset(to: string, code: string) {
    this.record({ to, kind: 'reset', code });
  }

  /** Latest code emailed to `to`. */
  lastCode(to: string) {
    return [...this.sent].reverse().find(m => m.to === to)?.code;
  }
}

export async function startInMemoryApp({ logEmails = false } = {}) {
  const mongo = await MongoMemoryServer.create({
    // 7.x ships native Apple-Silicon builds (older versions run under Rosetta).
    binary: { version: process.env.MONGOMS_VERSION ?? '7.0.14' },
    instance: { launchTimeout: 60_000, storageEngine: 'wiredTiger' },
  });

  // ConfigModule validates these when AppModule is first imported.
  Object.assign(process.env, {
    NODE_ENV: process.env.NODE_ENV ?? 'test',
    MONGODB_URI: mongo.getUri('edmira'),
    JWT_SECRET: 'test-access-secret',
    JWT_EXPIRES_IN: '15m',
    JWT_REFRESH_SECRET: 'test-refresh-secret',
    JWT_REFRESH_EXPIRES_IN: '7d',
    RESEND_API_KEY: 're_test_key',
    MAIL_FROM: 'EdMira <test@edmira.local>',
    REDIS_HOST: '',
  });

  const { AppModule } = await import('../../src/app.module');
  const { EmailService } = await import('../../src/mailer/mailer.service');
  const { configureApp } = await import('../../src/app.setup');

  const mail = new FakeEmailService(logEmails);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EmailService)
    .useValue(mail)
    .compile();

  const app: INestApplication = configureApp(moduleRef.createNestApplication());
  await app.init();
  const connection = app.get<Connection>(getConnectionToken());

  return {
    app,
    mail,
    connection,
    async stop() {
      await app.close();
      await mongo.stop();
    },
  };
}
