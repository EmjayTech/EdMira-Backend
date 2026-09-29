import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHmac, timingSafeEqual } from 'crypto';
import { Model } from 'mongoose';
import { join, resolve } from 'path';
import PDFDocument from 'pdfkit';
import { ContentStatus } from '../common/enum/content-status.enum';
import { ContentService } from './content.service';
import { Course, CourseDocument } from './schemas/course.schema';
import { Topic, TopicDocument } from './schemas/topic.schema';

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

const COLORS = { text: '#111827', muted: '#6B7280', brand: '#0A369D', rule: '#E5E7EB', keyBg: '#EEF2FF' };

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
    return { name: `${fileSafe(title)}_notes.pdf`, doc: this.render(course, topics, scope) };
  }

  private render(course: CourseDocument, topics: TopicDocument[], scope: NotesScope) {
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

      topic.material.forEach((section, si) => {
        doc.font('semibold').fontSize(13).fillColor(COLORS.brand).text(`${si + 1}. ${section.heading}`);
        doc.moveDown(0.3);
        for (const paragraph of section.body.split(/\n\s*\n/)) {
          doc.font('regular').fontSize(11).fillColor(COLORS.text).text(paragraph.trim(), { align: 'left', lineGap: 2.5 });
          doc.moveDown(0.5);
        }
        if (section.keyPoints?.length) {
          doc.font('semibold').fontSize(10).fillColor(COLORS.muted).text('KEY POINTS', { characterSpacing: 0.8 });
          doc.moveDown(0.2);
          doc.font('regular').fontSize(11).fillColor(COLORS.text);
          for (const point of section.keyPoints) {
            doc.text(`•  ${point}`, { indent: 8, lineGap: 1.5 });
          }
          doc.moveDown(0.6);
        }
        doc.moveDown(0.4);
      });
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
