import { ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AnalyticsService } from '../analytics/analytics.service';
import { User, UserDocument } from '../users/model/user.model';
import { NotificationsService } from './notifications.service';
import { Person, PeopleService, privacyOf, publicStudent } from './people.service';
import { SafetyService } from './safety.service';
import { Block, BlockDocument } from './schemas/block.schema';
import { Connection, ConnectionDocument } from './schemas/connection.schema';
import { UserReport, UserReportDocument } from './schemas/user-report.schema';
import { Challenge, ChallengeDocument } from './schemas/challenge.schema';
import { ConnectionAction, REQUESTS, ReportCategory, RequestNote, isLive, pairKey, transition } from './social-policy';

/** The reply to anything a student asks for here — it never says whether the other account exists. */
const OK = { ok: true } as const;
const DUPLICATE_KEY = 11000;

/**
 * Connection requests, connections, blocks and reports. Every action is
 * authorised here: you can only touch requests and connections you're part of,
 * and only in the ways social-policy.ts allows.
 */
@Injectable()
export class ConnectionsService {
  constructor(
    @InjectModel(Connection.name) private readonly connections: Model<ConnectionDocument>,
    @InjectModel(Block.name) private readonly blocks: Model<BlockDocument>,
    @InjectModel(UserReport.name) private readonly reports: Model<UserReportDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Challenge.name) private readonly challenges: Model<ChallengeDocument>,
    private readonly people: PeopleService,
    private readonly safety: SafetyService,
    private readonly notifications: NotificationsService,
    private readonly analytics: AnalyticsService,
  ) {}

  // ── Sending ────────────────────────────────────────────────────────────────

  async request(userId: string, username: string, note?: RequestNote) {
    const me = await this.people.me(userId);
    if (me.role) return OK; // staff don't connect
    await this.assertMaySend(me);

    const target = await this.people.visible(me, username);
    if (!target || target.role) return OK; // doesn't exist, hidden, blocked, staff: same answer
    if (await this.people.liveConnection(me._id, target._id)) return OK; // already requested / connected

    // Visible, but won't receive it: a "shadow" request only the sender sees.
    const shadow = !(await this.accepts(target, me));
    const now = new Date();
    try {
      await this.connections.create({
        requesterId: me._id,
        recipientId: target._id,
        pairKey: pairKey(String(me._id), String(target._id)),
        livePair: pairKey(String(me._id), String(target._id)),
        status: 'pending',
        note,
        shadow,
        expiresAt: new Date(now.getTime() + REQUESTS.expireAfterMs),
      });
    } catch (error) {
      if (error?.code === DUPLICATE_KEY) return OK; // both tapped at once
      throw error;
    }
    if (!shadow && !privacyOf(target).muteRequestNotifications) {
      await this.notifications.notify(target._id, 'connection_request', me._id);
    }
    await this.safety.log('connection_request_sent', me._id, target._id, shadow ? { silent: true } : undefined);
    this.analytics.track('connection_request_sent', me._id);
    return OK;
  }

  /**
   * A request created by an invite or challenge link: the sender agreed by
   * sharing the link, the recipient by opening it — they still have to
   * accept. Skips the sender's daily limits (they didn't send it by hand) but
   * never a block, a paused (flagged) sender, or an existing connection.
   * Returns false when nothing was created.
   */
  async requestFromLink(senderId: Types.ObjectId | string, recipientId: Types.ObjectId | string) {
    const [sender, recipient] = await Promise.all([this.people.me(String(senderId)), this.people.me(String(recipientId))]);
    if (sender.role || recipient.role || !this.people.isActive(sender)) return false;
    const full = await this.users.findById(sender._id).select('requestsPausedUntil').lean().exec();
    if (full?.requestsPausedUntil && full.requestsPausedUntil > new Date()) return false;
    if (await this.people.isBlockedBetween(sender._id, recipient._id)) return false;
    if (await this.people.liveConnection(sender._id, recipient._id)) return false;
    try {
      await this.connections.create({
        requesterId: sender._id,
        recipientId: recipient._id,
        pairKey: pairKey(String(sender._id), String(recipient._id)),
        livePair: pairKey(String(sender._id), String(recipient._id)),
        status: 'pending',
        note: 'classmates',
        shadow: false,
        expiresAt: new Date(Date.now() + REQUESTS.expireAfterMs),
      });
    } catch (error) {
      if (error?.code === DUPLICATE_KEY) return false;
      throw error;
    }
    if (!privacyOf(recipient).muteRequestNotifications) await this.notifications.notify(recipient._id, 'connection_request', sender._id);
    await this.safety.log('connection_request_sent', sender._id, recipient._id, { viaLink: true });
    return true;
  }

  /** Removing or blocking ends any open challenge between the two. */
  private async cancelChallengesBetween(a: Types.ObjectId | string, b: Types.ObjectId | string) {
    const [x, y] = [new Types.ObjectId(String(a)), new Types.ObjectId(String(b))];
    await this.challenges
      .updateMany(
        {
          status: { $in: ['pending', 'accepted'] },
          $or: [
            { challengerId: x, opponentId: y },
            { challengerId: y, opponentId: x },
          ],
        },
        { $set: { status: 'cancelled' } },
      )
      .exec();
  }

  /** Paused (flagged), too many today, or too many waiting. */
  private async assertMaySend(me: Person) {
    const full = await this.users.findById(me._id).select('requestsPausedUntil').lean().exec();
    if (full?.requestsPausedUntil && full.requestsPausedUntil > new Date()) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'REQUESTS_PAUSED',
        message: "You can't send connection requests right now. Our team is reviewing your account.",
      });
    }
    const isNew = !!me.createdAt && Date.now() - new Date(me.createdAt).getTime() < REQUESTS.newAccountMs;
    const perDay = isNew ? REQUESTS.perDayNewAccount : REQUESTS.perDay;
    const [today, waiting] = await Promise.all([
      this.connections.countDocuments({ requesterId: me._id, createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }),
      this.connections.countDocuments({ requesterId: me._id, status: 'pending', expiresAt: { $gt: new Date() } }),
    ]);
    if (today >= perDay || waiting >= REQUESTS.maxPendingOutgoing) {
      await this.safety.log('request_rate_limited', me._id, null, { today, waiting });
      await this.safety.evaluate(me._id);
      throw new HttpException(
        {
          statusCode: 429,
          code: 'REQUEST_LIMIT',
          message:
            waiting >= REQUESTS.maxPendingOutgoing
              ? 'You have a lot of requests waiting. Wait for some answers (or cancel a few) first.'
              : `You've sent ${perDay} requests today. Try again tomorrow.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Whether `target` takes requests from `from`: their setting, and no recent decline of this sender. */
  private async accepts(target: Person, from: Person) {
    const { requestsFrom } = privacyOf(target);
    if (requestsFrom === 'nobody') return false;
    if (requestsFrom === 'school' && (!from.studentProfile?.institution || from.studentProfile.institution !== target.studentProfile?.institution)) {
      return false;
    }
    const declinedRecently = await this.connections.exists({
      requesterId: from._id,
      recipientId: target._id,
      status: 'declined',
      respondedAt: { $gt: new Date(Date.now() - REQUESTS.declineCooldownMs) },
    });
    return !declinedRecently;
  }

  // ── Answering, cancelling, removing ────────────────────────────────────────

  /**
   * accept / decline (recipient), cancel (requester), remove (either).
   * 404 unless you're part of it (and a recipient never sees a shadow request).
   */
  async act(userId: string, connectionId: string, action: ConnectionAction) {
    const me = new Types.ObjectId(userId);
    const row = await this.connections
      .findOne({ _id: connectionId, $or: [{ requesterId: me }, { recipientId: me, shadow: false }] })
      .exec();
    if (!row) throw new NotFoundException({ statusCode: 404, message: 'Not found' });
    this.expireIfDue(row);

    const role = String(row.requesterId) === userId ? 'requester' : 'recipient';
    const next = transition(row.status, action, role);
    if (!next) {
      if (row.isModified()) await row.save();
      throw new ConflictException({ statusCode: 409, code: 'NOT_OPEN', message: 'This request is no longer open.' });
    }
    const now = new Date();
    row.status = next;
    if (!isLive(next)) row.livePair = undefined;
    if (action === 'accept' || action === 'decline') row.respondedAt = now;
    else row.endedAt = now;
    await row.save();

    const other = role === 'requester' ? row.recipientId : row.requesterId;
    if (action === 'accept') {
      await this.notifications.notify(row.requesterId, 'connection_accepted', me);
      await this.safety.log('connection_request_accepted', me, other);
      this.analytics.track('connection_request_accepted', me);
    } else if (action === 'decline') {
      // Silent: the sender is never told. It counts towards their decline rate.
      await this.safety.log('connection_request_declined', me, other);
      await this.safety.evaluate(other);
    } else if (action === 'remove') {
      await this.cancelChallengesBetween(me, other);
      await this.safety.log('connection_removed', me, other);
    }
    return { id: String(row._id), status: next };
  }

  private expireIfDue(row: ConnectionDocument) {
    if (row.status === 'pending' && row.expiresAt <= new Date()) {
      row.status = 'expired';
      row.livePair = undefined;
      row.endedAt = row.expiresAt;
    }
  }

  // ── Lists ──────────────────────────────────────────────────────────────────

  /** Accepted connections, newest first (suspended / banned students left out). */
  async list(userId: string) {
    const me = new Types.ObjectId(userId);
    const rows = await this.connections
      .find({ status: 'accepted', $or: [{ requesterId: me }, { recipientId: me }] })
      .sort({ respondedAt: -1 })
      .lean()
      .exec();
    return this.present(userId, rows, r => ({ id: String(r._id), since: r.respondedAt?.toISOString() ?? null }));
  }

  /** Requests waiting for me (incoming) and the ones I sent (outgoing, including silent ones). */
  async requests(userId: string) {
    const me = new Types.ObjectId(userId);
    await this.connections
      .updateMany(
        { status: 'pending', expiresAt: { $lte: new Date() }, $or: [{ requesterId: me }, { recipientId: me }] },
        { $set: { status: 'expired' }, $unset: { livePair: '' } },
      )
      .exec();
    const [incoming, outgoing] = await Promise.all([
      this.connections.find({ recipientId: me, status: 'pending', shadow: false }).sort({ createdAt: -1 }).lean().exec(),
      this.connections.find({ requesterId: me, status: 'pending' }).sort({ createdAt: -1 }).lean().exec(),
    ]);
    const shape = (r: Connection & { _id: Types.ObjectId }) => ({
      id: String(r._id),
      note: r.note ?? null,
      sentAt: r.createdAt?.toISOString() ?? null,
      expiresAt: r.expiresAt.toISOString(),
    });
    return {
      incoming: await this.present(userId, incoming, shape),
      outgoing: await this.present(userId, outgoing, shape),
    };
  }

  /** Attach the other student's public details; drop anyone no longer visible. */
  private async present<T extends Connection & { _id: Types.ObjectId }, X>(userId: string, rows: T[], extra: (r: T) => X) {
    const otherOf = (r: T) => (String(r.requesterId) === userId ? r.recipientId : r.requesterId);
    const others = await this.users
      .find({ _id: { $in: rows.map(otherOf) } })
      .select('username role status isVerified studentProfile suspendedUntil')
      .lean<Person[]>()
      .exec();
    const byId = new Map(others.map(o => [String(o._id), o]));
    return rows.flatMap(r => {
      const other = byId.get(String(otherOf(r)));
      return other && this.people.isActive(other) ? [{ ...publicStudent(other), ...extra(r) }] : [];
    });
  }

  /** Counts for badges: requests waiting for me, unread notifications. */
  async summary(userId: string) {
    const me = new Types.ObjectId(userId);
    const [incomingRequests, unreadNotifications] = await Promise.all([
      this.connections.countDocuments({ recipientId: me, status: 'pending', shadow: false, expiresAt: { $gt: new Date() } }),
      this.notifications.unreadCount(userId),
    ]);
    return { incomingRequests, unreadNotifications };
  }

  // ── Block & report ─────────────────────────────────────────────────────────

  /**
   * Block, instantly and silently: ends requests and the connection both
   * ways, clears notifications between you, and hides you from each other.
   */
  async block(userId: string, username: string) {
    const me = new Types.ObjectId(userId);
    const target = await this.people.byUsername(username);
    if (!target || String(target._id) === userId) return OK;
    await this.blocks.updateOne({ blockerId: me, blockedId: target._id }, { $setOnInsert: { blockerId: me, blockedId: target._id } }, { upsert: true });
    await this.connections
      .updateMany(
        { pairKey: pairKey(userId, String(target._id)), status: { $in: ['pending', 'accepted'] } },
        { $set: { status: 'blocked', endedAt: new Date() }, $unset: { livePair: '' } },
      )
      .exec();
    await this.notifications.forgetPair(me, target._id);
    await this.cancelChallengesBetween(me, target._id);
    await this.safety.log('user_blocked', me, target._id);
    this.analytics.track('user_blocked', me);
    return OK;
  }

  async unblock(userId: string, username: string) {
    const target = await this.people.byUsername(username);
    if (!target) return OK;
    const res = await this.blocks.deleteOne({ blockerId: new Types.ObjectId(userId), blockedId: target._id }).exec();
    if (res.deletedCount) await this.safety.log('user_unblocked', userId, target._id);
    return OK;
  }

  /** Students I blocked (Profile → Privacy → Blocked students). */
  async blocked(userId: string) {
    const rows = await this.blocks.find({ blockerId: new Types.ObjectId(userId) }).sort({ createdAt: -1 }).lean().exec();
    const users = await this.users.find({ _id: { $in: rows.map(r => r.blockedId) } }).select('username').lean().exec();
    const names = new Map(users.map(u => [String(u._id), u.username]));
    return rows.flatMap(r => {
      const username = names.get(String(r.blockedId));
      return username ? [{ username, blockedAt: r.createdAt?.toISOString() ?? null }] : [];
    });
  }

  /** Report a student (optionally blocking them too). Goes to the admin moderation queue. */
  async report(userId: string, username: string, category: ReportCategory, note?: string, alsoBlock?: boolean) {
    const me = await this.people.me(userId);
    const target = await this.people.byUsername(username);
    if (!target || String(target._id) === userId) return OK;

    const recent = await this.connections
      .find({ pairKey: pairKey(userId, String(target._id)) })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean()
      .exec();
    await this.reports.create({
      reporterId: me._id,
      reportedId: target._id,
      category,
      note: note?.trim() || undefined,
      evidence: {
        reporterUsername: me.username,
        reportedUsername: target.username,
        recentRequests: recent.map(r => ({
          from: String(r.requesterId) === userId ? me.username : target.username,
          status: r.status,
          note: r.note ?? null,
          at: r.createdAt?.toISOString(),
        })),
      },
    });
    await this.safety.log('user_reported', me._id, target._id, { category });
    this.analytics.track('user_reported', me._id);
    if (alsoBlock) await this.block(userId, target.username);
    await this.safety.evaluate(target._id);
    return OK;
  }
}
