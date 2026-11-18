/**
 * yarn content:physiology-modules <outline.json> [--yes | --undo]
 *
 * Moves Physiology from school courses (PIO 201 …) to Subject → Module →
 * Topic. Without a flag it only prints the dry-run report (what maps where,
 * anything unmatched). --yes applies it (logged); --undo reverses the last
 * run. Uses MONGODB_URI. See src/content/physiology-modules.ts.
 */
import mongoose from 'mongoose';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Outline } from '../content/notes-format';
import { applyPhysiologyModules, formatPlan, planPhysiologyModules, undoPhysiologyModules } from '../content/physiology-modules';

async function main() {
  const args = process.argv.slice(2);
  const outlinePath = args.find(a => !a.startsWith('--'));
  if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI.');
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    if (args.includes('--undo')) {
      console.log(JSON.stringify(await undoPhysiologyModules(mongoose.connection)));
      return;
    }
    if (!outlinePath) throw new Error('Usage: yarn content:physiology-modules <physiology_outline.json> [--yes | --undo]');
    const outline = JSON.parse(readFileSync(resolve(outlinePath), 'utf8')) as Outline;
    const plan = await planPhysiologyModules(mongoose.connection, outline);
    console.log(formatPlan(plan));
    if (!args.includes('--yes')) {
      console.log('\nNothing changed. Run again with --yes to apply.');
      return;
    }
    console.log(`\nApplied: ${JSON.stringify(await applyPhysiologyModules(mongoose.connection, outline, plan))}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(e => {
  console.error(e.message ?? e);
  process.exit(1);
});
