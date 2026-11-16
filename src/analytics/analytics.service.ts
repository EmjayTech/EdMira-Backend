import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AnalyticsEvent, AnalyticsEventDocument } from './analytics-event.schema';

/** Events the apps may report (POST /analytics/events). */
export const CLIENT_EVENTS = ['leaderboard_viewed', 'progress_card_shared', 'invite_link_shared'] as const;
export type ClientEventName = (typeof CLIENT_EVENTS)[number];

/** The events we measure (see the username-features spec). Add new ones here. */
export type AnalyticsEventName =
  | 'login_with_username'
  | 'user_search'
  | 'connection_request_sent'
  | 'connection_request_accepted'
  | 'user_blocked'
  | 'user_reported'
  | 'referral_signup'
  | 'challenge_sent'
  | 'challenge_completed'
  | ClientEventName;

/**
 * Product analytics stored in our own database (no third-party service).
 * `track` never throws and never slows the request down.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(@InjectModel(AnalyticsEvent.name) private readonly events: Model<AnalyticsEventDocument>) {}

  track(name: AnalyticsEventName, userId?: string | Types.ObjectId, props?: AnalyticsEvent['props']) {
    this.events
      .create({ name, userId: userId ? new Types.ObjectId(String(userId)) : undefined, props })
      .catch(error => this.logger.warn(`Couldn't record ${name}: ${error?.message ?? error}`));
  }

  /** Count of each event since `since` (admin dashboard, later phases). */
  counts(since: Date) {
    return this.events.aggregate<{ _id: string; count: number }>([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$name', count: { $sum: 1 } } },
    ]);
  }
}
