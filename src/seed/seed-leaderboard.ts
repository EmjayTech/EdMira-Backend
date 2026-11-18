/**
 * yarn seed:leaderboard [--students 60]
 *
 * Fake students with realistic quiz activity this week and last week, for
 * trying the leaderboards locally. Scored through the real points rules
 * (StudyService), so boards, streaks and the Schools tab all fill up.
 *
 * Never in production: refuses when NODE_ENV=production, and only touches
 * accounts it created (emails @seed.edmira.local). Needs published content
 * (`yarn seed` or `yarn dev:memory` first).
 */
import { INestApplicationContext } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { StudyService } from '../study/study.service';
import { weekOf, weekRange } from '../leaderboard/week';

const SCHOOLS = ['University of Lagos', 'University of Ibadan', 'University of Nigeria, Nsukka', 'Ahmadu Bello University', 'Obafemi Awolowo University'];
const LEVELS = ['100 Level', '200 Level', '300 Level', '400 Level'];
const DEPARTMENTS = ['Medicine & Surgery (MBBS)', 'Physiology', 'Anatomy', 'Nursing Science', 'Pharmacy'];
const NAMES = ['ada', 'tunde', 'zee', 'chidi', 'fola', 'ibk', 'mo', 'ngozi', 'segun', 'aisha', 'emeka', 'bisi', 'yusuf', 'kemi', 'obi'];
export const SEED_EMAIL_DOMAIN = 'seed.edmira.local';

/** Small deterministic random numbers, so a re-seed looks the same. */
const random = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

export async function seedLeaderboard(app: INestApplicationContext, students = 60) {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to create fake students in production.');
  const db = app.get<Connection>(getConnectionToken());
  const topics = await db.collection('topics').find({ status: 'published' }).limit(40).toArray();
  if (!topics.length) throw new Error('No published topics: run `yarn seed` first.');
  const questions = await db.collection('questions').find({ status: 'published', topicId: { $in: topics.map(t => t._id) } }).toArray();

  const rand = random(42);
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)];
  const now = Date.now();
  const thisWeek = weekRange(weekOf(new Date())).start.getTime();
  const lastWeek = thisWeek - 7 * 86_400_000;
  let created = 0;
  let attempts = 0;

  for (let i = 0; i < students; i++) {
    const username = `${pick(NAMES)}_${(i + 1).toString().padStart(2, '0')}`;
    const email = `${username}@${SEED_EMAIL_DOMAIN}`;
    if (await db.collection('users').findOne({ email })) continue;
    const school = SCHOOLS[i % SCHOOLS.length];
    const { insertedId } = await db.collection('users').insertOne({
      email,
      firstName: 'Seed',
      lastName: `Student ${i + 1}`,
      username,
      usernameLower: username.toLowerCase(),
      password: 'not-a-real-password',
      userType: 'STUDENT',
      isVerified: true,
      status: 'active',
      studentProfile: { institution: school, faculty: 'Faculty of Basic Medical Sciences', department: pick(DEPARTMENTS), levelType: 'Undergraduate', level: pick(LEVELS) },
      // A few opt out, to see hidden students handled.
      ...(i % 13 === 7 ? { privacy: { showOnLeaderboard: false } } : {}),
      createdAt: new Date(now - 30 * 86_400_000),
    });
    created += 1;

    // Keen students quiz most days; others now and then.
    const keenness = rand();
    for (const weekStart of [lastWeek, thisWeek]) {
      for (let day = 0; day < 7; day++) {
        const at = weekStart + day * 86_400_000 + (9 + Math.floor(rand() * 12)) * 3_600_000;
        if (at > now || rand() > keenness) continue;
        const topic = pick(topics);
        const qs = questions.filter(q => String(q.topicId) === String(topic._id));
        if (!qs.length) continue;
        const skill = 0.4 + keenness * 0.55;
        const answers = qs.map(q => {
          const correct = rand() < skill;
          return { questionId: q._id, selectedIndex: correct ? q.answerIndex : (q.answerIndex + 1) % q.options.length, correct };
        });
        const right = answers.filter(a => a.correct).length;
        await db.collection('quizattempts').insertOne({
          studentId: insertedId as Types.ObjectId,
          topicId: topic._id,
          courseId: topic.courseId,
          topicTitle: topic.title,
          courseTitle: 'Seeded',
          startedAt: new Date(at - qs.length * 25_000),
          submittedAt: new Date(at),
          total: qs.length,
          correctCount: right,
          answeredCount: qs.length,
          score: Math.round((right / qs.length) * 100),
          answers,
        });
        attempts += 1;
      }
    }
  }
  const scored = await app.get(StudyService).scoreUnscored();
  return { created, attempts, scored: scored.scored };
}

async function main() {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module');
  const i = process.argv.indexOf('--students');
  const count = i > 0 ? Number(process.argv[i + 1]) : 60;
  process.env.NEWS_FETCH_EVERY_HOURS = '0';
  process.env.STUDY_JOBS = 'off';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    console.log(JSON.stringify(await seedLeaderboard(app, count)));
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
