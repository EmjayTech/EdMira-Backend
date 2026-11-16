import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

export const CHALLENGE_STATUSES = ['pending', 'accepted', 'completed', 'declined', 'expired', 'cancelled'] as const;
export type ChallengeStatus = (typeof CHALLENGE_STATUSES)[number];

/** One side's run. Times come from the server, not the phone. */
@Schema({ _id: false })
export class ChallengeRun {
  @Prop() startedAt?: Date;
  @Prop() submittedAt?: Date;
  @Prop() score?: number;
  @Prop() correctCount?: number;
  @Prop() timeMs?: number;
  /** The quiz attempt it also counted as (progress + leaderboard). */
  @Prop({ type: mongoose.Schema.Types.ObjectId }) attemptId?: mongoose.Types.ObjectId;
}
const ChallengeRunSchema = SchemaFactory.createForClass(ChallengeRun);

/**
 * "Challenge a friend": both students answer the same snapshot of questions.
 * Sent to an accepted connection, or shared as a link (edmira.org/challenge/<code>)
 * that the first eligible opener claims — after connecting.
 */
@Schema({ collection: 'challenges', timestamps: true })
export class Challenge {
  /** Short code for the share link. */
  @Prop({ required: true, unique: true })
  code: string;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true })
  challengerId: mongoose.Types.ObjectId;

  /** Missing until someone claims a link challenge. */
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true })
  opponentId?: mongoose.Types.ObjectId;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Topic', required: true })
  topicId: mongoose.Types.ObjectId;

  @Prop({ required: true }) topicTitle: string;
  @Prop({ required: true }) courseTitle: string;

  /** The same questions, in the same order, for both students. */
  @Prop({ type: [mongoose.Schema.Types.ObjectId], required: true })
  questionIds: mongoose.Types.ObjectId[];

  @Prop({ type: String, enum: CHALLENGE_STATUSES, required: true, index: true })
  status: ChallengeStatus;

  @Prop({ default: false })
  viaLink: boolean;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ type: ChallengeRunSchema, default: () => ({}) }) challenger: ChallengeRun;
  @Prop({ type: ChallengeRunSchema, default: () => ({}) }) opponent: ChallengeRun;

  @Prop({ type: String, enum: ['challenger', 'opponent', 'tie'] })
  winner?: 'challenger' | 'opponent' | 'tie';

  createdAt?: Date;
}

export type ChallengeDocument = HydratedDocument<Challenge>;
export const ChallengeSchema = SchemaFactory.createForClass(Challenge);
ChallengeSchema.index({ challengerId: 1, createdAt: -1 });

/** Higher score wins; a tie goes to the faster time; same score and time = tie. */
export function challengeWinner(c: Pick<Challenge, 'challenger' | 'opponent'>): 'challenger' | 'opponent' | 'tie' {
  const [a, b] = [c.challenger, c.opponent];
  if ((a.score ?? 0) !== (b.score ?? 0)) return (a.score ?? 0) > (b.score ?? 0) ? 'challenger' : 'opponent';
  if ((a.timeMs ?? 0) !== (b.timeMs ?? 0)) return (a.timeMs ?? Infinity) < (b.timeMs ?? Infinity) ? 'challenger' : 'opponent';
  return 'tie';
}
