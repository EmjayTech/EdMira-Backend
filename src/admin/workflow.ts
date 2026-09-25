import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ContentStatus } from '../common/enum/content-status.enum';
import { can } from './permissions';
import type { Staff } from './staff.guard';

/**
 * The content review workflow — a server-side port of
 * EdMira-Admin/src/data/workflow.ts (keep the two in sync):
 *
 *   draft ──submit──► in_review ──approve──► published
 *     ▲                   │
 *     └─request_changes───┤
 *                         └──reject──► archived ──restore──► draft
 *   published / draft ──archive──► archived
 *
 * - Only reviewers/admins approve, and never their own work.
 * - Nothing reaches `published` without an approval.
 * - Editing published content sends it back to `in_review`.
 * - Content under review is locked for editing.
 */

export const REVIEW_ACTIONS = ['submit', 'approve', 'request_changes', 'reject', 'archive', 'restore'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

const { DRAFT, IN_REVIEW, PUBLISHED, ARCHIVED } = ContentStatus;

const TRANSITIONS: Record<ReviewAction, { from: ContentStatus[]; to: ContentStatus }> = {
  submit: { from: [DRAFT], to: IN_REVIEW },
  approve: { from: [IN_REVIEW], to: PUBLISHED },
  request_changes: { from: [IN_REVIEW], to: DRAFT },
  reject: { from: [IN_REVIEW], to: ARCHIVED },
  archive: { from: [DRAFT, PUBLISHED], to: ARCHIVED },
  restore: { from: [ARCHIVED], to: DRAFT },
};

const human = (text: string) => text.replace('_', ' ');

/** Throws the right HTTP error if `staff` can't take `action` on `item`. */
export function assertCanTransition(
  staff: Staff,
  item: { status: ContentStatus; createdById?: unknown },
  action: ReviewAction,
) {
  if (!TRANSITIONS[action].from.includes(item.status)) {
    throw new ConflictException(`Can't ${human(action)} content that is ${human(item.status)}.`);
  }
  switch (action) {
    case 'submit':
      if (!can(staff.role, 'submitForReview')) {
        throw new ForbiddenException('Only creators and admins can submit for review.');
      }
      return;
    case 'approve':
    case 'request_changes':
    case 'reject':
      if (!can(staff.role, 'review')) {
        throw new ForbiddenException('Only medical reviewers and admins can review content.');
      }
      if (item.createdById && String(item.createdById) === staff.id) {
        throw new ForbiddenException("You can't review your own content — another reviewer must check it.");
      }
      return;
    case 'archive':
    case 'restore':
      if (!can(staff.role, 'manageLifecycle')) {
        throw new ForbiddenException('Only admins can archive or restore content.');
      }
  }
}

export const nextStatus = (action: ReviewAction) => TRANSITIONS[action].to;

/** A note is required whenever content is sent back or rejected. */
export const needsNote = (action: ReviewAction) => action === 'request_changes' || action === 'reject';

/** Status after an edit is saved; throws if the item can't be edited right now. */
export function statusAfterEdit(current: ContentStatus): ContentStatus {
  if (current === DRAFT) return DRAFT;
  if (current === PUBLISHED) return IN_REVIEW;
  if (current === IN_REVIEW) {
    throw new ConflictException(
      'This item is being reviewed. Wait for the review, or ask the reviewer to send it back.',
    );
  }
  throw new ConflictException('Archived content must be restored before it can be edited.');
}

// ── Validation (same messages as the dashboard) ──────────────────────────────

export interface TopicFields {
  courseId: string;
  title: string;
  order: number;
  summary: string;
  material: { heading: string; body: string; keyPoints?: string[] }[];
}

export interface QuestionFields {
  topicId: string;
  stem: string;
  options: string[];
  answerIndex: number;
}

export function validateTopic(input: TopicFields) {
  const errors: string[] = [];
  if (!input.courseId) errors.push('Choose a course.');
  if (!input.title?.trim()) errors.push('Give the topic a title.');
  if (!input.summary?.trim()) errors.push('Write a short summary.');
  if (!Number.isInteger(input.order) || input.order < 1) errors.push('Order must be 1 or more.');
  if (!input.material?.length) errors.push('Add at least one study section.');
  if (input.material?.some(s => !s.heading?.trim() || !s.body?.trim())) {
    errors.push('Every study section needs a heading and body text.');
  }
  if (errors.length) throw new BadRequestException(errors.join(' '));
}

export function validateQuestion(input: QuestionFields) {
  const errors: string[] = [];
  if (!input.topicId) errors.push('Choose a topic.');
  if (!input.stem?.trim()) errors.push('Write the question.');
  const options = (input.options ?? []).map(o => o.trim());
  if (options.length < 2) errors.push('Add at least two options.');
  if (options.length > 6) errors.push('Use at most six options.');
  if (options.some(o => !o)) errors.push('Fill in every option or remove the empty ones.');
  const lowered = options.filter(Boolean).map(o => o.toLowerCase());
  if (new Set(lowered).size !== lowered.length) errors.push('Two options are the same.');
  if (!Number.isInteger(input.answerIndex) || input.answerIndex < 0 || input.answerIndex >= options.length) {
    errors.push('Mark the correct answer.');
  }
  if (errors.length) throw new BadRequestException(errors.join(' '));
}

/** Rough reading time, matching the dashboard and the mobile app. */
export function estimateReadMinutes(material: TopicFields['material']) {
  const words = material
    .map(s => `${s.heading} ${s.body} ${(s.keyPoints ?? []).join(' ')}`)
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}
