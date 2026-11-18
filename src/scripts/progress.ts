/**
 * yarn progress <command>
 *
 *   rebuild [--yes]   Recount study days, streaks, points and weekly leaderboards
 *                     from every quiz attempt and QOTD answer. Run ONCE after
 *                     deploying Part A (and after changing points-config.ts).
 *                     Without --yes it only reports what it would do.
 *   repair            Score attempts that missed scoring (the nightly job does
 *                     this for the last 7 days; this does all of them).
 *   nightly           Run the nightly safety net now.
 *   referrals [--yes] Give inviters their +10 for referrals from before
 *                     referral rewards existed, where the invited student
 *                     already completed a quiz (lifetime points only, not this
 *                     week's leaderboard). Run ONCE after deploying, after
 *                     `rebuild`. Without --yes it only reports.
 *
 * Uses MONGODB_URI (from .env, or the Render shell). Safe to re-run.
 */
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { AppModule } from '../app.module';
import { StudyJobsService } from '../study/study-jobs.service';
import { StudyService } from '../study/study.service';
import { ReferralsService } from '../social/referrals.service';

async function main() {
  const [command] = process.argv.slice(2);
  if (!['rebuild', 'repair', 'nightly', 'referrals'].includes(command)) {
    throw new Error('Usage: yarn progress rebuild [--yes] | repair | nightly | referrals [--yes]');
  }
  // No background timers in a one-off run.
  process.env.NEWS_FETCH_EVERY_HOURS = '0';
  process.env.STUDY_JOBS = 'off';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const study = app.get(StudyService);
    if (command === 'rebuild') {
      const db = app.get<Connection>(getConnectionToken());
      const attempts = await db.collection('quizattempts').countDocuments();
      const students = (await db.collection('quizattempts').distinct('studentId')).length;
      const answers = await db.collection('qotd_answers').countDocuments();
      const hello = await db.db.admin().command({ hello: 1 });
      console.log(`Database: ${hello.setName ? `replica set "${hello.setName}" (transactions on)` : 'standalone (no transactions)'}`);
      console.log(`Would recount ${attempts} quiz attempts from ${students} students and ${answers} QOTD answers.`);
      if (!process.argv.includes('--yes')) {
        console.log('Nothing changed. Run again with --yes to rebuild (takes a minute or two; run at a quiet time).');
        return;
      }
      const result = await study.rebuildAll(line => console.log(line));
      console.log(`Done: ${JSON.stringify(result)}`);
    } else if (command === 'referrals') {
      const db = app.get<Connection>(getConnectionToken());
      const waiting = await db.collection('users').countDocuments({ referredBy: { $exists: true }, referral: { $exists: false } });
      console.log(`${waiting} referrals from before referral rewards.`);
      if (!process.argv.includes('--yes')) {
        console.log('Nothing changed. Run again with --yes to give the rewards.');
        return;
      }
      console.log(`Done: ${JSON.stringify(await app.get(ReferralsService).backfill(line => console.log(line)))}`);
    } else if (command === 'repair') {
      console.log(JSON.stringify(await study.scoreUnscored()));
    } else {
      console.log(JSON.stringify(await app.get(StudyJobsService).nightly()));
    }
  } finally {
    await app.close();
  }
}

main().catch(error => {
  console.error(error.message ?? error);
  process.exit(1);
});
