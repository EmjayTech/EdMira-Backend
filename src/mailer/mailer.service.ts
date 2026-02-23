// src/mail/email.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { Transporter } from 'nodemailer';

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter;

  constructor(private readonly configService: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.getEnv('MAIL_HOST'),
      port: Number(this.getEnv('MAIL_PORT')),
      secure: false,
      auth: {
        user: this.getEnv('MAIL_USER'),
        pass: this.getEnv('MAIL_PASSWORD'),
      },
      tls: {
        rejectUnauthorized: false,
      },
    });
  }


  async onModuleInit() {
    try {
      await this.transporter.verify();
      this.logger.log('Gmail SMTP connection established successfully');
    } catch (error) {
      this.logger.error(' Gmail SMTP connection failed', error);
      if (this.configService.get<string>('NODE_ENV') === 'production') {
        throw error;
      }
      this.logger.warn('Continuing startup without SMTP in non-production environment');
    }
  }

  async sendWelcomeAndVerificationEmail(
    email: string,
    firstName: string,
    userType: string,
    code: string,
  ): Promise<void> {
    await this.sendMail({
      to: email,
      subject: 'Welcome to EdMira Verify Your Account',
      html: this.getWelcomeVerificationTemplate(firstName, userType, code),
    });
  }

  async sendResendOtpEmail(
    email: string,
    firstName: string,
    code: string,
  ): Promise<void> {
    await this.sendMail({
      to: email,
      subject: 'EdMira Your New Verification Code',
      html: this.getResendOtpTemplate(firstName, code),
    });
  }

  async sendPasswordReset(email: string, code: string): Promise<void> {
    await this.sendMail({
      to: email,
      subject: 'Reset Your Password EdMira',
      html: `
        <h2>Password Reset</h2>
        <p>Your reset code is:</p>
        <div style="font-size:24px;font-weight:bold;color:#0a4d68;">${code}</div>
        <p>This code expires in <strong>10 minutes</strong>.</p>
      `,
    });
  }

  private async sendMail(options: {
    to: string;
    subject: string;
    html: string;
  }): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: `EdMira <${this.getEnv('MAIL_FROM')}>`,
        ...options,
      });

      this.logger.log(`Email sent to ${options.to}`);
    } catch (error) {
      this.logger.error(`Failed to send email to ${options.to}`, error);
      throw error;
    }
  }

  private getEnv(key: string): string {
    const value = this.configService.get<string>(key);
    if (!value) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
  }

  /* ===================== TEMPLATES ===================== */

  private getWelcomeVerificationTemplate(
    firstName: string,
    userType: string,
    code: string,
  ): string {
    const welcomeMessage = this.getWelcomeMessage(firstName, userType);

    return `
      <html>
        <body style="font-family: Arial, sans-serif; background:#f6f8fa;">
          <div style="max-width:600px;margin:auto;background:#fff;padding:20px;border-radius:8px;">
            <h1 style="background:#0a4d68;color:#fff;padding:15px;text-align:center;">
              Welcome to EdMira
            </h1>
            <p>${welcomeMessage}</p>
            <p>Please verify your email using the code below:</p>
            <div style="font-size:28px;font-weight:bold;color:#0a4d68;text-align:center;">
              ${code}
            </div>
            <p>This code expires in <strong>10 minutes</strong>.</p>
            <hr />
            <small>&copy; ${new Date().getFullYear()} EdMira</small>
          </div>
        </body>
      </html>
    `;
  }

  private getResendOtpTemplate(firstName: string, code: string): string {
    return `
      <html>
        <body>
          <h2>Hello ${firstName},</h2>
          <p>Your new verification code:</p>
          <div style="font-size:28px;font-weight:bold;color:#0a4d68;">
            ${code}
          </div>
          <p>This code expires in 10 minutes.</p>
          <p>EdMira Team</p>
        </body>
      </html>
    `;
  }

  private getWelcomeMessage(firstName: string, userType: string): string {
    if (userType === 'STUDENT') {
      return `Hello ${firstName}! Welcome to EdMira, your learning companion.`;
    }
    if (userType === 'PROFESSIONAL') {
      return `Hello Dr. ${firstName}! Welcome to EdMira, share knowledge and mentor others.`;
    }
    return `Hello ${firstName}! Welcome to EdMira.`;
  }
}