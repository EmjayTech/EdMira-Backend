import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { UserDocument } from './model/user.model';
import { UsernameHistory, UsernameHistoryDocument } from './schema/username-history.schema';
import { UsersRepository } from './user.repository';
import {
  USERNAME_CHANGE_COOLDOWN_DAYS,
  USERNAME_PROBLEM_MESSAGE,
  USERNAME_RESERVATION_DAYS,
  UsernameProblem,
  normalizeUsername,
  usernameProblem,
  usernameStem,
} from './username-policy';

const DAY_MS = 24 * 60 * 60 * 1000;

export type UsernameVerdict = UsernameProblem | 'taken' | null;

/** Error codes the apps translate (the message is an English fallback). */
const CODE: Record<UsernameProblem | 'taken', string> = {
  invalid: 'USERNAME_INVALID',
  reserved: 'USERNAME_RESERVED',
  offensive: 'USERNAME_OFFENSIVE',
  taken: 'USERNAME_TAKEN',
};

/**
 * Choosing, checking and changing usernames. Rules: ./username-policy.ts.
 * "Taken" covers names in use (any case) and names released in the last
 * 30 days by someone else.
 */
@Injectable()
export class UsernameService {
  constructor(
    private readonly users: UsersRepository,
    @InjectModel(UsernameHistory.name) private readonly history: Model<UsernameHistoryDocument>,
  ) {}

  /** Why `username` can't be used (by `forUserId`, or by a new account), or null if it can. */
  async verdict(
    username: string,
    opts: { forUserId?: string | Types.ObjectId; allowReserved?: boolean } = {},
  ): Promise<UsernameVerdict> {
    const rule = usernameProblem(username, opts);
    if (rule) return rule;
    if (await this.users.usernameInUse(username, opts.forUserId)) return 'taken';
    if (await this.reservedForSomeoneElse(username, opts.forUserId)) return 'taken';
    return null;
  }

  /** Throws the matching 400 / 409 for a verdict. */
  assertUsable(verdict: UsernameVerdict) {
    if (!verdict) return;
    const body = { statusCode: verdict === 'taken' ? 409 : 400, code: CODE[verdict], reason: verdict, message: USERNAME_PROBLEM_MESSAGE[verdict] };
    throw verdict === 'taken' ? new ConflictException(body) : new BadRequestException(body);
  }

  /** When this student may change their username again, or null if they can now. */
  nextChangeAt(user: { usernameChangedAt?: Date | null }): Date | null {
    if (!user.usernameChangedAt) return null;
    const next = new Date(user.usernameChangedAt.getTime() + USERNAME_CHANGE_COOLDOWN_DAYS * DAY_MS);
    return next > new Date() ? next : null;
  }

  /**
   * Change a username. Students: once every 30 days (changing only the
   * letter case is free). Staff (`staffName` set) can change any student's
   * username at any time, e.g. to remove an offensive one.
   * The old name is recorded and stays reserved for 30 days.
   */
  async change(user: UserDocument, newUsername: string, by: { staffName?: string } = {}) {
    const value = newUsername.trim();
    const currentLower = user.username ? normalizeUsername(user.username) : '';
    const caseOnly = currentLower !== '' && normalizeUsername(value) === currentLower;

    if (!by.staffName && !caseOnly) {
      const next = this.nextChangeAt(user);
      if (next) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'USERNAME_CHANGE_TOO_SOON',
          nextChangeAt: next.toISOString(),
          message: `You can change your username again on ${next.toDateString()}.`,
        });
      }
    }

    this.assertUsable(await this.verdict(value, { forUserId: user._id as Types.ObjectId, allowReserved: !!user.role }));

    const now = new Date();
    if (user.username && !caseOnly) {
      await this.history.create({
        userId: user._id,
        username: user.username,
        usernameLower: currentLower,
        releasedAt: now,
        reservedUntil: new Date(now.getTime() + USERNAME_RESERVATION_DAYS * DAY_MS),
        changedBy: by.staffName ?? 'student',
      });
    }
    const changedAt = by.staffName || caseOnly ? undefined : now;
    return this.users.setUsername(user._id as Types.ObjectId, value, changedAt);
  }

  /** Previous usernames of one account, newest first (admin view). */
  historyOf(userId: string | Types.ObjectId) {
    return this.history.find({ userId }).sort({ releasedAt: -1 }).limit(20).lean().exec();
  }

  /**
   * A free, valid username built from `base` (e.g. the start of a staff
   * email): "ada.obi", then "ada.obi1", "ada.obi2"… Staff may use reserved names.
   */
  async uniqueFrom(base: string): Promise<string> {
    const stem = usernameStem(base);
    for (let n = 0; n < 1000; n++) {
      const candidate = n ? `${stem}${n}` : stem;
      if (!(await this.verdict(candidate, { allowReserved: true }))) return candidate;
    }
    return `${stem}${Date.now() % 1000}`;
  }

  private async reservedForSomeoneElse(username: string, forUserId?: string | Types.ObjectId) {
    const query: Record<string, unknown> = {
      usernameLower: normalizeUsername(username),
      reservedUntil: { $gt: new Date() },
    };
    if (forUserId) query.userId = { $ne: new Types.ObjectId(String(forUserId)) };
    return !!(await this.history.exists(query));
  }
}
