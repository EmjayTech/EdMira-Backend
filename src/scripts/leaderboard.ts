/**
 * yarn leaderboard rebuild [--week 2026-11-16]
 *
 * Recount a week's leaderboard from the quiz attempts (default: this week).
 * Run it once after the first deploy, and after changing the formula in
 * src/leaderboard/scoring.ts. Safe to run any number of times.
 * Uses MONGODB_URI (from .env, or the Render shell).
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { isWeekId, weekOf } from '../leaderboard/week';

async function main() {
  const [command] = process.argv.slice(2);
  const i = process.argv.indexOf('--week');
  const week = i > 0 ? process.argv[i + 1] : weekOf(new Date());
  if (command !== 'rebuild') throw new Error('Usage: yarn leaderboard rebuild [--week YYYY-MM-DD (a Monday)]');
  if (!isWeekId(week)) throw new Error(`"${week}" isn't a Monday (YYYY-MM-DD).`);

  process.env.NEWS_FETCH_EVERY_HOURS = '0'; // no background timers in a one-off run
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const { students } = await app.get(LeaderboardService).rebuildWeek(week);
    console.log(`Recounted the week of ${week} for ${students} student${students === 1 ? '' : 's'}.`);
  } finally {
    await app.close();
  }
}

main().catch(error => {
  console.error(error.message ?? error);
  process.exit(1);
});
