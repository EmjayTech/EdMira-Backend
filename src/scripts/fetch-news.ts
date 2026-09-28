/**
 * yarn news:fetch — check every enabled news source once and save new stories
 * (drafts, or published for auto-publish sources). For a scheduled job such
 * as a Render Cron Job when the web service sleeps between requests:
 *
 *   yarn news:fetch            (needs MONGODB_URI and ANTHROPIC_API_KEY)
 *   node dist/scripts/fetch-news.js   (after `yarn build`)
 */
import { NestFactory } from '@nestjs/core';
import { AiNewsService } from '../admin/ai-news.service';
import { AppModule } from '../app.module';

async function main() {
  process.env.NEWS_FETCH_EVERY_HOURS = '0'; // no background timer in a one-off run
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const report = await app.get(AiNewsService).run();
    const { max, windowHours, used, nextSlotAt } = report.limit;
    if (report.limitReached) {
      console.log(
        `Limit reached: ${used} of ${max} stories in the last ${windowHours}h. Nothing fetched.` +
          (nextSlotAt ? ` Next slot opens ${new Date(nextSlotAt).toUTCString()}.` : ''),
      );
      return;
    }
    console.log(
      `Checked ${report.sourcesChecked} sources: ${report.added} new stor${report.added === 1 ? 'y' : 'ies'}` +
        ` (${report.published} published, ${report.added - report.published} waiting as drafts), ${report.skipped} skipped.` +
        ` ${used} of ${max} stories used in the last ${windowHours}h.`,
    );
    for (const e of report.errors) console.warn(`  ${e.source}: ${e.message}`);
  } finally {
    await app.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
