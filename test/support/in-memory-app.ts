import { ConsoleLogger, INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';

/**
 * Boots the real AppModule (production config from app.setup.ts) against an
 * in-memory MongoDB, with email replaced by an in-process outbox.
 *
 * Used by the e2e tests and by `yarn dev:memory`.
 */

export type SentMail = { to: string; kind: 'verify' | 'resend' | 'reset' | 'welcome' | 'invite' | `plan:${string}`; code?: string; url?: string };

export class FakeEmailService {
  readonly sent: SentMail[] = [];
  constructor(private readonly log = false) {}

  private record(mail: SentMail) {
    this.sent.push(mail);
    if (this.log) console.log(`✉️  [${mail.kind}] ${mail.url ? `link` : 'code'} for ${mail.to}: ${mail.url ?? mail.code}`);
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

  async sendWelcomeEmail(to: string, _firstName: string, _userType: string) {
    this.record({ to, kind: 'welcome' });
  }

  async sendStaffInvite(to: string, _firstName: string, _inviter: string, _role: string, url: string) {
    this.record({ to, kind: 'invite', url });
  }

  async sendPlanEmail(to: string, subject: string, _html: string, kind = 'plan') {
    this.record({ to, kind: `plan:${kind}`, code: subject });
  }

  /** Latest code emailed to `to`. */
  lastCode(to: string) {
    return [...this.sent].reverse().find(m => m.to === to && m.code)?.code;
  }
}

export async function startInMemoryApp({ logEmails = false } = {}) {
  // A one-node replica set, like Atlas, so transactions work (quiz scoring uses them).
  const mongo = await MongoMemoryReplSet.create({
    // 7.x ships native Apple-Silicon builds (older versions run under Rosetta).
    binary: { version: process.env.MONGOMS_VERSION ?? '7.0.14' },
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ launchTimeout: 60_000 }],
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

  const app: INestApplication = configureApp(moduleRef.createNestApplication({ rawBody: true }));
  // The testing module's default logger hides everything but errors; show normal logs
  // for `yarn dev:memory` (Jest still gets the quiet one).
  if (process.env.NODE_ENV !== 'test') app.useLogger(new ConsoleLogger());
  await app.init();
  // Under Jest, listen once on 127.0.0.1. Otherwise supertest opens a new
  // random port per request on all interfaces, and now and then the OS hands
  // it the port the in-memory mongod holds on 127.0.0.1, so the request
  // reaches MongoDB ("Parse Error: Expected HTTP/", stray 401s).
  if (process.env.JEST_WORKER_ID) await app.listen(0, '127.0.0.1');
  const connection = app.get<Connection>(getConnectionToken());

  const { UsersRepository } = await import('../../src/users/user.repository');
  const bcrypt = await import('bcrypt');

  /** Creates a verified staff account (what `yarn staff` does). */
  async function createStaff(email: string, role: 'admin' | 'creator' | 'reviewer', password: string, name: string) {
    const [firstName, ...rest] = name.split(' ');
    await app.get(UsersRepository).create({
      email,
      password: await bcrypt.hash(password, 10),
      firstName,
      lastName: rest.join(' '),
      username: email.split('@')[0],
      role: role as any,
      isVerified: true,
    });
  }

  return {
    app,
    mail,
    connection,
    createStaff,
    async stop() {
      await app.close();
      await mongo.stop();
    },
  };
}
