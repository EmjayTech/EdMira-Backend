/**
 * yarn pro — give a student EdMira Pro by hand, or take it away.
 *
 *   yarn pro ada@uni.edu 30                      # Pro for 30 days
 *   yarn pro ada@uni.edu 180 --note "UNILAG NiMSA deal"
 *   yarn pro ada@uni.edu off                     # end manual grants
 *   yarn pro ada@uni.edu                         # show their Pro status
 *
 * Google Play subscriptions are managed by Google and aren't touched.
 * Uses MONGODB_URI (from .env).
 */
import mongoose from 'mongoose';
import { userModel } from '../users/model/user.model';
import {
  ENTITLED_STATES,
  SubscriptionSchema,
  SubscriptionSource,
  SubscriptionState,
} from '../subscription/subscription.schema';

const DAY_MS = 24 * 60 * 60 * 1000;

async function main() {
  const [rawEmail, action] = process.argv.slice(2);
  const noteAt = process.argv.indexOf('--note');
  const note = noteAt >= 0 ? process.argv[noteAt + 1] : undefined;
  const email = rawEmail?.trim().toLowerCase();
  const days = Number(action);
  if (!email || (action && action !== 'off' && !(Number.isInteger(days) && days > 0 && days <= 3660))) {
    throw new Error('Usage: yarn pro <email> [<days>|off] [--note "why"]');
  }
  if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI (e.g. in .env).');

  await mongoose.connect(process.env.MONGODB_URI);
  const User = mongoose.model('User', userModel);
  const Subscription = mongoose.model('Subscription', SubscriptionSchema);
  const user = await User.findOne({ email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
  if (!user) throw new Error(`No account for ${email}.`);

  if (action === 'off') {
    const res = await Subscription.updateMany(
      { userId: user._id, source: SubscriptionSource.GRANT, expiresAt: { $gt: new Date() } },
      { state: SubscriptionState.EXPIRED, expiresAt: new Date() },
    );
    console.log(`${user.get('email')}: ended ${res.modifiedCount} manual grant(s).`);
  } else if (action) {
    const expiresAt = new Date(Date.now() + days * DAY_MS);
    await Subscription.create({
      userId: user._id,
      source: SubscriptionSource.GRANT,
      state: SubscriptionState.ACTIVE,
      expiresAt,
      note,
    });
    console.log(`${user.get('email')} → Pro until ${expiresAt.toISOString().slice(0, 10)}${note ? ` (${note})` : ''}`);
  }

  const active = await Subscription.find({
    userId: user._id,
    state: { $in: ENTITLED_STATES },
    expiresAt: { $gt: new Date() },
  }).sort({ expiresAt: -1 });
  console.log(
    active.length
      ? `Pro until ${active[0].get('expiresAt').toISOString().slice(0, 10)} via ${active.map(s => s.get('source')).join(', ')}`
      : 'Free plan (no active Pro).',
  );
  await mongoose.disconnect();
}

main().catch(async error => {
  console.error(error.message);
  await mongoose.disconnect();
  process.exit(1);
});
