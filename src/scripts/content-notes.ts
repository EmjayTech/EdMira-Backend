/**
 * yarn content:notes <subject-folder> [--yes]
 *
 *   yarn content:notes ../"Desktop/EdMira Mobile1.0/EdMira-MobileApp/content-import/physiology"
 *
 * Imports a subject's original study notes and MCQs (see content-import/README.md)
 * as DRAFT versions into the admin Review queue. Without --yes it only checks
 * the files and reports what it would do. Live notes never change until a
 * reviewer approves the new version. Safe to re-run: unchanged topics add
 * nothing, and a version still waiting for review is replaced.
 *
 * Reads <folder>/*.md, <folder>/*.mcq.json, <folder>/figures/*, and
 * <folder>/../curriculum/<subject>_outline.json. Uses MONGODB_URI.
 */
import { NestFactory } from '@nestjs/core';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { AppModule } from '../app.module';
import { LIBRARY_AUTHOR_NAME } from '../admin/content-import';
import type { Outline } from '../content/notes-format';
import { ContentBundle, ImportReport, TopicVersionsService } from '../content/topic-versions.service';

export function readBundle(folder: string): ContentBundle {
  const dir = resolve(folder);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Not a folder: ${dir}`);
  const subject = basename(dir);
  const outlinePath = join(dirname(dir), 'curriculum', `${subject}_outline.json`);
  if (!existsSync(outlinePath)) throw new Error(`No outline at ${outlinePath}`);
  const outline = JSON.parse(readFileSync(outlinePath, 'utf8')) as Outline;

  const topics = readdirSync(dir)
    .filter(f => f.endsWith('.md') && !/^readme/i.test(f))
    .sort()
    .map(f => {
      const mcq = join(dir, f.replace(/\.md$/, '.mcq.json'));
      return { path: f, text: readFileSync(join(dir, f), 'utf8'), ...(existsSync(mcq) ? { questions: readFileSync(mcq, 'utf8') } : {}) };
    });
  const files: Record<string, Buffer> = {};
  const figDir = join(dir, 'figures');
  if (existsSync(figDir)) for (const f of readdirSync(figDir)) files[`figures/${f}`] = readFileSync(join(figDir, f));
  const phrasesPath = join(dirname(dir), 'originality-phrases.txt');
  const phrases = existsSync(phrasesPath)
    ? readFileSync(phrasesPath, 'utf8')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
    : [];
  return { source: `content-import/${subject}`, outline, topics, files, phrases };
}

export function printReport(r: ImportReport, log = console.log) {
  const errors = r.problems.filter(p => p.level === 'error');
  const warnings = r.problems.filter(p => p.level === 'warning');
  for (const p of errors) log(`  ✗ ${p.where}: ${p.message}`);
  for (const p of warnings) log(`  ! ${p.where}: ${p.message}`);
  if (errors.length) {
    log(`\n${errors.length} error(s): nothing was imported. Fix them and run again.`);
    return;
  }
  log(`\nNew topics (drafts): ${r.topics.created.length}`);
  for (const t of r.topics.created) log(`  + ${t}`);
  log(`New versions of existing topics: ${r.topics.newVersions.length}`);
  for (const t of r.topics.newVersions) log(`  ↻ ${t}`);
  log(`Unchanged: ${r.topics.unchanged.length}`);
  log(`Questions: ${r.questions} · figures new ${r.figures.stored}, already stored ${r.figures.reused} · originality flags ${r.originalityFlags} · warnings ${warnings.length}`);
  log(r.dryRun ? '\nNothing changed (dry run). Run again with --yes to import as drafts.' : '\nImported as drafts: review them in the dashboard (Review → Notes versions).');
}

async function main() {
  const args = process.argv.slice(2);
  const folder = args.find(a => !a.startsWith('--'));
  if (!folder) throw new Error('Usage: yarn content:notes <content-import/subject-folder> [--yes]');
  const bundle = readBundle(folder);
  console.log(`${bundle.outline.subject} outline v${bundle.outline.version}: ${bundle.topics.length} topic files, ${Object.keys(bundle.files).length} figure files.`);

  process.env.NEWS_FETCH_EVERY_HOURS = '0';
  process.env.STUDY_JOBS = 'off';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const report = await app.get(TopicVersionsService).import(bundle, { dryRun: !args.includes('--yes'), authorName: LIBRARY_AUTHOR_NAME });
    printReport(report);
    if (report.problems.some(p => p.level === 'error')) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
