import { createHash } from 'crypto';

/**
 * ─── The content files behind versioned study notes ─────────────────────────
 *
 * See content-import/README.md. One folder per subject:
 *
 *   curriculum/<subject>_outline.json   modules → topics (IDs like PHY-05-03),
 *                                        the EdMira course of each module and
 *                                        the existing topic each one versions
 *   <subject>/<ID>.md                   one topic: front matter + sections
 *   <subject>/<ID>.mcq.json             its practice questions
 *   <subject>/figures/<file>            images (SVG/PNG/JPEG/WebP)
 *
 * Everything is written originally: no textbook text or figures. Pure
 * functions here (parse, check, originality, hash); the importer
 * (content/topic-versions.service.ts) saves drafts.
 */

export interface ParsedSection {
  heading: string;
  body: string;
}

export interface ParsedFigure {
  key: string;
  file: string;
  caption: string;
  alt: string;
  source: string;
  licence: string;
  attributionText: string;
  originalUrl?: string;
  modified: boolean;
}

export interface ParsedTopic {
  /** Curriculum ID, e.g. "PHY-05-03". */
  id: string;
  title: string;
  summary: string;
  readMinutes?: number;
  /** Contributor keys (lecturers' own notes, given with permission). */
  contributors: string[];
  objectives: string[];
  keyPoints: string[];
  material: ParsedSection[];
  extended: ParsedSection[];
  clinical: ParsedSection[];
  revision: string[];
  furtherReading: string[];
  figures: ParsedFigure[];
}

export interface ParsedQuestion {
  stem: string;
  options: string[];
  answerIndex: number;
  explanation: string;
  difficulty: 'easy' | 'medium' | 'hard';
  kind: 'recall' | 'understanding' | 'clinical';
}

export interface FormatProblem {
  where: string;
  message: string;
  /** Warnings don't stop an import; errors do. */
  level: 'error' | 'warning';
}

/** The parts of <subject>_outline.json the importer uses. */
export interface Outline {
  subject: string;
  version: string;
  modules: {
    id: string;
    title: string;
    typical_level?: string;
    edmira_course: string;
    topics: { id: string; title: string; order: number; edmira: { course: string; action: 'new_version' | 'new_topic'; existing_topic: string | null } }[];
  }[];
  school_codes?: SchoolCodes[];
}

export interface SchoolCodes {
  school: string;
  key: string;
  verified: boolean;
  /** The profile institution value (e.g. "University of Benin"). */
  institution?: string | null;
  source: string | null;
  courses: { code: string | null; title: string | null; modules: string[] }[];
}

const LETTERS = 'ABCDEF';
const FIGURE_TOKEN = /\{\{fig:([a-z0-9-]+)\}\}/g;
export const CURRICULUM_ID = /^[A-Z]{3}-\d{2}-\d{2}$/;

/** "key: value" front matter between --- lines. */
function frontMatter(text: string): { meta: Record<string, string>; rest: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: {}, rest: text };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, rest: text.slice(match[0].length) };
}

/** "## Name" blocks → { name: body } (names lower-cased). */
function blocks(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (name !== null) out.set(name, buf.join('\n').trim());
  };
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m && !line.startsWith('###')) {
      flush();
      name = m[1].toLowerCase();
      buf = [];
    } else buf.push(line);
  }
  flush();
  return out;
}

/** "### Heading" sub-sections of a block. */
function sections(text: string | undefined): ParsedSection[] {
  if (!text) return [];
  const out: ParsedSection[] = [];
  let current: ParsedSection | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^###\s+(.+?)\s*$/);
    if (m) {
      if (current) out.push(current);
      current = { heading: m[1], body: '' };
    } else if (current) current.body += `${line}\n`;
  }
  if (current) out.push(current);
  return out.map(s => ({ heading: s.heading, body: s.body.trim() })).filter(s => s.heading || s.body);
}

/** "- item" lines of a block. */
function bullets(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map(l => l.match(/^\s*[-*]\s+(.+)$/)?.[1]?.trim())
    .filter((l): l is string => !!l);
}

/** The "## Figures" list: "- key: …" then indented "field: …" lines. */
function figures(text: string | undefined): ParsedFigure[] {
  if (!text) return [];
  const out: Record<string, string>[] = [];
  for (const line of text.split(/\r?\n/)) {
    const start = line.match(/^\s*-\s+(\w+):\s*(.*)$/);
    const field = line.match(/^\s+(\w+):\s*(.*)$/);
    if (start) out.push({ [start[1]]: start[2].trim() });
    else if (field && out.length) out[out.length - 1][field[1]] = field[2].trim();
  }
  return out.map(f => ({
    key: f.key ?? '',
    file: f.file ?? '',
    caption: f.caption ?? '',
    alt: f.alt ?? '',
    source: f.source || 'EdMira',
    licence: f.licence || (f.source && f.source !== 'EdMira' ? '' : 'Original'),
    attributionText: f.attribution ?? '',
    originalUrl: f.url || undefined,
    modified: /^(yes|true)$/i.test(f.modified ?? ''),
  }));
}

export function parseTopic(text: string): ParsedTopic {
  const { meta, rest } = frontMatter(text);
  const b = blocks(rest);
  return {
    id: meta.id ?? '',
    title: meta.title ?? '',
    summary: meta.summary ?? '',
    readMinutes: meta.readMinutes ? Number(meta.readMinutes) || undefined : undefined,
    contributors: (meta.contributors ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    objectives: bullets(b.get('objectives')),
    keyPoints: bullets(b.get('key points')),
    material: sections(b.get('notes')),
    extended: sections(b.get('extended')),
    clinical: sections(b.get('clinical correlation')),
    revision: bullets(b.get('revision')),
    furtherReading: bullets(b.get('further reading')),
    figures: figures(b.get('figures')),
  };
}

/** Figure keys a set of sections shows, in order. */
export const figureKeysIn = (secs: ParsedSection[]) => secs.flatMap(s => [...s.body.matchAll(FIGURE_TOKEN)].map(m => m[1]));

// ── Image licences (copyright-safe only) ─────────────────────────────────────

/** Licences a paid product may use. NonCommercial / NoDerivatives never. */
export function licenceProblem(f: ParsedFigure): string | null {
  const lic = f.licence.trim();
  if (/\bNC\b|non-?commercial/i.test(lic)) return `"${lic}" is NonCommercial: not allowed in paid EdMira content.`;
  if (/\bND\b|no-?deriv/i.test(lic)) return `"${lic}" is NoDerivatives: not allowed.`;
  if (/textbook|google|unknown/i.test(`${f.source} ${lic}`)) return 'Images from textbooks, Google Images or unknown sources are not allowed.';
  const ok = /^(original|cc0|public domain|cc by(-sa)? \d\.\d)$/i.test(lic);
  if (!ok) return `Licence "${lic || '(none)'}": use Original, CC BY x.x, CC BY-SA x.x, CC0 or Public domain.`;
  if (/^original$/i.test(lic) && !/^edmira$/i.test(f.source)) return 'Only EdMira\'s own figures can be "Original".';
  if (!/^original$/i.test(lic)) {
    if (!f.attributionText) return 'Needs an attribution line (shown under the figure).';
    if (!f.originalUrl) return 'Needs the original URL of the image.';
  }
  if (/servier/i.test(f.source)) {
    if (!/^cc by 4\.0$/i.test(lic)) return 'Servier Medical Art images are CC BY 4.0.';
    if (!/smart\.servier\.com/i.test(f.attributionText)) {
      return 'Servier attribution must read: "Images provided by Servier Medical Art (smart.servier.com), licensed under CC BY 4.0" (+ "; modified" if changed).';
    }
  }
  if (/wikimedia/i.test(f.source) && !/commons\.wikimedia\.org/i.test(f.originalUrl ?? '')) return 'Wikimedia images need their commons.wikimedia.org file URL.';
  if (f.modified && !/modif|adapt/i.test(f.attributionText) && !/^original$/i.test(lic)) return 'A modified image must say so in its attribution ("modified").';
  return null;
}

export function checkTopic(t: ParsedTopic, where: string, outlineTopic?: { id: string }): FormatProblem[] {
  const p: FormatProblem[] = [];
  const err = (message: string) => p.push({ where, message, level: 'error' });
  const warn = (message: string) => p.push({ where, message, level: 'warning' });
  if (!CURRICULUM_ID.test(t.id)) err('Front matter needs the curriculum id (id: PHY-05-03).');
  else if (!outlineTopic) err(`${t.id} isn't in the curriculum outline.`);
  if (!t.title) err('Front matter needs a title.');
  if (!t.summary) warn('No summary (the one line shown under the topic title).');
  if (t.objectives.length < 3 || t.objectives.length > 5) warn(`${t.objectives.length} learning objectives (3–5).`);
  if (!t.keyPoints.length) err('No key points (## Key points).');
  if (!t.material.length) err('No standard notes (## Notes, then ### headings).');
  if (!t.extended.length) warn('No extended notes (## Extended) for Pro.');
  if (!t.revision.length) warn('No quick-revision box (## Revision).');
  const keys = new Set<string>();
  for (const f of t.figures) {
    const name = f.key || f.file || '(figure)';
    if (!f.key || !f.file) err('A figure needs a key and a file.');
    if (keys.has(f.key)) err(`Figure "${f.key}" is listed twice.`);
    keys.add(f.key);
    if (!f.caption) err(`Figure "${name}" needs a caption.`);
    if (!f.alt) err(`Figure "${name}" needs alt text (what it shows, for screen readers).`);
    const lic = licenceProblem(f);
    if (lic) err(`Figure "${name}": ${lic}`);
  }
  const used = figureKeysIn([...t.material, ...t.extended, ...t.clinical]);
  for (const k of used) if (!keys.has(k)) err(`{{fig:${k}}} is used but not listed under ## Figures.`);
  for (const k of keys) if (!used.includes(k)) warn(`Figure "${k}" is listed but never shown.`);
  const all = [...t.material, ...t.extended, ...t.clinical].map(s => s.body).join('\n');
  const flags = (all.match(/⚑/g) ?? []).length;
  if (flags) warn(`${flags} "⚑" marker(s) for the reviewer to check.`);
  return p;
}

// ── Questions ────────────────────────────────────────────────────────────────

// Letters and digits in any script (α1 and β1 are different options).
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokens = (s: string) => new Set(norm(s).split(' ').filter(w => w.length > 2));

/** Share of words two stems have in common (Jaccard). */
export function similarity(a: string, b: string) {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

export const NEAR_DUPLICATE = 0.8;

export function parseQuestions(json: unknown, where: string): { questions: ParsedQuestion[]; problems: FormatProblem[] } {
  const problems: FormatProblem[] = [];
  const err = (w: string, message: string) => problems.push({ where: w, message, level: 'error' });
  if (!Array.isArray(json)) {
    err(where, 'The question file must be a list ( [ … ] ).');
    return { questions: [], problems };
  }
  const questions: ParsedQuestion[] = [];
  json.forEach((raw: Record<string, unknown>, i) => {
    const w = `${where} #${i + 1}`;
    const stem = String(raw?.stem ?? '').trim();
    const options = Array.isArray(raw?.options) ? (raw.options as unknown[]).map(o => String(o).trim()) : [];
    const answer = raw?.answer;
    const answerIndex = typeof answer === 'number' ? answer : LETTERS.indexOf(String(answer ?? '').trim().toUpperCase());
    const explanation = String(raw?.explanation ?? '').trim();
    const difficulty = String(raw?.difficulty ?? '');
    const kind = String(raw?.kind ?? '');
    if (stem.length < 15) err(w, 'The question is missing or too short.');
    if (options.length < 4 || options.length > 5) err(w, `Needs 4 or 5 options (has ${options.length}).`);
    if (new Set(options.map(norm)).size !== options.length) err(w, 'Two options are the same.');
    if (options.some(o => !o)) err(w, 'An option is empty.');
    if (options.some(o => /\b(all|none|both) of the above\b/i.test(o))) err(w, 'No "all / none of the above" options.');
    if (!(answerIndex >= 0 && answerIndex < options.length)) err(w, 'The answer must be one of the options (A–E).');
    if (explanation.length < 40) err(w, 'Needs an explanation: why the answer is right and the others wrong.');
    if (!['easy', 'medium', 'hard'].includes(difficulty)) err(w, 'difficulty must be easy, medium or hard.');
    if (!['recall', 'understanding', 'clinical'].includes(kind)) err(w, 'kind must be recall, understanding or clinical.');
    questions.push({
      stem,
      options,
      answerIndex,
      explanation,
      difficulty: difficulty as ParsedQuestion['difficulty'],
      kind: kind as ParsedQuestion['kind'],
    });
  });

  for (let i = 0; i < questions.length; i++) {
    for (let j = 0; j < i; j++) {
      if (similarity(questions[i].stem, questions[j].stem) >= NEAR_DUPLICATE) err(`${where} #${i + 1}`, `Nearly the same as question #${j + 1}.`);
    }
  }
  if (questions.length >= 8) {
    const counts = new Map<number, number>();
    for (const q of questions) counts.set(q.answerIndex, (counts.get(q.answerIndex) ?? 0) + 1);
    const most = Math.max(...counts.values());
    if (most / questions.length > 0.4) {
      problems.push({ where, message: `${Math.round((most / questions.length) * 100)}% of answers are in one position (keep it under 40%).`, level: 'warning' });
    }
    if (questions.length >= 10 && counts.size < 4) problems.push({ where, message: 'Correct answers use fewer than 4 positions.', level: 'warning' });
  }
  if (questions.length && questions.length < 50) problems.push({ where, message: `${questions.length} questions (aim for 50–100).`, level: 'warning' });
  return { questions, problems };
}

// ── Originality (free check) ─────────────────────────────────────────────────

/** 8-word windows: two texts sharing several of these share whole phrases. */
const SHINGLE = 8;
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/\{\{fig:[^}]+\}\}/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

export function shingles(text: string): string[] {
  const w = words(text);
  const out: string[] = [];
  for (let i = 0; i + SHINGLE <= w.length; i++) out.push(w.slice(i, i + SHINGLE).join(' '));
  return out;
}

export interface OriginalityFlag {
  section: string;
  passage: string;
  /** What it matches: another EdMira topic, or "stock phrase". */
  matches: string;
  /** Share of the passage's 8-word windows found there (0–1). */
  score: number;
}

/**
 * Flags paragraphs that closely match other text: every other EdMira topic
 * (so notes aren't copied between topics) and an optional list of stock
 * phrases reviewers have spotted. No copies of published books are used.
 */
export function originality(
  topic: { id: string; sections: { label: string; body: string }[] },
  corpus: { label: string; text: string }[],
  phrases: string[] = [],
): OriginalityFlag[] {
  const index = new Map<string, string>();
  for (const doc of corpus) for (const sh of shingles(doc.text)) if (!index.has(sh)) index.set(sh, doc.label);
  const stock = phrases.map(p => words(p).join(' ')).filter(p => p.split(' ').length >= 5);
  const flags: OriginalityFlag[] = [];
  for (const s of topic.sections) {
    for (const para of s.body.split(/\n\s*\n/)) {
      const sh = shingles(para);
      const plain = words(para).join(' ');
      const hit = stock.find(p => plain.includes(p));
      if (hit) {
        flags.push({ section: s.label, passage: para.slice(0, 240), matches: 'stock phrase', score: 1 });
        continue;
      }
      if (sh.length < 4) continue;
      const counts = new Map<string, number>();
      for (const x of sh) {
        const label = index.get(x);
        if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      for (const [label, n] of counts) {
        const score = n / sh.length;
        if (n >= 3 && score >= 0.25) flags.push({ section: s.label, passage: para.slice(0, 240), matches: label, score: Math.round(score * 100) / 100 });
      }
    }
  }
  return flags;
}

// ── Hashing and figures ──────────────────────────────────────────────────────

export const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex').slice(0, 32);

/** Same content → same hash, so re-importing unchanged files adds no version. */
export function contentHash(topic: ParsedTopic, figureHashes: Record<string, string>, questions: ParsedQuestion[]) {
  return sha(JSON.stringify({ topic, figureHashes, questions }));
}

export const FIGURE_TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};
export const MAX_FIGURE_BYTES = 1024 * 1024;

/** Is `data` really the image type its extension says (by its content)? SVGs: no scripts or outside links. */
export function figureTypeOk(mimeType: string, data: Buffer) {
  const head = data.subarray(0, 16);
  switch (mimeType) {
    case 'image/png':
      return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'image/webp':
      return head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP';
    case 'image/svg+xml': {
      const text = data.toString('utf8');
      return /<svg[\s>]/i.test(text.slice(0, 4096)) && !/<script|javascript:|\son\w+\s*=|<foreignObject|(xlink:)?href\s*=\s*["']https?:/i.test(text);
    }
    default:
      return false;
  }
}

// ── "⚑" check markers ────────────────────────────────────────────────────────

/** Where a flag sits: a notes section, a list item, or part of a question. */
export type FlagLocation =
  | { kind: 'section'; part: 'material' | 'extended' | 'clinical'; index: number }
  | { kind: 'list'; part: 'objectives' | 'keyPoints' | 'revision'; index: number }
  | { kind: 'question'; questionIndex: number; field: 'stem' | 'explanation' | 'option'; optionIndex?: number };

export interface FoundFlag {
  /** Stable for the same text in the same place. */
  id: string;
  /** For people: "Notes › Phases", "Question 4 · explanation". */
  where: string;
  location: FlagLocation;
  /** The sentence (or list item) containing the ⚑. */
  excerpt: string;
}

/** Each sentence (or line) of `text` that contains a ⚑, once. */
export function flaggedSentences(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const pos = text.indexOf('⚑', from);
    if (pos < 0) break;
    const before = text.slice(0, pos);
    const start = Math.max(before.lastIndexOf('\n') + 1, ...['. ', '? ', '! '].map(p => (before.lastIndexOf(p) >= 0 ? before.lastIndexOf(p) + 2 : 0)));
    const rest = text.slice(pos);
    const ends = [rest.indexOf('\n'), ...['. ', '? ', '! '].map(p => (rest.indexOf(p) >= 0 ? rest.indexOf(p) + 1 : -1))].filter(i => i >= 0);
    const end = pos + (ends.length ? Math.min(...ends) : rest.length);
    const sentence = text.slice(start, end).trim();
    if (sentence && !out.includes(sentence)) out.push(sentence);
    from = end + 1;
  }
  return out;
}

export function findFlags(
  topic: Pick<ParsedTopic, 'material' | 'extended' | 'clinical' | 'objectives' | 'keyPoints' | 'revision'>,
  questions: Pick<ParsedQuestion, 'stem' | 'explanation' | 'options'>[] = [],
): FoundFlag[] {
  const out: FoundFlag[] = [];
  const add = (where: string, location: FlagLocation, text: string) => {
    for (const excerpt of flaggedSentences(text)) out.push({ id: sha(`${where}|${excerpt}`).slice(0, 12), where, location, excerpt });
  };
  const partName = { material: 'Notes', extended: 'Extended', clinical: 'Clinical correlation' } as const;
  for (const part of ['material', 'extended', 'clinical'] as const) {
    topic[part].forEach((s, index) => add(`${partName[part]} › ${s.heading}`, { kind: 'section', part, index }, `${s.heading}\n${s.body}`));
  }
  const listName = { objectives: 'Objectives', keyPoints: 'Key points', revision: 'Revision' } as const;
  for (const part of ['objectives', 'keyPoints', 'revision'] as const) {
    topic[part].forEach((item, index) => add(`${listName[part]} #${index + 1}`, { kind: 'list', part, index }, item));
  }
  questions.forEach((q, questionIndex) => {
    add(`Question ${questionIndex + 1} · question`, { kind: 'question', questionIndex, field: 'stem' }, q.stem);
    add(`Question ${questionIndex + 1} · explanation`, { kind: 'question', questionIndex, field: 'explanation' }, q.explanation);
    q.options.forEach((o, optionIndex) => add(`Question ${questionIndex + 1} · option ${'ABCDE'[optionIndex]}`, { kind: 'question', questionIndex, field: 'option', optionIndex }, o));
  });
  return out;
}

/** The text after a reviewer resolves a flag on `excerpt`. */
export function resolveIn(text: string, excerpt: string, action: 'confirm' | 'correct' | 'remove', replacement?: string): string | null {
  const at = text.indexOf(excerpt);
  if (at < 0) return null;
  const next =
    action === 'confirm'
      ? excerpt.replace(/\s*⚑\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
      : action === 'correct'
        ? (replacement ?? '').trim()
        : '';
  return (text.slice(0, at) + next + text.slice(at + excerpt.length)).replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
