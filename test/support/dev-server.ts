/**
 * yarn dev:memory — run the whole backend locally with zero setup.
 *
 * - In-memory MongoDB (data is lost when you stop the server)
 * - Sample courses, quizzes and news loaded
 * - A demo student: demo@edmira.com / Demo!2345
 * - Dashboard staff: admin@ / creator@ / reviewer@edmira.com, password Staff!2345
 * - Emails are NOT sent; verification / reset codes are printed here
 * - IMPORT_NOTES=<folder>: also import that subject's notes as drafts (see content-import/README.md)
 */
process.env.NODE_ENV = 'development';

import { startInMemoryApp } from './in-memory-app';
import { seedSampleContent } from '../../src/seed/seed-sample-content';
import { AuthService } from '../../src/auth/auth.service';
import { UserType } from '../../src/common/enum/user-type.enum';

const PORT = Number(process.env.PORT ?? 4000);
const DEMO = { email: 'demo@edmira.com', password: 'Demo!2345' };
const STAFF_PASSWORD = 'Staff!2345';

async function main() {
  const server = await startInMemoryApp({ logEmails: true });
  const seeded = await seedSampleContent(server.connection);

  const auth = server.app.get(AuthService);
  await auth.signup({
    email: DEMO.email,
    password: DEMO.password,
    firstName: 'Demo',
    lastName: 'Student',
    username: 'demo',
    userType: UserType.STUDENT,
    countryCode: '+234',
    phoneNumber: '8012345678',
    studentProfile: {
      institution: 'University of Lagos',
      faculty: 'Faculty of Clinical Sciences',
      department: 'Medicine & Surgery (MBBS)',
      levelType: 'Undergraduate',
      level: '300 Level',
    } as any,
  });
  await auth.verifyOtp({ email: DEMO.email, code: server.mail.lastCode(DEMO.email) });

  for (const [role, name] of [
    ['admin', 'Ada Admin'],
    ['creator', 'Chidi Creator'],
    ['reviewer', 'Dr Rita Reviewer'],
  ] as const) {
    await server.createStaff(`${role}@edmira.com`, role, STAFF_PASSWORD, name);
  }

  // SEED_LEADERBOARD=1 yarn dev:memory → 60 fake students so the boards look real.
  if (process.env.SEED_LEADERBOARD === '1') {
    const { seedLeaderboard } = await import('../../src/seed/seed-leaderboard');
    console.log(`🏆 Leaderboard seed: ${JSON.stringify(await seedLeaderboard(server.app, 60))}`);
    // Two in three seeded students get a built-in avatar, so pictures show on the boards.
    const users = server.connection.collection('users');
    const fakes = await users.find({ role: { $exists: false }, email: { $ne: DEMO.email } }).project({ _id: 1 }).toArray();
    await Promise.all(
      fakes
        .filter((_, i) => i % 3 !== 2)
        .map((u, i) => users.updateOne({ _id: u._id }, { $set: { avatar: { kind: 'preset', preset: `a${String((i % 18) + 1).padStart(2, '0')}`, at: new Date() } } })),
    );
  }

  // PLANS=founding|trial|free yarn dev:memory → Free/Pro switched on, with the demo student in that state
  // (founding = Founding Tester month, trial = fresh 3-day trial, free = trial over). Free limit 30, Pro 100.
  if (process.env.PLANS) {
    const { PlansService } = await import('../../src/plans/plans.service');
    await server.app.get(PlansService).updateConfig({ enabled: true }, 'Dev server');
    const users = server.connection.collection('users');
    const now = Date.now();
    if (process.env.PLANS === 'trial' || process.env.PLANS === 'free') {
      const ends = process.env.PLANS === 'trial' ? now + 72 * 3_600_000 : now - 60_000;
      await users.updateOne({ email: DEMO.email }, { $set: { trialStartedAt: new Date(ends - 72 * 3_600_000), trialEndsAt: new Date(ends) } });
    }
    console.log(`💳 Plans on; demo student: ${process.env.PLANS}`);
  }

  // LOAD_LIBRARY=200-pio,300-pio yarn dev:memory → those content-library courses too (topics/questions arrive in review).
  if (process.env.LOAD_LIBRARY) {
    const { readdirSync, readFileSync } = await import('fs');
    const { join } = await import('path');
    const { getModelToken } = await import('@nestjs/mongoose');
    const { importContent, LIBRARY_AUTHOR_NAME } = await import('../../src/admin/content-import');
    const dir = join(__dirname, '../../content-library/import');
    const prefixes = process.env.LOAD_LIBRARY.split(',').map(p => p.trim());
    const model = (name: string) => server.app.get(getModelToken(name));
    const models = { courses: model('Course'), topics: model('Topic'), questions: model('Question'), resources: model('Resource') };
    for (const file of readdirSync(dir).filter(f => prefixes.some(p => f.startsWith(p)))) {
      const { courses } = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const r = await importContent(models as never, courses, { name: LIBRARY_AUTHOR_NAME }, { publishNewCourses: true });
      console.log(`📦 ${file}: ${r.courses.created} courses, ${r.topics.created} topics, ${r.questions.created} questions${r.errors.length ? ` (${r.errors.length} errors)` : ''}`);
    }
  }

  // IMPORT_NOTES=<content-import/subject folder> yarn dev:memory → its notes as drafts (Review → Notes versions).
  if (process.env.IMPORT_NOTES) {
    const { readBundle, printReport } = await import('../../src/scripts/content-notes');
    const { TopicVersionsService } = await import('../../src/content/topic-versions.service');
    const report = await server.app.get(TopicVersionsService).import(readBundle(process.env.IMPORT_NOTES), { authorName: 'EdMira content library' });
    console.log('📚 Notes import:');
    printReport(report);
  }

  // DEMO_PUBLISH=1 yarn dev:memory → (local demo only) the content-library topics/questions go live without
  // review, and the PHY-01-04 notes version is approved, so the app has something to show.
  if (process.env.DEMO_PUBLISH === '1') {
    const db = server.connection;
    const lib = await db.collection('topics').find({ status: 'in_review', curriculumId: { $exists: false } }).project({ _id: 1 }).toArray();
    await db.collection('topics').updateMany({ _id: { $in: lib.map(t => t._id) } }, { $set: { status: 'published' } });
    await db.collection('questions').updateMany({ topicId: { $in: lib.map(t => t._id) }, status: 'in_review' }, { $set: { status: 'published' } });
    const reviewer = await db.collection('users').findOne({ email: 'reviewer@edmira.com' });
    // Every imported notes version without an open ⚑ goes live (local demo only; real review happens in the dashboard).
    const pending = await db.collection('topic_versions').find({ status: 'in_review' }).toArray();
    const { TopicVersionsService } = await import('../../src/content/topic-versions.service');
    let approved = 0;
    for (const v of pending) {
      if ((v.flags ?? []).some((f: { resolution?: unknown }) => !f.resolution)) continue;
      try {
        await server.app.get(TopicVersionsService).transition({ id: String(reviewer!._id), name: `${reviewer!.firstName} ${reviewer!.lastName}`, role: reviewer!.role } as never, String(v._id), 'approve');
        approved++;
      } catch (e) {
        console.log(`  (not approved: ${(e as Error).message})`);
      }
    }
    const v = approved;
    console.log(`🟢 Demo: ${lib.length} library topics published${v ? `, ${v} notes versions approved` : ''}`);
  }

  // MODULES=dry|yes yarn dev:memory → Physiology school courses → modules (report, or apply).
  if (process.env.MODULES) {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const m = await import('../../src/content/physiology-modules');
    const outline = JSON.parse(readFileSync(process.env.MODULES_OUTLINE ?? join(__dirname, '../../../Desktop/EdMira Mobile1.0/EdMira-MobileApp/content-import/curriculum/physiology_outline.json'), 'utf8'));
    const plan = await m.planPhysiologyModules(server.connection, outline);
    console.log(`🧭 ${m.formatPlan(plan)}`);
    if (process.env.MODULES === 'yes') console.log(`🧭 Applied: ${JSON.stringify(await m.applyPhysiologyModules(server.connection, outline, plan))}`);
  }

  await server.app.listen(PORT, '0.0.0.0');
  console.log(`
🚀 EdMira backend (in-memory) on http://localhost:${PORT}/api/v1   docs: /api/docs
   Seeded ${seeded.courses} courses, ${seeded.topics} topics, ${seeded.questions} questions, ${seeded.news} news
   Demo student:  ${DEMO.email} / ${DEMO.password}
   Dashboard:     admin@edmira.com · creator@edmira.com · reviewer@edmira.com  (password ${STAFF_PASSWORD})
   Codes for sign-up / password reset are printed below as ✉️ lines.

   Point the app at it (EdMira-MobileApp/src/config/backend.ts → BACKEND.baseURL):
     iOS simulator      http://localhost:${PORT}
     Android emulator   http://10.0.2.2:${PORT}
     Physical phone     http://<this Mac's Wi-Fi IP>:${PORT}
`);

  const stop = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
