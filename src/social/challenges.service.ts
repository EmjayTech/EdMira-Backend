import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'crypto';
import { Model, Types } from 'mongoose';
import { AnalyticsService } from '../analytics/analytics.service';
import { presentQuizQuestion } from '../content/content.presenter';
import { ContentService } from '../content/content.service';
import { QuizService } from '../quiz/quiz.service';
import { User, UserDocument } from '../users/model/user.model';
import { ConnectionsService } from './connections.service';
import { NotificationsService } from './notifications.service';
import { Person, PeopleService, publicStudent } from './people.service';
import { SafetyService } from './safety.service';
import { Challenge, ChallengeDocument, ChallengeRun, challengeWinner } from './schemas/challenge.schema';
import { CHALLENGES } from './social-policy';
import { PlansService } from '../plans/plans.service';

type Side = 'challenger' | 'opponent';
const NOT_FOUND = { statusCode: 404, message: 'Not found' };
const OPEN = ['pending', 'accepted'] as const;

/** Short, unambiguous link code (no 0/O/1/l). */
const newCode = () => {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return [...randomBytes(8)].map(b => alphabet[b % alphabet.length]).join('');
};

/**
 * Challenge a friend: same questions for both, server-timed, scored on the
 * server. Only between accepted connections (PeopleService.areConnected);
 * a shared link first turns into a connection request.
 */
@Injectable()
export class ChallengesService {
  constructor(
    @InjectModel(Challenge.name) private readonly challenges: Model<ChallengeDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly people: PeopleService,
    private readonly connections: ConnectionsService,
    private readonly content: ContentService,
    private readonly quiz: QuizService,
    private readonly notifications: NotificationsService,
    private readonly safety: SafetyService,
    private readonly analytics: AnalyticsService,
    private readonly plans: PlansService,
  ) {}

  // ── Creating ───────────────────────────────────────────────────────────────

  /**
   * Challenge a connection (`username`) on a topic, or — without a username —
   * make a link to share. 404 for anyone who isn't an accepted connection.
   */
  async create(userId: string, topicId: string, username?: string) {
    const me = await this.people.me(userId);
    if (me.role) throw new NotFoundException(NOT_FOUND);
    await this.plans.assertFeature(userId, 'create_challenge'); // accepting one stays free

    let opponent: Person | null = null;
    if (username) {
      opponent = await this.people.visible(me, username);
      if (!opponent || !(await this.people.areConnected(me._id, opponent._id))) throw new NotFoundException(NOT_FOUND);
    }
    await this.assertMayCreate(me._id);

    const { topic, course } = await this.content.findVisibleTopic(topicId);
    const pool = await this.content.getQuizQuestions(String(topic._id));
    if (pool.length < CHALLENGES.minQuestions) {
      throw new BadRequestException({ statusCode: 400, code: 'TOO_FEW_QUESTIONS', message: 'This topic needs a few more questions before it can be used for a challenge.' });
    }
    const picked = [...pool].sort(() => Math.random() - 0.5).slice(0, CHALLENGES.maxQuestions);

    const challenge = await this.challenges.create({
      code: newCode(),
      challengerId: me._id,
      opponentId: opponent?._id,
      topicId: topic._id,
      topicTitle: topic.title,
      courseTitle: course.title,
      questionIds: picked.map(q => new Types.ObjectId(q.id)),
      status: 'pending',
      viaLink: !opponent,
      expiresAt: new Date(Date.now() + CHALLENGES.expireAfterMs),
    });
    if (opponent) await this.notifications.notify(opponent._id, 'challenge_received', me._id, String(challenge._id));
    await this.safety.log('challenge_sent', me._id, opponent?._id ?? null, { viaLink: !opponent });
    this.analytics.track('challenge_sent', me._id);
    return this.present(challenge, userId);
  }

  private async assertMayCreate(userId: Types.ObjectId) {
    const [today, open] = await Promise.all([
      this.challenges.countDocuments({ challengerId: userId, createdAt: { $gte: new Date(Date.now() - 86_400_000) } }),
      this.challenges.countDocuments({ challengerId: userId, status: { $in: OPEN }, expiresAt: { $gt: new Date() } }),
    ]);
    if (today >= CHALLENGES.perDay || open >= CHALLENGES.maxOpen) {
      await this.safety.log('challenge_rate_limited', userId, null, { today, open });
      await this.safety.evaluate(userId);
      throw new HttpException(
        {
          statusCode: 429,
          code: 'CHALLENGE_LIMIT',
          message: open >= CHALLENGES.maxOpen ? 'You have a lot of open challenges. Finish some first.' : `You've sent ${CHALLENGES.perDay} challenges today. Try again tomorrow.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  /** My challenges (sent and received), newest first. */
  async list(userId: string) {
    const me = new Types.ObjectId(userId);
    const rows = await this.challenges
      .find({ $or: [{ challengerId: me }, { opponentId: me }] })
      .sort({ createdAt: -1 })
      .limit(50)
      .exec();
    const out = [];
    for (const c of rows) out.push(await this.present(await this.settle(c), userId));
    return out;
  }

  /** One challenge — only for the two students in it. */
  async get(userId: string, id: string) {
    return this.present(await this.settle(await this.mine(userId, id)), userId);
  }

  /**
   * Open a shared link. The challenger sees their challenge; a connection
   * claims an unclaimed link challenge; anyone else gets a connection request
   * from the challenger first (`needsConnection`). 404 if it's gone or blocked.
   */
  async openLink(userId: string, code: string) {
    const c = await this.challenges.findOne({ code: String(code).toLowerCase() }).exec();
    if (!c) throw new NotFoundException(NOT_FOUND);
    await this.settle(c);
    const me = await this.people.me(userId);
    if ([String(c.challengerId), String(c.opponentId)].includes(userId)) return this.present(c, userId);
    if (c.opponentId || c.status !== 'pending' || me.role) throw new NotFoundException(NOT_FOUND);

    const challenger = await this.people.me(String(c.challengerId));
    if (!this.people.isActive(challenger) || (await this.people.isBlockedBetween(me._id, challenger._id))) throw new NotFoundException(NOT_FOUND);

    if (!(await this.people.areConnected(me._id, challenger._id))) {
      await this.connections.requestFromLink(challenger._id, me._id);
      return { needsConnection: true, challenger: publicStudent(challenger), topicTitle: c.topicTitle, courseTitle: c.courseTitle, code: c.code };
    }
    const claimed = await this.challenges
      .findOneAndUpdate({ _id: c._id, opponentId: { $exists: false }, status: 'pending' }, { $set: { opponentId: me._id, status: 'accepted' } }, { new: true })
      .exec();
    if (!claimed) throw new NotFoundException(NOT_FOUND); // someone else got there first
    await this.notifications.notify(c.challengerId, 'challenge_received', me._id, String(c._id));
    return this.present(claimed, userId);
  }

  /** For the public challenge page (no login): who, what topic, still open? */
  async publicLink(code: string) {
    const c = await this.challenges.findOne({ code: String(code).toLowerCase() }).exec();
    if (!c) throw new NotFoundException(NOT_FOUND);
    await this.settle(c);
    const challenger = await this.users.findById(c.challengerId).select('username role studentProfile status isVerified avatar').lean().exec();
    if (!challenger) throw new NotFoundException(NOT_FOUND);
    return {
      challenger: { username: challenger.username },
      topicTitle: c.topicTitle,
      courseTitle: c.courseTitle,
      open: c.status === 'pending' && !c.opponentId,
      expiresAt: c.expiresAt.toISOString(),
    };
  }

  // ── Acting ─────────────────────────────────────────────────────────────────

  async respond(userId: string, id: string, action: 'accept' | 'decline' | 'cancel') {
    const c = await this.settle(await this.mine(userId, id));
    const side = this.sideOf(c, userId);
    const allowed =
      c.status === 'pending' &&
      ((action === 'cancel' && side === 'challenger') || (action !== 'cancel' && side === 'opponent'));
    if (!allowed) throw new ConflictException({ statusCode: 409, code: 'NOT_OPEN', message: 'This challenge is no longer open.' });
    c.status = action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'cancelled';
    await c.save();
    return this.present(c, userId);
  }

  /**
   * Start my run: the server notes the time and hands out the questions
   * (no answers). The challenger can play straight away; the opponent after
   * accepting. Starting again returns the same questions and keeps the
   * first start time.
   */
  async start(userId: string, id: string) {
    const c = await this.settle(await this.mine(userId, id));
    const side = this.sideOf(c, userId);
    const playable = side === 'challenger' ? (OPEN as readonly string[]).includes(c.status) : c.status === 'accepted';
    if (!playable || c[side].submittedAt) throw new ConflictException({ statusCode: 409, code: 'NOT_OPEN', message: 'This challenge is no longer open.' });
    if (!c[side].startedAt) {
      // A challenge is played in full, so it needs that many questions left today.
      const allowance = await this.plans.allowance(userId);
      if (allowance.remaining !== null && allowance.remaining < c.questionIds.length) this.plans.limitReached(allowance);
      c.set(`${side}.startedAt`, new Date());
      await c.save();
    }
    const questions = await this.content.findQuestionsByIds(c.questionIds);
    const byId = new Map(questions.map(q => [String(q._id), q]));
    return {
      challengeId: String(c._id),
      topicId: String(c.topicId),
      startedAt: c[side].startedAt!.toISOString(),
      questions: c.questionIds.flatMap(qid => (byId.has(String(qid)) ? [presentQuizQuestion(byId.get(String(qid))!)] : [])),
    };
  }

  /** Submit my answers once; graded on the server and also counted as a normal quiz. */
  async submit(userId: string, id: string, answers: { questionId: string; selectedIndex: number | null }[]) {
    const c = await this.settle(await this.mine(userId, id));
    const side = this.sideOf(c, userId);
    const run = c[side];
    if (!run.startedAt || run.submittedAt || !(OPEN as readonly string[]).includes(c.status)) {
      throw new ConflictException({ statusCode: 409, code: 'NOT_OPEN', message: 'This challenge is no longer open.' });
    }
    const allowed = new Set(c.questionIds.map(String));
    const mineOnly = answers.filter(a => allowed.has(a.questionId));
    if (!mineOnly.length) throw new BadRequestException('Answer the challenge questions (null for any you skip).');
    const attempt = await this.quiz.submit(userId, { topicId: String(c.topicId), startedAt: run.startedAt.toISOString(), answers: mineOnly });

    const now = new Date();
    c.set(side, {
      ...((run as ChallengeRun & { toObject?: () => ChallengeRun }).toObject?.() ?? run),
      submittedAt: now,
      score: attempt.score,
      correctCount: attempt.correctCount,
      timeMs: now.getTime() - run.startedAt.getTime(),
      attemptId: new Types.ObjectId(attempt.id),
    });
    const other: Side = side === 'challenger' ? 'opponent' : 'challenger';
    if (c[other].submittedAt) {
      c.status = 'completed';
      c.winner = challengeWinner(c);
      await c.save();
      await Promise.all(
        [c.challengerId, c.opponentId!].map(uid => this.notifications.notify(uid, 'challenge_result', null, String(c._id))),
      );
      this.analytics.track('challenge_completed', userId);
    } else {
      await c.save();
    }
    return this.present(c, userId);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async mine(userId: string, id: string) {
    const me = new Types.ObjectId(userId);
    const c = await this.challenges.findOne({ _id: id, $or: [{ challengerId: me }, { opponentId: me }] }).exec();
    if (!c) throw new NotFoundException(NOT_FOUND);
    return c;
  }

  private sideOf(c: ChallengeDocument, userId: string): Side {
    return String(c.challengerId) === userId ? 'challenger' : 'opponent';
  }

  /** Expire after 48 hours (a challenge nobody finished in time). */
  private async settle(c: ChallengeDocument) {
    if ((OPEN as readonly string[]).includes(c.status) && c.expiresAt <= new Date()) {
      c.status = 'expired';
      await c.save();
    }
    return c;
  }

  /**
   * What a participant sees. The other side's score and time stay hidden
   * until both have finished (only "they've finished" shows).
   */
  private async present(c: ChallengeDocument, userId: string) {
    const side = this.sideOf(c, userId);
    const other: Side = side === 'challenger' ? 'opponent' : 'challenger';
    const otherId = side === 'challenger' ? c.opponentId : c.challengerId;
    const otherUser = otherId
      ? await this.users.findById(otherId).select('username role studentProfile avatar').lean<Person>().exec()
      : null;
    const result = (r: ChallengeRun) =>
      r.submittedAt ? { score: r.score ?? 0, correctCount: r.correctCount ?? 0, total: c.questionIds.length, timeMs: r.timeMs ?? 0 } : null;
    const done = c.status === 'completed';
    return {
      id: String(c._id),
      code: c.code,
      role: side,
      status: c.status,
      viaLink: c.viaLink,
      topicId: String(c.topicId),
      topicTitle: c.topicTitle,
      courseTitle: c.courseTitle,
      questionCount: c.questionIds.length,
      expiresAt: c.expiresAt.toISOString(),
      createdAt: c.createdAt?.toISOString() ?? null,
      other: otherUser ? publicStudent(otherUser) : null,
      me: { started: !!c[side].startedAt, result: result(c[side]) },
      them: { finished: !!c[other].submittedAt, result: done ? result(c[other]) : null },
      outcome: done ? (c.winner === 'tie' ? 'tie' : c.winner === side ? 'won' : 'lost') : null,
    };
  }
}
