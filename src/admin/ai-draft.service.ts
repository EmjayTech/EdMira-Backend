import Anthropic from '@anthropic-ai/sdk';
import {
  BadGatewayException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ContentStatus } from '../common/enum/content-status.enum';
import { Course, CourseDocument } from '../content/schemas/course.schema';
import { Question, QuestionDocument } from '../content/schemas/question.schema';
import { Topic, TopicDocument } from '../content/schemas/topic.schema';
import { adminQuestion } from './admin.presenter';
import { AuditService } from './audit/audit.service';
import type { Staff } from './staff.guard';
import { questionProblems } from './workflow';

const MODEL = 'claude-opus-5';

/** JSON schema the model's answer must match (structured outputs). */
const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          stem: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          answerIndex: { type: 'integer' },
          explanation: { type: 'string' },
        },
        required: ['stem', 'options', 'answerIndex', 'explanation'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
} as const;

const SYSTEM = `You write multiple-choice practice questions for EdMira, a study app for Nigerian medical and health-science students (MBBS, BDS, nursing, pharmacy, medical laboratory science, physiotherapy, radiography, public health and related programmes).

Each question:
- tests one clear, examinable fact or concept from the topic, at the level of a Nigerian university professional exam;
- has exactly 5 options (A–E), one unambiguously correct answer, and plausible distractors of similar length and style;
- avoids "all of the above", "none of the above", negatives you would need to capitalise, and trick wording;
- has an explanation of 1–3 sentences saying why the answer is right and, where useful, why a tempting distractor is wrong.

Follow standard textbooks (e.g. Snell, Guyton & Hall, Lippincott, Katzung, Robbins, Park) and current Nigerian/WHO guidance where it matters. Use Nigerian context (drug names, diseases, national programmes) where natural. A medical reviewer will check every question before students see it, so accuracy matters more than cleverness — if unsure of a fact, pick a different fact.`;

/**
 * "Draft with AI": Claude writes practice questions for a topic from its study
 * notes. Drafts go to the review queue credited to "AI draft", so any
 * reviewer — including the person who asked — can approve or reject them.
 * Needs ANTHROPIC_API_KEY; without it the feature reports itself as off.
 */
@Injectable()
export class AiDraftService {
  private client?: Anthropic;

  constructor(
    @InjectModel(Course.name) private readonly courses: Model<CourseDocument>,
    @InjectModel(Topic.name) private readonly topics: Model<TopicDocument>,
    @InjectModel(Question.name) private readonly questions: Model<QuestionDocument>,
    private readonly audit: AuditService,
  ) {
    if (process.env.ANTHROPIC_API_KEY) this.client = new Anthropic();
  }

  get enabled() {
    return !!this.client;
  }

  async draftQuestions(staff: Staff, topicId: string, count: number, focus?: string) {
    if (!this.client) {
      throw new ServiceUnavailableException('AI drafting is off on this server (ANTHROPIC_API_KEY is not set).');
    }
    const topic = await this.topics.findById(topicId).exec();
    if (!topic) throw new NotFoundException('That topic no longer exists.');
    const course = await this.courses.findById(topic.courseId).exec();
    const existing = await this.questions
      .find({ topicId: topic._id, status: { $ne: ContentStatus.ARCHIVED } })
      .select('stem')
      .exec();

    const notes = topic.material
      .map(s => `## ${s.heading}\n${s.body}${s.keyPoints?.length ? `\nKey points: ${s.keyPoints.join('; ')}` : ''}`)
      .join('\n\n');
    const audience = (course?.audience ?? [])
      .map(r => [r.level, r.department, r.institution].filter(Boolean).join(' · '))
      .join('; ');
    const prompt = [
      `Course: ${course?.title ?? 'Unknown'}${audience ? ` (for: ${audience})` : ''}`,
      `Topic: ${topic.title}`,
      topic.summary && `Summary: ${topic.summary}`,
      notes ? `Study notes:\n${notes}` : 'There are no study notes yet — use the standard curriculum for this topic.',
      existing.length &&
        `Questions that already exist (do not repeat or closely paraphrase them):\n${existing.map(q => `- ${q.stem}`).join('\n')}`,
      focus && `Reviewer's request: ${focus}`,
      `Write ${count} new question${count > 1 ? 's' : ''}.`,
    ]
      .filter(Boolean)
      .join('\n\n');

    let text: string;
    try {
      const response = await this.client.beta.messages
        .stream({
          model: MODEL,
          max_tokens: 32000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          thinking: { type: 'adaptive' },
          output_config: {
            effort: 'high',
            format: { type: 'json_schema', schema: DRAFT_SCHEMA },
          },
          system: SYSTEM,
          messages: [{ role: 'user', content: prompt }],
        })
        .finalMessage();
      if (response.stop_reason === 'refusal') {
        throw new BadGatewayException('The AI declined to write questions for this topic. Try a different focus.');
      }
      if (response.stop_reason === 'max_tokens') {
        throw new BadGatewayException('The AI ran out of room. Ask for fewer questions at a time.');
      }
      text = response.content.map(b => (b.type === 'text' ? b.text : '')).join('');
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      if (error instanceof Anthropic.RateLimitError) {
        throw new ServiceUnavailableException('The AI service is busy. Try again in a minute.');
      }
      if (error instanceof Anthropic.AuthenticationError) {
        throw new ServiceUnavailableException('The AI key on the server is invalid. Ask an admin to check ANTHROPIC_API_KEY.');
      }
      if (error instanceof Anthropic.APIError) {
        throw new BadGatewayException(`The AI service failed (${error.status ?? 'network'}). Try again.`);
      }
      throw error;
    }

    let drafts: { stem: string; options: string[]; answerIndex: number; explanation: string }[];
    try {
      drafts = JSON.parse(text).questions;
    } catch {
      throw new BadGatewayException('The AI returned something unreadable. Try again.');
    }

    const seen = new Set(existing.map(q => q.stem.trim().toLowerCase()));
    const usable = drafts.filter(d => {
      const key = d.stem?.trim().toLowerCase();
      if (!key || seen.has(key) || questionProblems(d).length) return false;
      seen.add(key);
      return true;
    });
    const created = usable.length
      ? await this.questions.insertMany(
          usable.map(d => ({
            topicId: topic._id,
            stem: d.stem.trim(),
            options: d.options.map(o => o.trim()),
            answerIndex: d.answerIndex,
            explanation: d.explanation?.trim() || undefined,
            status: ContentStatus.IN_REVIEW,
            createdByName: `AI draft (asked by ${staff.name})`,
          })),
        )
      : [];
    await this.audit.log(
      staff,
      'topic',
      topic.id,
      'ai drafted',
      `Asked AI for ${count} question${count > 1 ? 's' : ''} on “${topic.title}” — ${created.length} sent to review`,
    );
    return {
      requested: count,
      created: created.length,
      questions: created.map(q => adminQuestion(q as QuestionDocument)),
      /** Repeats of existing questions or malformed drafts, dropped. */
      skipped: drafts.length - created.length,
    };
  }
}
