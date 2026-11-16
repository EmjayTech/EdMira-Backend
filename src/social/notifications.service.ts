import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User, UserDocument } from '../users/model/user.model';
import { Notification, NotificationDocument, NotificationType } from './schemas/notification.schema';

const INBOX_LIMIT = 50;

/** The in-app inbox. Items show the other student by username only. */
@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel(Notification.name) private readonly notifications: Model<NotificationDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  async notify(userId: Types.ObjectId | string, type: NotificationType, fromId?: Types.ObjectId | string | null, refId?: string) {
    await this.notifications.create({
      userId: new Types.ObjectId(String(userId)),
      type,
      fromId: fromId ? new Types.ObjectId(String(fromId)) : undefined,
      refId,
    });
  }

  /** Remove everything between two students (used when one blocks the other). */
  async forgetPair(a: Types.ObjectId | string, b: Types.ObjectId | string) {
    const [x, y] = [new Types.ObjectId(String(a)), new Types.ObjectId(String(b))];
    await this.notifications.deleteMany({ $or: [{ userId: x, fromId: y }, { userId: y, fromId: x }] });
  }

  async inbox(userId: string) {
    const rows = await this.notifications
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(INBOX_LIMIT)
      .lean()
      .exec();
    const senders = await this.users
      .find({ _id: { $in: rows.map(r => r.fromId).filter(Boolean) } })
      .select('username')
      .lean()
      .exec();
    const names = new Map(senders.map(s => [String(s._id), s.username]));
    return rows.map(r => ({
      id: String(r._id),
      type: r.type,
      username: r.fromId ? names.get(String(r.fromId)) ?? null : null,
      refId: r.refId ?? null,
      createdAt: r.createdAt?.toISOString(),
      read: !!r.readAt,
    }));
  }

  unreadCount(userId: string) {
    return this.notifications.countDocuments({ userId: new Types.ObjectId(userId), readAt: { $exists: false } }).exec();
  }

  async markAllRead(userId: string) {
    await this.notifications
      .updateMany({ userId: new Types.ObjectId(userId), readAt: { $exists: false } }, { $set: { readAt: new Date() } })
      .exec();
  }
}
