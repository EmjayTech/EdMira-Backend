#!/usr/bin/env node
/**
 * Finds recommended YouTube videos for every topic in content-library/src.
 *
 *   node content-library/videos.mjs            # topics without a decision yet
 *   node content-library/videos.mjs --redo     # search every topic again
 *   node content-library/videos.mjs 200-ana    # only files whose name contains this
 *
 * For each topic it searches YouTube, keeps only videos from well-known
 * education channels (TRUSTED below) whose title shares key words with the
 * topic and whose length suits studying (2–75 min), picks up to two (from
 * different channels when possible), and confirms each still exists and is
 * public via YouTube's oEmbed endpoint. Results go to content-library/videos.json,
 * which build.mjs adds to the import files as topic videos. Videos land in the
 * review queue like everything else — a reviewer approves each one.
 *
 * Searches are cached in content-library/.video-cache.json and spaced out, so
 * a re-run is quick and polite.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'videos.json');
const CACHE = join(ROOT, '.video-cache.json');
const REDO = process.argv.includes('--redo');
const PER_TOPIC = 2;
const GAP_MS = 1500;

/** Channels whose teaching is widely used by medical and health students. */
const TRUSTED = [
  'Ninja Nerd', 'Osmosis from Elsevier', 'Osmosis', 'Armando Hasudungan', 'Khan Academy Medicine', 'Khan Academy',
  'Dr Matt & Dr Mike', 'Neural Academy', 'Kenhub - Learn Human Anatomy', 'Lecturio Medical', 'Lecturio Nursing',
  'MedCram - Medical Lectures Explained CLEARLY', 'Professor Dave Explains', 'CrashCourse', 'Amoeba Sisters',
  'Speed Pharmacology', 'Dirty Medicine', 'SimpleNursing', 'RegisteredNurseRN', 'Level Up RN', 'Physiotutors',
  'AK LECTURES', 'The Organic Chemistry Tutor', 'Bozeman Science', 'JJ Medicine', 'Zero To Finals', 'Geeky Medics',
  'Stanford Medicine 25', 'Handwritten Tutorials', 'Catalyst University', 'Global Health with Greg Martin',
  'World Health Organization (WHO)', 'Sam Webster', 'The Noted Anatomist', 'Dr.G Bhanu Prakash Animated Medical Videos',
  'Medicosis Perfectionalis', 'Taim Talks Med', 'Rhesus Medicine', 'Radiology Tutorials', 'StatQuest with Josh Starmer',
  'zedstatistics', 'Dr Nic\'s Maths and Stats', 'MIT OpenCourseWare', 'Physics with Professor Matt Anderson',
  'Math and Science', '3Blue1Brown', 'Computerphile', 'Crash Course', 'TED-Ed', 'Dr. Najeeb Lectures',
  'Medical Education Leeds', 'Oxford Medical Education', 'Clinical Anatomy Explained!', 'Anatomy Zone',
  'Mechanisms in Medicine', 'iBiology', 'Nucleus Medical Media', 'Pharmacology Animations', 'Rx Pharmacist',
  'NURSINGcom', 'Nurse Sarah\'s Medical Minute', 'Mometrix Academy', 'Biology Professor', 'Moof University',
  'Dr. Mike Todorovic', 'MEDSimplified', 'Medical Mnemonist', 'Mike Pound', 'NPTEL-NOC IITM', 'Brian McLogan',
].map(n => n.toLowerCase());

const STOP = new Set(
  ('and the of in to for with a an on or its their from by at as is are into vs versus i ii iii iv v ' +
    'introduction principles basic basics clinical management overview general care disorders diseases ' +
    'common other related practice applied methods systems system part study nursing medicine medical ' +
    'health science sciences concepts foundations fundamentals special issues topics').split(' '),
);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const words = text =>
  (text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').match(/[a-z0-9]+/g) ?? []).filter(
    w => w.length >= 3 && !STOP.has(w),
  );
const stem = w => w.replace(/(ies|es|s|al|ic|ical|ology|ologic)$/, '');
const minutes = len => {
  if (!len) return 0;
  const parts = len.split(':').map(Number);
  return parts.reduce((t, n) => t * 60 + n, 0) / 60;
};

const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const saveCache = () => writeFileSync(CACHE, JSON.stringify(cache));
const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};

async function search(query, attempt = 1) {
  if (cache[query]) return cache[query];
  await sleep(GAP_MS);
  const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&gl=NG`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
      'accept-language': 'en',
    },
  });
  if (!res.ok) throw new Error(`YouTube search ${res.status}`);
  const html = await res.text();
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) {
    // Occasionally YouTube answers with a consent/throttle page: wait and retry.
    if (attempt < 3) {
      await sleep(8000 * attempt);
      return search(query, attempt + 1);
    }
    throw new Error('YouTube search page changed (no ytInitialData)');
  }
  const found = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (o.videoRenderer) {
      const v = o.videoRenderer;
      found.push({
        id: v.videoId,
        title: v.title?.runs?.map(r => r.text).join('') ?? '',
        channel: v.ownerText?.runs?.[0]?.text ?? '',
        length: v.lengthText?.simpleText ?? '',
      });
      return;
    }
    for (const k in o) walk(o[k]);
  })(JSON.parse(m[1]));
  cache[query] = found.slice(0, 20);
  saveCache();
  return cache[query];
}

async function exists(id) {
  const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`);
  if (!res.ok) return null;
  return res.json();
}

function choose(topicTitle, courseTitle, found) {
  const keys = [...new Set(words(topicTitle).map(stem))];
  const courseKeys = new Set(words(courseTitle).map(stem));
  const scored = found
    .map((v, rank) => {
      const titleStems = new Set(words(v.title).map(stem));
      const hits = keys.filter(k => titleStems.has(k)).length;
      const courseHits = [...courseKeys].filter(k => titleStems.has(k)).length;
      return { ...v, rank, hits, courseHits, mins: minutes(v.length) };
    })
    .filter(
      v =>
        TRUSTED.includes(v.channel.toLowerCase()) &&
        v.mins >= 2 &&
        v.mins <= 75 &&
        !/#shorts|\bshorts?\b/i.test(v.title) &&
        // Must share key words with the topic: all of them for 1–2 key-word topics,
        // one for 3 (e.g. "Arm, Forearm and Hand"), two for longer titles.
        v.hits >= (keys.length <= 2 ? keys.length : keys.length === 3 ? 1 : 2),
    )
    .sort((a, b) => b.hits - a.hits || b.courseHits - a.courseHits || a.rank - b.rank);
  const picked = [];
  for (const v of scored) {
    if (picked.length >= PER_TOPIC) break;
    if (picked.some(p => p.channel === v.channel) && scored.some(o => !picked.includes(o) && o !== v && !picked.some(p => p.channel === o.channel))) continue;
    picked.push(v);
  }
  if (picked.length < PER_TOPIC) for (const v of scored) if (picked.length < PER_TOPIC && !picked.includes(v)) picked.push(v);
  return picked;
}

const shortCourse = title => title.replace(/:.*$/, '').replace(/\b(I|II|III|IV|V)\b/g, '').trim();

const ONLY = process.argv.slice(2).filter(a => !a.startsWith('--'));
const files = readdirSync(SRC)
  .filter(f => f.endsWith('.json') && (!ONLY.length || ONLY.some(o => f.includes(o))))
  .sort();
let done = 0;
let withVideos = 0;
let total = 0;
for (const file of files) {
  const course = JSON.parse(readFileSync(join(SRC, file), 'utf8'));
  for (const topic of course.topics) {
    total++;
    const key = `${file}::${topic.title}`;
    if (!REDO && results[key]) {
      if (results[key].length) withVideos++;
      continue;
    }
    try {
      const query = `${topic.title} ${shortCourse(course.title)}`;
      let found = await search(query);
      let picks = choose(topic.title, course.title, found);
      if (!picks.length) {
        found = await search(`${topic.title} lecture`);
        picks = choose(topic.title, course.title, found);
      }
      const verified = [];
      for (const p of picks) {
        const info = await exists(p.id);
        if (info) verified.push({ youTubeId: p.id, title: info.title ?? p.title, channel: info.author_name ?? p.channel, minutes: Math.round(p.mins) });
      }
      results[key] = verified;
      if (verified.length) withVideos++;
      done++;
      if (done % 20 === 0) {
        writeFileSync(OUT, JSON.stringify(results, null, 1));
        console.log(`… ${done} topics searched (${withVideos}/${total} with videos so far)`);
      }
    } catch (error) {
      console.warn(`${key}: ${error.message}`);
      if (/changed|429|403/.test(error.message)) break;
    }
  }
}
writeFileSync(OUT, JSON.stringify(results, null, 1));
const count = Object.values(results).reduce((n, v) => n + v.length, 0);
console.log(`Done: ${count} videos for ${withVideos} of ${total} topics → content-library/videos.json`);
