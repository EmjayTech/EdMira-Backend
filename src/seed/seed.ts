/**
 * yarn seed — load sample content into the database in MONGODB_URI.
 *
 * Refuses to run when NODE_ENV=production (the content is unreviewed).
 */
import mongoose from 'mongoose';
import { seedSampleContent } from './seed-sample-content';

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed unreviewed sample content into production.');
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Set MONGODB_URI (e.g. in .env) before seeding.');

  await mongoose.connect(uri);
  const result = await seedSampleContent(mongoose.connection);
  console.log(
    result.skipped
      ? 'Database already has courses — nothing seeded.'
      : `Seeded ${result.courses} courses, ${result.topics} topics, ${result.questions} questions, ${result.news} news stories.`,
  );
  await mongoose.disconnect();
}

main().catch(error => {
  console.error(error.message ?? error);
  process.exit(1);
});
