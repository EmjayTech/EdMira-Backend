/**
 * yarn content:load — import the content library (or any import files) into
 * the database in MONGODB_URI.
 *
 *   yarn content:load                         # every file in content-library/import/
 *   yarn content:load content-library/import/200-ana-limbs.json
 *   yarn content:load --dry-run               # check only, save nothing
 *
 * Files use the dashboard's import format: { "courses": [ … ] } (see
 * content-library/README.md). Topics and questions land IN REVIEW, credited
 * to the "EdMira content library", so an admin/reviewer approves them in the
 * dashboard before students see anything. Safe to run again: existing
 * courses/topics are matched by title and repeated questions are skipped.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import mongoose from 'mongoose';
import { join, resolve } from 'path';
import { LIBRARY_AUTHOR_NAME, importContent } from '../admin/content-import';
import { ImportDto } from '../admin/dto/import.dto';
import { CourseSchema } from '../content/schemas/course.schema';
import { QuestionSchema } from '../content/schemas/question.schema';
import { ResourceSchema } from '../content/schemas/resource.schema';
import { TopicSchema } from '../content/schemas/topic.schema';

const LIBRARY_DIR = resolve(__dirname, '../../content-library/import');

function files(args: string[]): string[] {
  const targets = args.length ? args.map(a => resolve(a)) : [LIBRARY_DIR];
  return targets.flatMap(target => {
    if (!existsSync(target)) throw new Error(`Not found: ${target}`);
    return statSync(target).isDirectory()
      ? readdirSync(target)
          .filter(f => f.endsWith('.json'))
          .sort()
          .map(f => join(target, f))
      : [target];
  });
}

const flatten = (errors: Awaited<ReturnType<typeof validate>>, path = ''): string[] =>
  errors.flatMap(e => [
    ...Object.values(e.constraints ?? {}).map(m => `${path}${e.property}: ${m}`),
    ...flatten(e.children ?? [], `${path}${e.property}.`),
  ]);

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const paths = files(argv.filter(a => !a.startsWith('--')));
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Set MONGODB_URI (e.g. in .env) before loading content.');

  await mongoose.connect(uri);
  const models = {
    courses: mongoose.model('Course', CourseSchema),
    topics: mongoose.model('Topic', TopicSchema),
    questions: mongoose.model('Question', QuestionSchema),
    resources: mongoose.model('Resource', ResourceSchema),
  } as any;

  const total = { courses: 0, topics: 0, questions: 0, videos: 0, duplicates: 0, failedFiles: 0 };
  for (const path of paths) {
    const name = path.replace(`${LIBRARY_DIR}/`, '');
    const dto = plainToInstance(ImportDto, JSON.parse(readFileSync(path, 'utf8')));
    const shapeErrors = flatten(await validate(dto, { whitelist: true, forbidNonWhitelisted: true }));
    if (shapeErrors.length) {
      total.failedFiles++;
      console.error(`✗ ${name}\n  ${shapeErrors.slice(0, 10).join('\n  ')}`);
      continue;
    }
    const result = await importContent(models, dto.courses, { name: LIBRARY_AUTHOR_NAME }, {
      dryRun,
      publishNewCourses: true,
    });
    if (result.errors.length) {
      total.failedFiles++;
      console.error(`✗ ${name}\n  ${result.errors.slice(0, 10).map(e => `${e.where}: ${e.message}`).join('\n  ')}`);
      continue;
    }
    total.courses += result.courses.created;
    total.topics += result.topics.created;
    total.questions += result.questions.created;
    total.duplicates += result.questions.duplicates;
    total.videos += result.videos.created;
    console.log(
      `✓ ${name}: ${result.topics.created} topics, ${result.questions.created} questions, ${result.videos.created} videos` +
        (result.questions.duplicates ? ` (${result.questions.duplicates} already there)` : ''),
    );
  }
  await mongoose.disconnect();

  console.log(
    `\n${dryRun ? 'Dry run — nothing saved. Would add' : 'Added'} ${total.courses} courses, ${total.topics} topics, ` +
      `${total.questions} questions, ${total.videos} videos${total.duplicates ? `; skipped ${total.duplicates} repeats` : ''}.` +
      (total.failedFiles ? `\n${total.failedFiles} file(s) had problems (above) and were skipped.` : '') +
      (dryRun ? '' : '\nApprove them in the dashboard’s Review queue.'),
  );
  if (total.failedFiles) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message ?? error);
  process.exit(1);
});
