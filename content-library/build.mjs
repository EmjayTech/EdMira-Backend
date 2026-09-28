#!/usr/bin/env node
/**
 * node content-library/build.mjs
 *
 * Turns the compact course sources in content-library/src/*.json into import
 * files in content-library/import/ (the dashboard / `yarn content:load`
 * format), checks every question, and prints which department × level pairs
 * have courses — so no student opens an empty "For you" tab.
 *
 * Source format (one course per file, compact to keep thousands of questions
 * readable):
 *
 * {
 *   "title": "Gross Anatomy I: Upper and Lower Limbs",
 *   "code": "ANA201",            // ≤ 6 characters on the course card
 *   "color": "#B45309",
 *   "description": "…",
 *   "for": { "200": ["MBBS", "BDS", …], "300": ["*"] },   // level → departments ("*" = any)
 *   "topics": [
 *     {
 *       "title": "…", "summary": "…",
 *       "notes": [{ "h": "Heading", "b": "Body text", "k": ["key point", …] }],
 *       "q": [["Stem?", "A", "B", "C", "D", "E", 1, "Explanation"], …]   // answer index 0 = A
 *     }
 *   ]
 * }
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'src');
const OUT = join(here, 'import');

export const DEPARTMENTS = {
  MBBS: 'Medicine & Surgery (MBBS)',
  BDS: 'Dentistry (BDS)',
  NUR: 'Nursing Science',
  SON: 'School/College of Nursing',
  PHM: 'Pharmacy',
  MLS: 'Medical Laboratory Science',
  RAD: 'Radiography',
  PT: 'Physiotherapy',
  PH: 'Public Health',
  BME: 'Biomedical engineering',
  ANA: 'Anatomy',
  PHS: 'Physiology',
  BCH: 'Biochemistry',
  PHA: 'Pharmacology',
  CM: 'Community Medicine',
  HAE: 'Haematology',
  OTH: 'Others',
};

const UG = ['100', '200', '300', '400', '500', '600'];
const PG = ['Master of Science (M.Sc.)', 'Master of Philosophy (M.Phil.)', 'Doctor of Philosophy (Ph.D.)', 'Higher Doctorates'];

/** How long each programme runs (undergraduate levels students can be in). */
export const DURATION = {
  MBBS: 6, BDS: 6, PHM: 6, NUR: 5, MLS: 5, RAD: 5, PT: 5, BME: 5, HAE: 5,
  PH: 4, ANA: 4, PHS: 4, BCH: 4, PHA: 4, SON: 3, CM: 6, OTH: 6,
};

/**
 * Authors tend to put the right answer in the same place, so options are
 * shuffled with a seed from the question text (the same every build).
 * Ordered lists — numbers, dates, doses — keep their order.
 */
function hash(text) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
function shuffle(options, answerIndex, seedText) {
  if (options.every((o) => /^[\s\d.,:%/<>≥≤×+\-–]+(\s*[a-zA-Zµ%/]+)?$/.test(String(o).trim()))) return { options, answerIndex };
  let seed = hash(seedText);
  const order = options.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const j = seed % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { options: order.map((i) => options[i]), answerIndex: order.indexOf(answerIndex) };
}

const levelNames = (key) => (key === 'PG' ? PG : [`${key} Level`]);

function audience(forMap, where) {
  const rules = [];
  for (const [levelKey, depts] of Object.entries(forMap)) {
    if (levelKey !== 'PG' && !UG.includes(levelKey)) throw new Error(`${where}: unknown level "${levelKey}"`);
    for (const level of levelNames(levelKey)) {
      for (const d of depts) {
        if (d === '*') rules.push({ level });
        else if (!DEPARTMENTS[d]) throw new Error(`${where}: unknown department "${d}"`);
        else rules.push({ level, department: DEPARTMENTS[d] });
      }
    }
  }
  return rules;
}

const problems = [];
const coverage = new Map(); // "DEPT|level" → course count
let totals = { courses: 0, topics: 0, questions: 0 };
const answerSpread = [0, 0, 0, 0, 0, 0];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const files = readdirSync(SRC).filter((f) => f.endsWith('.json')).sort();
const titles = new Set();
for (const file of files) {
  let c;
  try {
    c = JSON.parse(readFileSync(join(SRC, file), 'utf8'));
  } catch (e) {
    problems.push(`${file}: invalid JSON (${e.message})`);
    continue;
  }
  const where = file;
  if (titles.has(c.title)) problems.push(`${where}: duplicate course title "${c.title}"`);
  titles.add(c.title);
  if (!c.code || c.code.length > 6) problems.push(`${where}: code must be 1–6 characters`);
  let rules = [];
  try {
    rules = audience(c.for ?? {}, where);
  } catch (e) {
    problems.push(e.message);
  }
  for (const [levelKey, depts] of Object.entries(c.for ?? {})) {
    for (const d of depts[0] === '*' ? Object.keys(DEPARTMENTS) : depts) {
      const key = `${d}|${levelKey}`;
      coverage.set(key, (coverage.get(key) ?? 0) + 1);
    }
  }

  const topics = (c.topics ?? []).map((t, ti) => {
    const tw = `${where} › ${t.title}`;
    if (!t.summary) problems.push(`${tw}: no summary`);
    if (!t.notes?.length) problems.push(`${tw}: no notes`);
    const stems = new Set();
    const questions = (t.q ?? []).map((q, qi) => {
      const qw = `${tw} › q${qi + 1}`;
      if (!Array.isArray(q) || q.length < 5) {
        problems.push(`${qw}: malformed`);
        return null;
      }
      const stem = q[0];
      const explanation = q[q.length - 1];
      const answerIndex = q[q.length - 2];
      const options = q.slice(1, -2);
      if (typeof explanation !== 'string' || !explanation.trim()) problems.push(`${qw}: no explanation`);
      if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= options.length) problems.push(`${qw}: bad answer index`);
      if (options.length < 4 || options.length > 6) problems.push(`${qw}: needs 4–6 options`);
      if (new Set(options.map((o) => String(o).trim().toLowerCase())).size !== options.length) problems.push(`${qw}: repeated option`);
      if (stems.has(stem.toLowerCase())) problems.push(`${qw}: repeated question`);
      stems.add(stem.toLowerCase());
      return { stem, ...shuffle(options.map(String), answerIndex, stem), explanation };
    }).filter(Boolean);
    for (const q of questions) answerSpread[q.answerIndex]++;
    if (questions.length < 5) problems.push(`${tw}: only ${questions.length} questions`);
    totals.topics++;
    totals.questions += questions.length;
    return {
      title: t.title,
      order: ti + 1,
      summary: t.summary,
      material: (t.notes ?? []).map((n) => ({ heading: n.h, body: n.b, ...(n.k?.length ? { keyPoints: n.k } : {}) })),
      questions,
    };
  });
  totals.courses++;
  writeFileSync(
    join(OUT, file),
    JSON.stringify({ courses: [{ title: c.title, code: c.code, color: c.color, description: c.description, audience: rules, topics }] }, null, 1),
  );
}

// ── Coverage: every department at every level of its programme (postgraduate is
// out of scope for now — the app shows PG students a "coming soon" note) ──
const gaps = [];
for (const [d, years] of Object.entries(DURATION)) {
  for (const lv of UG.slice(0, years)) {
    const n = coverage.get(`${d}|${lv}`) ?? 0;
    if (n < 2) gaps.push(`${d} ${lv}: ${n}`);
  }
}

console.log(`${totals.courses} courses, ${totals.topics} topics, ${totals.questions} questions → content-library/import/`);
console.log(`Correct answer spread A–F: ${answerSpread.join(' / ')}`);
if (process.argv.includes('--coverage')) {
  const header = ['', ...UG, 'PG'].map((s) => s.padStart(5)).join('');
  console.log(header);
  for (const d of Object.keys(DEPARTMENTS)) {
    console.log(d.padStart(5) + [...UG, 'PG'].map((lv) => String(coverage.get(`${d}|${lv}`) ?? '·').padStart(5)).join(''));
  }
}
if (gaps.length) console.log(`\n${gaps.length} department/level pairs have fewer than 2 courses${process.argv.includes('--coverage') ? `:\n  ${gaps.join('\n  ')}` : ' (run with --coverage)'}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n  ${problems.slice(0, 80).join('\n  ')}`);
  process.exitCode = 1;
}
