import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHmac, timingSafeEqual } from 'crypto';
import { Model } from 'mongoose';
import { join, resolve } from 'path';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import { ContentStatus } from '../common/enum/content-status.enum';
import { ContentService } from './content.service';
import { Course, CourseDocument } from './schemas/course.schema';
import { MaterialSection, Topic, TopicDocument, TopicFigure } from './schemas/topic.schema';
import { TopicVersionsService } from './topic-versions.service';

const LINK_TTL_SECONDS = 15 * 60;
const FONTS = resolve(__dirname, '..', '..', 'assets', 'fonts');
const PUBLISHED = ContentStatus.PUBLISHED;

export type NotesScope = 'topic' | 'course';

/** Same shape as a study-material download, so the app saves it like one. */
export interface NotesDownload {
  url: string;
  name: string;
  mimeType: 'application/pdf';
  /** Unknown until generated. */
  size: 0;
  expiresAt: string;
}

const COLORS = { text: '#111827', muted: '#6B7280', brand: '#0A369D', rule: '#E5E7EB', keyBg: '#EEF2FF', callout: '#FFF7ED', calloutRule: '#F26B1D' };

type Figures = Map<string, { figure: TopicFigure; mimeType: string; data: Buffer }>;

/** "Nucleotides, Nucleic Acids & Vitamins" → "Nucleotides_Nucleic_Acids_Vitamins" */
const fileSafe = (text: string) =>
  text.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'EdMira';

/**
 * Downloadable study notes: a PDF of a topic's notes (or all of a course's
 * published topics), built on request from the same notes students read in
 * the app — so it's always current and needs no file storage. Links are
 * signed and last 15 minutes, like uploaded materials.
 */
@Injectable()
export class NotesPdfService {
  private readonly secret = process.env.JWT_SECRET ?? 'edmira-files';

  constructor(
    private readonly content: ContentService,
    @InjectModel(Course.name) private readonly courses: Model<CourseDocument>,
    @InjectModel(Topic.name) private readonly topics: Model<TopicDocument>,
    private readonly versions: TopicVersionsService,
  ) {}

  private sign(scope: NotesScope, id: string, expires: number) {
    return createHmac('sha256', this.secret).update(`notes:${scope}:${id}:${expires}`).digest('hex');
  }

  verify(scope: NotesScope, id: string, expires: number, sig: string) {
    if (!Number.isFinite(expires) || expires < Date.now() / 1000) return false;
    const expected = Buffer.from(this.sign(scope, id, expires));
    const given = Buffer.from(sig ?? '');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private link(scope: NotesScope, id: string, title: string, baseUrl: string): NotesDownload {
    const expires = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
    const name = `${fileSafe(title)}_notes.pdf`;
    return {
      url: `${baseUrl}/api/v1/notes/${scope}/${id}?exp=${expires}&sig=${this.sign(scope, id, expires)}`,
      name,
      mimeType: 'application/pdf',
      size: 0,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }

  async topicLink(topicId: string, baseUrl: string) {
    const { topic } = await this.content.findVisibleTopic(topicId);
    if (!topic.material?.length) throw new NotFoundException('This topic has no notes yet.');
    return this.link('topic', topic.id, topic.title, baseUrl);
  }

  async courseLink(courseId: string, baseUrl: string) {
    const course = await this.courses.findOne({ _id: courseId, status: PUBLISHED }).exec();
    if (!course) throw new NotFoundException('Course not found');
    const count = await this.topics.countDocuments({ courseId: course._id, status: PUBLISHED, 'material.0': { $exists: true } });
    if (!count) throw new NotFoundException('This course has no notes yet.');
    return this.link('course', course.id, course.title, baseUrl);
  }

  /** Builds the PDF for a verified link. */
  async build(scope: NotesScope, id: string): Promise<{ name: string; doc: PDFKit.PDFDocument }> {
    let course: CourseDocument;
    let topics: TopicDocument[];
    if (scope === 'topic') {
      const found = await this.content.findVisibleTopic(id);
      course = found.course;
      topics = [found.topic];
    } else {
      const found = await this.courses.findOne({ _id: id, status: PUBLISHED }).exec();
      if (!found) throw new NotFoundException('Course not found');
      course = found;
      topics = await this.topics.find({ courseId: course._id, status: PUBLISHED }).sort({ order: 1 }).exec();
    }
    topics = topics.filter(t => t.material?.length);
    if (!topics.length) throw new NotFoundException('No notes yet.');
    const title = scope === 'topic' ? topics[0].title : course.title;
    // Figure images, loaded before drawing (pdfkit draws synchronously).
    const figures: Figures = new Map();
    for (const t of topics) {
      for (const f of t.figures ?? []) {
        const asset = await this.versions.asset(f.assetId).catch(() => null);
        if (asset) figures.set(`${t.id}:${f.key}`, { figure: f, ...asset });
      }
    }
    return { name: `${fileSafe(title)}_notes.pdf`, doc: this.render(course, topics, scope, figures) };
  }

  private render(course: CourseDocument, topics: TopicDocument[], scope: NotesScope, figures: Figures = new Map()) {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 56, bottom: 64, left: 56, right: 56 },
      bufferPages: true,
      info: {
        Title: scope === 'topic' ? `${topics[0].title} — notes` : `${course.title} — notes`,
        Author: 'EdMira',
        Subject: course.title,
      },
    });
    doc.registerFont('regular', join(FONTS, 'Inter-Regular.ttf'));
    doc.registerFont('semibold', join(FONTS, 'Inter-SemiBold.ttf'));
    doc.registerFont('bold', join(FONTS, 'Inter-Bold.ttf'));
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // Header
    doc.font('semibold').fontSize(9).fillColor(COLORS.brand).text('EDMIRA STUDY NOTES', { characterSpacing: 1 });
    doc.moveDown(0.3);
    // Some course titles already carry their code, e.g. "Biochemistry I (BCH 201)".
    const squash = (t: string) => t.replace(/\s+/g, '').toLowerCase();
    const showCode = course.code && !squash(course.title).includes(squash(course.code));
    doc.font('regular').fontSize(10).fillColor(COLORS.muted).text(`${course.title}${showCode ? ` (${course.code})` : ''}`);
    doc.moveDown(0.6);

    if (scope === 'course') {
      doc.font('bold').fontSize(22).fillColor(COLORS.text).text(course.title);
      if (course.description) doc.moveDown(0.4).font('regular').fontSize(11).fillColor(COLORS.muted).text(course.description);
      doc.moveDown(0.8).font('semibold').fontSize(12).fillColor(COLORS.text).text('Topics');
      doc.moveDown(0.3).font('regular').fontSize(11).fillColor(COLORS.text);
      topics.forEach((t, i) => doc.text(`${i + 1}.  ${t.title}`));
    }

    topics.forEach((topic, ti) => {
      if (scope === 'course') doc.addPage();
      doc.font('bold').fontSize(scope === 'course' ? 18 : 22).fillColor(COLORS.text).text(
        scope === 'course' ? `${ti + 1}. ${topic.title}` : topic.title,
      );
      if (topic.summary) doc.moveDown(0.3).font('regular').fontSize(11).fillColor(COLORS.muted).text(topic.summary);
      doc.moveDown(0.5);
      doc.moveTo(doc.x, doc.y).lineTo(doc.x + width, doc.y).strokeColor(COLORS.rule).lineWidth(1).stroke();
      doc.moveDown(0.8);

      const pdf = { doc, width, figures, topicId: topic.id };
      if (topic.objectives?.length) box(pdf, 'LEARNING OBJECTIVES', topic.objectives, COLORS.keyBg);
      if (topic.keyPoints?.length) box(pdf, 'KEY POINTS', topic.keyPoints, COLORS.keyBg);
      sectionsBlock(pdf, topic.material, null);
      // Extended notes and the clinical correlation are Pro (Part 4 decides who gets them).
      if (topic.extended?.length) sectionsBlock(pdf, topic.extended, 'Extended notes');
      if (topic.clinical?.length) sectionsBlock(pdf, topic.clinical, 'Clinical correlation');
      if (topic.revision?.length) box(pdf, 'QUICK REVISION', topic.revision, COLORS.callout);
      if (topic.furtherReading?.length) {
        doc.font('semibold').fontSize(10).fillColor(COLORS.muted).text('FURTHER READING', { characterSpacing: 0.8 });
        doc.moveDown(0.2).font('regular').fontSize(10).fillColor(COLORS.text);
        for (const r of topic.furtherReading) doc.text(`•  ${r}`, { indent: 8, lineGap: 1.5 });
        doc.moveDown(0.6);
      }
      if (topic.credits?.length) {
        doc.font('regular').fontSize(9).fillColor(COLORS.muted).text(`Notes contributed by ${topic.credits.join(', ')}.`);
        doc.moveDown(0.6);
      }
    });

    // Footer on every page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // Writing inside the bottom margin would otherwise start a new page.
      const margin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const bottom = doc.page.height - margin + 24;
      doc.font('regular').fontSize(8).fillColor(COLORS.muted);
      doc.text('EdMira study notes — for revision. Always check your lecturers’ notes and current guidelines.',
        doc.page.margins.left, bottom, { width: width - 40, lineBreak: false });
      doc.text(`${i + 1} / ${range.count}`, doc.page.margins.left + width - 40, bottom, { width: 40, align: 'right', lineBreak: false });
      doc.page.margins.bottom = margin;
    }
    doc.end();
    return doc;
  }
}

// ── Drawing helpers (a small subset of Markdown: what the note files use) ────

interface Pdf {
  doc: PDFKit.PDFDocument;
  width: number;
  figures: Figures;
  topicId: string;
}

/** Text with **bold** runs. */
function rich(doc: PDFKit.PDFDocument, text: string, opts: PDFKit.Mixins.TextOptions = {}) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  parts.forEach((part, i) => {
    const bold = /^\*\*[^*]+\*\*$/.test(part);
    doc.font(bold ? 'semibold' : 'regular').text(bold ? part.slice(2, -2) : part, { ...opts, continued: i < parts.length - 1 });
  });
}

function box(pdf: Pdf, label: string, items: string[], fill: string) {
  const { doc, width } = pdf;
  const x = doc.x;
  const top = doc.y;
  const inner = width - 24;
  doc.font('regular').fontSize(11);
  const height = 26 + items.reduce((h, t) => h + doc.heightOfString(`•  ${t.replace(/\*\*/g, '')}`, { width: inner - 8 }) + 3, 0);
  if (top + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
  const y = doc.y;
  doc.save().roundedRect(x, y, width, height, 8).fill(fill).restore();
  doc.font('semibold').fontSize(9).fillColor(COLORS.brand).text(label, x + 12, y + 10, { characterSpacing: 0.8, width: inner });
  doc.moveDown(0.3).fontSize(11).fillColor(COLORS.text);
  for (const t of items) {
    rich(doc, `•  ${t}`, { width: inner - 8, indent: 0, lineGap: 1.5 });
    doc.moveDown(0.1);
  }
  doc.x = x;
  doc.y = y + height + 10;
}

function sectionsBlock(pdf: Pdf, sections: MaterialSection[], title: string | null) {
  const { doc } = pdf;
  if (title) {
    doc.moveDown(0.4).font('bold').fontSize(15).fillColor(COLORS.text).text(title);
    doc.moveDown(0.4);
  }
  sections.forEach((section, si) => {
    doc.font('semibold').fontSize(13).fillColor(COLORS.brand).text(`${si + 1}. ${section.heading}`);
    doc.moveDown(0.3);
    body(pdf, section.body);
    if (section.keyPoints?.length) {
      doc.font('semibold').fontSize(10).fillColor(COLORS.muted).text('KEY POINTS', { characterSpacing: 0.8 });
      doc.moveDown(0.2).fontSize(11).fillColor(COLORS.text);
      for (const point of section.keyPoints) rich(doc, `•  ${point}`, { indent: 8, lineGap: 1.5 });
      doc.moveDown(0.6);
    }
    doc.moveDown(0.4);
  });
}

/** Paragraphs, bullet / numbered lists, #### sub-headings, > callouts, | tables | and {{fig:key}}. */
function body(pdf: Pdf, text: string) {
  const { doc, width } = pdf;
  const x = doc.page.margins.left;
  for (const raw of text.split(/\n\s*\n/)) {
    const block = raw.trim();
    if (!block) continue;
    const lines = block.split(/\n/).map(l => l.trimEnd());
    const fig = block.match(/^\{\{fig:([a-z0-9-]+)\}\}$/);
    if (fig) {
      figure(pdf, fig[1]);
      continue;
    }
    doc.fontSize(11).fillColor(COLORS.text);
    if (lines.every(l => /^\s*[-*]\s+/.test(l))) {
      for (const l of lines) rich(doc, `•  ${l.replace(/^\s*[-*]\s+/, '')}`, { indent: /^\s{2,}/.test(l) ? 20 : 8, lineGap: 1.5 });
    } else if (lines.every(l => /^\s*\d+[.)]\s+/.test(l))) {
      for (const l of lines) rich(doc, l.trim(), { indent: 8, lineGap: 1.5 });
    } else if (lines[0].startsWith('#### ')) {
      doc.font('semibold').fontSize(11.5).fillColor(COLORS.text).text(lines[0].slice(5));
      if (lines.length > 1) rich(doc.font('regular').fontSize(11), lines.slice(1).join(' '), { lineGap: 2.5 });
    } else if (lines.every(l => l.startsWith('>'))) {
      const t = lines.map(l => l.replace(/^>\s?/, '')).join(' ');
      doc.font('regular').fontSize(11);
      const h = doc.heightOfString(t.replace(/\*\*/g, ''), { width: width - 28 }) + 16;
      if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
      const y = doc.y;
      doc.save().rect(x, y, width, h).fill(COLORS.callout).rect(x, y, 3, h).fill(COLORS.calloutRule).restore();
      doc.fillColor(COLORS.text);
      doc.x = x + 14;
      doc.y = y + 8;
      rich(doc, t, { width: width - 28, lineGap: 2 });
      doc.x = x;
      doc.y = y + h;
    } else if (lines.every(l => l.trim().startsWith('|'))) {
      table(pdf, lines);
    } else {
      // A paragraph; any {{fig:…}} inside it is drawn after the text.
      const keys = [...block.matchAll(/\{\{fig:([a-z0-9-]+)\}\}/g)].map(m => m[1]);
      const plain = block.replace(/\{\{fig:[a-z0-9-]+\}\}/g, '').replace(/\s*\n\s*/g, ' ').trim();
      if (plain) rich(doc, plain, { align: 'left', lineGap: 2.5 });
      keys.forEach(k => figure(pdf, k));
    }
    doc.moveDown(0.5);
  }
}

function table(pdf: Pdf, lines: string[]) {
  const { doc, width } = pdf;
  const x = doc.page.margins.left;
  const rows = lines
    .filter(l => !/^\s*\|?\s*:?-{3,}/.test(l))
    .map(l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim().replace(/\*\*/g, '')));
  const cols = Math.max(...rows.map(r => r.length));
  const colW = width / cols;
  doc.fontSize(10);
  rows.forEach((row, ri) => {
    const h = Math.max(...row.map(c => doc.heightOfString(c, { width: colW - 10 }))) + 10;
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
    const y = doc.y;
    if (ri === 0) doc.save().rect(x, y, width, h).fill(COLORS.keyBg).restore();
    row.forEach((cell, ci) => {
      doc.font(ri === 0 ? 'semibold' : 'regular').fillColor(COLORS.text).text(cell, x + ci * colW + 5, y + 5, { width: colW - 10 });
    });
    doc.save().moveTo(x, y + h).lineTo(x + width, y + h).strokeColor(COLORS.rule).lineWidth(0.7).stroke().restore();
    doc.x = x;
    doc.y = y + h;
  });
}

/** A numbered figure with its caption and (for others' images) the attribution line. */
function figure(pdf: Pdf, key: string) {
  const { doc, width, figures, topicId } = pdf;
  const found = figures.get(`${topicId}:${key}`);
  if (!found) return;
  const { figure: f, mimeType, data } = found;
  const x = doc.page.margins.left;
  const maxW = Math.min(width, 420);
  let w = maxW;
  let h = 240;
  if (mimeType === 'image/svg+xml') {
    const vb = data.toString('utf8').match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/);
    if (vb) h = (maxW * Number(vb[2])) / Number(vb[1]);
  }
  if (h > 320) {
    w = (w * 320) / h;
    h = 320;
  }
  if (doc.y + h + 40 > doc.page.height - doc.page.margins.bottom) doc.addPage();
  const left = x + (width - w) / 2;
  const top = doc.y + 4;
  try {
    if (mimeType === 'image/svg+xml') SVGtoPDF(doc, data.toString('utf8'), left, top, { width: w, height: h, preserveAspectRatio: 'xMidYMid meet' });
    else if (mimeType === 'image/webp') doc.font('regular').fontSize(9).fillColor(COLORS.muted).text('[Figure available in the app]', left, top + h / 2, { width: w, align: 'center' });
    else doc.image(data, left, top, { fit: [w, h], align: 'center' });
  } catch {
    doc.font('regular').fontSize(9).fillColor(COLORS.muted).text('[Figure available in the app]', left, top + h / 2, { width: w, align: 'center' });
  }
  doc.x = x;
  doc.y = top + h + 6;
  doc.font('semibold').fontSize(9.5).fillColor(COLORS.text).text(`${f.label}. `, { continued: true, width });
  doc.font('regular').text(f.caption, { width });
  if (f.attributionText && !/^original$/i.test(f.licence ?? '')) doc.font('regular').fontSize(8).fillColor(COLORS.muted).text(f.attributionText, { width });
  doc.moveDown(0.6);
}
