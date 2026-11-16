/**
 * yarn usernames — get existing accounts ready for username login.
 *
 *   yarn usernames audit [--json]       READ-ONLY report: usernames shared (ignoring case),
 *                                        usernames that break the new rules, accounts without one
 *   yarn usernames backfill [--dry-run]  set `usernameLower` on every account (safe to re-run)
 *   yarn usernames backfill --undo       remove `usernameLower` again
 *   yarn usernames index                 create the unique index on `usernameLower` — refuses
 *                                        while any two accounts share a username
 *   yarn usernames index --drop          remove that index again
 *
 * Order for production: audit → (decide what to do about each duplicate) →
 * backfill → audit again → index. Nobody is renamed by this script.
 * Uses MONGODB_URI (from .env, or set it on the command line / Render shell).
 */
import mongoose from 'mongoose';
import { normalizeUsername, usernameProblem } from '../users/username-policy';

const INDEX_NAME = 'usernameLower_unique';

type Row = { _id: unknown; email?: string; username?: string; usernameLower?: string; role?: string; createdAt?: Date };

const users = () => mongoose.connection.db!.collection<Row>('users');
const flag = (name: string) => process.argv.includes(`--${name}`);
const when = (d?: Date) => (d ? new Date(d).toISOString().slice(0, 10) : 'unknown date');

async function audit() {
  const all = await users()
    .find({}, { projection: { email: 1, username: 1, usernameLower: 1, role: 1, createdAt: 1 } })
    .toArray();

  const groups = new Map<string, Row[]>();
  const noUsername: Row[] = [];
  const breaksRules: { row: Row; problem: string }[] = [];
  let notBackfilled = 0;

  for (const row of all) {
    if (typeof row.username !== 'string' || !row.username.trim()) {
      noUsername.push(row);
      continue;
    }
    const lower = normalizeUsername(row.username);
    if (row.usernameLower !== lower) notBackfilled++;
    groups.set(lower, [...(groups.get(lower) ?? []), row]);
    const problem = usernameProblem(row.username, { allowReserved: !!row.role });
    if (problem) breaksRules.push({ row, problem });
  }
  const duplicates = [...groups.entries()].filter(([, rows]) => rows.length > 1);

  const report = {
    accounts: all.length,
    sharedUsernames: duplicates.map(([username, rows]) => ({
      username,
      accounts: rows.map(r => ({ username: r.username, email: r.email, staff: !!r.role, joined: when(r.createdAt) })),
    })),
    breaksNewRules: breaksRules.map(({ row, problem }) => ({ username: row.username, email: row.email, problem })),
    withoutUsername: noUsername.map(r => ({ email: r.email, joined: when(r.createdAt) })),
    notBackfilled,
  };

  if (flag('json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`\nAccounts: ${report.accounts}`);
  console.log(`\n① Usernames shared by more than one account (ignoring case): ${duplicates.length}`);
  for (const group of report.sharedUsernames) {
    console.log(`   @${group.username}`);
    for (const a of group.accounts) console.log(`      - ${a.username}  ${a.email}${a.staff ? '  [staff]' : ''}  joined ${a.joined}`);
  }
  console.log(`\n② Usernames that break the new rules (they still log in; rules apply when changed): ${breaksRules.length}`);
  for (const b of report.breaksNewRules) console.log(`   - "${b.username}"  ${b.email}  → ${b.problem}`);
  console.log(`\n③ Accounts without a username: ${noUsername.length}`);
  for (const r of report.withoutUsername) console.log(`   - ${r.email}  joined ${r.joined}`);
  console.log(`\n④ Accounts still needing \`yarn usernames backfill\`: ${notBackfilled}`);
  console.log(
    duplicates.length
      ? '\n→ Decide what to do about ① before running `yarn usernames index`.\n'
      : '\n→ No shared usernames: after backfill, `yarn usernames index` can run.\n',
  );
}

async function backfill() {
  if (flag('undo')) {
    const res = await users().updateMany({ usernameLower: { $exists: true } }, { $unset: { usernameLower: '' } });
    console.log(`Removed usernameLower from ${res.modifiedCount} accounts.`);
    return;
  }
  const rows = await users()
    .find({ username: { $type: 'string' } }, { projection: { username: 1, usernameLower: 1 } })
    .toArray();
  const updates = rows
    .filter(r => r.username!.trim() && r.usernameLower !== normalizeUsername(r.username!))
    .map(r => ({ updateOne: { filter: { _id: r._id }, update: { $set: { usernameLower: normalizeUsername(r.username!) } } } }));
  if (flag('dry-run')) {
    console.log(`Would set usernameLower on ${updates.length} of ${rows.length} accounts (dry run, nothing written).`);
    return;
  }
  if (updates.length) await users().bulkWrite(updates as any, { ordered: false });
  console.log(`Set usernameLower on ${updates.length} of ${rows.length} accounts.`);
}

async function index() {
  if (flag('drop')) {
    await users().dropIndex(INDEX_NAME).catch(() => console.log('(There was no such index.)'));
    console.log(`Dropped ${INDEX_NAME}.`);
    return;
  }
  const missing = await users().countDocuments({ username: { $type: 'string' }, usernameLower: { $exists: false } });
  if (missing) {
    console.log(`${missing} accounts have no usernameLower yet — run \`yarn usernames backfill\` first.`);
    process.exitCode = 1;
    return;
  }
  const duplicates = await users()
    .aggregate([
      { $match: { usernameLower: { $type: 'string' } } },
      { $group: { _id: '$usernameLower', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();
  if (duplicates.length) {
    console.log(`Not creating the index: ${duplicates.length} usernames are shared by several accounts:`);
    for (const d of duplicates) console.log(`   @${d._id} × ${d.count}`);
    console.log('Run `yarn usernames audit` for details.');
    process.exitCode = 1;
    return;
  }
  await users().createIndex(
    { usernameLower: 1 },
    { name: INDEX_NAME, unique: true, partialFilterExpression: { usernameLower: { $type: 'string' } } },
  );
  console.log(`Created unique index ${INDEX_NAME}. Usernames are now unique at the database level.`);
}

async function main() {
  const command = process.argv[2];
  const commands: Record<string, () => Promise<void>> = { audit, backfill, index };
  if (!commands[command]) throw new Error('Usage: yarn usernames <audit|backfill|index> [--json|--dry-run|--undo|--drop]');
  if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI (e.g. in .env).');
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    await commands[command]();
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error(error.message ?? error);
  process.exit(1);
});
