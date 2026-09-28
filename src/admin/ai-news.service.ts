import Anthropic from '@anthropic-ai/sdk';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ContentStatus } from '../common/enum/content-status.enum';
import { NEWS_CATEGORIES, NewsArticle, NewsArticleDocument } from '../news/news.schema';
import {
  DEFAULT_NEWS_SOURCES,
  NewsSeenLink,
  NewsSeenLinkDocument,
  NewsSource,
  NewsSourceDocument,
} from '../news/news-source.schema';
import {
  Candidate,
  articleText,
  extractLinks,
  feedLinkOf,
  fetchPage,
  isPublicWebUrl,
  looksLikeFeed,
  normaliseUrl,
  parseFeed,
  sameSite,
} from '../news/web-page';
import { AuditService } from './audit/audit.service';
import { NewsSourceInputDto } from './dto/admin.dto';
import type { Staff } from './staff.guard';

/** Summarising public news is simple work — a fast, cheaper model is plenty. */
const MODEL = 'claude-sonnet-5';

const num = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Ignore stories older than this (days). */
const MAX_AGE_DAYS = () => num(process.env.NEWS_MAX_AGE_DAYS, 14);
/**
 * At most NEWS_LIMIT AI stories in any NEWS_LIMIT_HOURS window (default: 4
 * every 48 hours), however often checks run — timer, cron job or "Check now".
 * Stories count when they are found, even if an admin later discards them.
 */
const LIMIT = () => num(process.env.NEWS_LIMIT, 4);
const LIMIT_HOURS = () => num(process.env.NEWS_LIMIT_HOURS, 48) || 48;
/** New stories per source per run, so one busy site can't take every slot. */
const PER_SOURCE = () => num(process.env.NEWS_PER_SOURCE, 2);
/** How often the built-in scheduler runs (hours); 0 turns it off. */
const EVERY_HOURS = () => num(process.env.NEWS_FETCH_EVERY_HOURS, 48);
/** Links shown to the AI per source per run. */
const MAX_CANDIDATES = 80;

export interface NewsSourceRef {
  name: string;
  url: string;
  institution?: string;
}

export interface ArticleForWriter {
  url: string;
  title?: string;
  text: string;
  publishedAt?: Date;
}

export interface StoryDraft {
  relevant: boolean;
  title: string;
  summary: string;
  body: string[];
  category: (typeof NEWS_CATEGORIES)[number];
  institution: string;
  /** ISO date from the article text, or '' when it doesn't say. */
  publishedDate: string;
}

/** The AI part, separate so tests can swap it for a fake. */
export interface NewsWriter {
  /** Indexes (into `candidates`) of links worth reading, best first. */
  pick(source: NewsSourceRef, candidates: Candidate[], max: number): Promise<number[]>;
  write(source: NewsSourceRef, article: ArticleForWriter): Promise<StoryDraft>;
}

const AUDIENCE = `EdMira is a study app for Nigerian university students in medicine, dentistry, nursing, pharmacy, medical laboratory science, radiography, physiotherapy, public health, anatomy, physiology, biochemistry, pharmacology and related health programmes.`;

const PICK_SCHEMA = {
  type: 'object',
  properties: { picks: { type: 'array', items: { type: 'integer' } } },
  required: ['picks'],
  additionalProperties: false,
} as const;

const PICK_SYSTEM = `${AUDIENCE}

You screen links from a trusted official or reputable website to find recent NEWS that these students would want on their app's campus news feed:
- admissions, post-UTME/screening, matriculation, academic calendars, resumption, strikes (ASUU, JOHESU, NARD) and closures;
- professional and licensing exams, induction, internship/housemanship and NYSC postings, accreditation of programmes and schools;
- scholarships, grants, competitions and fellowships open to students;
- public-health alerts and outbreaks (Lassa fever, cholera, meningitis, mpox…), drug alerts and recalls, vaccination campaigns;
- national health policies and regulator announcements that affect students or new health workers.

Ignore navigation and menu links, generic pages (about, services, contact), tenders and procurement, staff vacancies for senior officers, photo galleries, and anything that is not a dated news item or announcement. When in doubt, leave it out. Return the index numbers of the best links only.`;

const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    relevant: { type: 'boolean' },
    title: { type: 'string' },
    summary: { type: 'string' },
    body: { type: 'array', items: { type: 'string' } },
    category: { type: 'string', enum: [...NEWS_CATEGORIES] },
    institution: { type: 'string' },
    publishedDate: { type: 'string' },
  },
  required: ['relevant', 'title', 'summary', 'body', 'category', 'institution', 'publishedDate'],
  additionalProperties: false,
} as const;

const WRITE_SYSTEM = `${AUDIENCE}

You turn one news article from a trusted website into a short campus-news story for the app. An editor checks it before students see it.

Rules:
- Use ONLY facts stated in the article text you are given. Never add dates, figures, names, deadlines or advice that are not in the text. If the text is too thin or unclear to summarise accurately, set relevant to false.
- Set relevant to false if the article is not useful news for these students (see the kinds of news below), is an old story, or is a menu/listing page rather than an article.
- title: a clear, neutral headline (max 90 characters). No clickbait, no ALL CAPS.
- summary: one or two plain sentences (max 220 characters) saying what happened and why it matters to students.
- body: 2–4 short paragraphs in your own words (do not copy long passages), keeping key facts such as dates, deadlines, eligibility and where to apply. Mention the source organisation.
- category: admissions (admissions, screening, matriculation), exams (licensing/professional exams, results, induction), scholarships (scholarships, grants, competitions), calendar (resumption, holidays, strikes, closures, internship/NYSC postings), clinical (public-health alerts, outbreaks, drug alerts, health policy), general (anything else).
- institution: the university or college the story is specifically about, or '' if none.
- publishedDate: the article's publication date as YYYY-MM-DD if the text states it, otherwise ''.

Useful news includes admissions and academic calendars, strikes, licensing exams and internships, scholarships, public-health alerts and outbreaks, drug alerts, and regulator or policy announcements that affect health students.`;

/** Claude-backed writer. Structured outputs guarantee the JSON shape. */
class ClaudeNewsWriter implements NewsWriter {
  constructor(private readonly client: Anthropic) {}

  private async ask<T>(system: string, prompt: string, schema: { [key: string]: unknown }): Promise<T> {
    const response = await this.client.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 8000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
        system,
        messages: [{ role: 'user', content: prompt }],
      })
      .finalMessage();
    if (response.stop_reason === 'refusal') throw new Error('The AI declined this item.');
    if (response.stop_reason === 'max_tokens') throw new Error('The AI ran out of room.');
    const text = response.content.map(b => (b.type === 'text' ? b.text : '')).join('');
    return JSON.parse(text) as T;
  }

  async pick(source: NewsSourceRef, candidates: Candidate[], max: number) {
    const list = candidates
      .map((c, i) =>
        [
          `${i}. ${c.title}`,
          `   ${c.url}`,
          c.publishedAt && `   published ${c.publishedAt.toISOString().slice(0, 10)}`,
          c.description && `   ${c.description}`,
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n');
    const prompt = `Source: ${source.name} (${source.url})\nToday: ${new Date().toISOString().slice(0, 10)}\n\nLinks:\n${list}\n\nPick at most ${max} links.`;
    const { picks } = await this.ask<{ picks: number[] }>(PICK_SYSTEM, prompt, PICK_SCHEMA);
    return [...new Set(picks)].filter(i => Number.isInteger(i) && i >= 0 && i < candidates.length).slice(0, max);
  }

  async write(source: NewsSourceRef, article: ArticleForWriter) {
    const prompt = [
      `Source: ${source.name}${source.institution ? ` (${source.institution})` : ''}`,
      `Article address: ${article.url}`,
      `Today: ${new Date().toISOString().slice(0, 10)}`,
      article.publishedAt && `Page metadata says published: ${article.publishedAt.toISOString().slice(0, 10)}`,
      article.title && `Page title: ${article.title}`,
      `Article text:\n"""\n${article.text}\n"""`,
    ]
      .filter(Boolean)
      .join('\n');
    return this.ask<StoryDraft>(WRITE_SYSTEM, prompt, WRITE_SCHEMA);
  }
}

export interface NewsRunReport {
  startedAt: string;
  finishedAt: string;
  sourcesChecked: number;
  added: number;
  published: number;
  skipped: number;
  errors: { source: string; message: string }[];
  /** True when the run did nothing because the story limit was already used up. */
  limitReached: boolean;
  limit: NewsLimit;
}

export interface NewsLimit {
  max: number;
  windowHours: number;
  /** AI stories found in the current window (after this run). */
  used: number;
  /** When the next slot frees up, if the limit is used up. */
  nextSlotAt: string | null;
}

const presentSource = (s: NewsSourceDocument) => ({
  id: s.id,
  name: s.name,
  url: s.url,
  institution: s.institution ?? '',
  enabled: s.enabled,
  autoPublish: s.autoPublish,
  lastCheckedAt: s.lastCheckedAt?.toISOString() ?? null,
  lastAdded: s.lastAdded ?? 0,
  lastError: s.lastError ?? '',
});

/**
 * AI news: reads a list of trusted sites every day, lets Claude choose the
 * stories that matter to health students and summarise them from the page
 * text, and saves them as drafts on the News page (or publishes them for
 * sources marked auto-publish). Every story links to its original.
 *
 * Needs ANTHROPIC_API_KEY. At most NEWS_LIMIT stories per NEWS_LIMIT_HOURS
 * (default 4 per 48h). Runs on a timer (NEWS_FETCH_EVERY_HOURS, default
 * 48), from the dashboard's "Fetch now" button, or `yarn news:fetch`.
 */
@Injectable()
export class AiNewsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('AiNews');
  private writer?: NewsWriter;
  private fetchImpl: typeof fetch = fetch;
  private running = false;
  private timer?: NodeJS.Timeout;
  private lastRun?: NewsRunReport;

  constructor(
    @InjectModel(NewsArticle.name) private readonly news: Model<NewsArticleDocument>,
    @InjectModel(NewsSource.name) private readonly sources: Model<NewsSourceDocument>,
    @InjectModel(NewsSeenLink.name) private readonly seen: Model<NewsSeenLinkDocument>,
    private readonly audit: AuditService,
  ) {
    if (process.env.ANTHROPIC_API_KEY) this.writer = new ClaudeNewsWriter(new Anthropic());
  }

  /** Tests: swap in a fake AI and/or network. */
  useForTesting(writer?: NewsWriter, fetchImpl?: typeof fetch) {
    this.writer = writer;
    if (fetchImpl) this.fetchImpl = fetchImpl;
  }

  get enabled() {
    return !!this.writer;
  }

  onModuleInit() {
    const hours = EVERY_HOURS();
    if (!this.enabled || hours <= 0 || process.env.NODE_ENV === 'test') return;
    // Check every 30 minutes whether a run is due; survives restarts because
    // "due" is based on when sources were last checked.
    this.timer = setInterval(() => void this.runIfDue(hours), 30 * 60_000);
    this.timer.unref();
    setTimeout(() => void this.runIfDue(hours), 60_000).unref();
    this.logger.log(`Automatic news fetch every ${hours}h is on.`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async runIfDue(hours: number) {
    if (this.running) return;
    const latest = await this.sources.findOne({ enabled: true }).sort({ lastCheckedAt: -1 }).exec();
    if (!latest) return;
    const due = !latest.lastCheckedAt || Date.now() - latest.lastCheckedAt.getTime() >= hours * 3600_000;
    if (!due) return;
    try {
      const report = await this.run();
      this.logger.log(`News fetch: ${report.added} new stor${report.added === 1 ? 'y' : 'ies'} from ${report.sourcesChecked} sources.`);
    } catch (error) {
      this.logger.warn(`News fetch failed: ${(error as Error).message}`);
    }
  }

  // ── Sources ──

  async status() {
    const list = await this.sources.find().sort({ name: 1 }).exec();
    return {
      enabled: this.enabled,
      running: this.running,
      everyHours: EVERY_HOURS(),
      limit: await this.limit(),
      lastRun: this.lastRun ?? null,
      sources: list.map(presentSource),
    };
  }

  async addDefaults(staff: Staff) {
    const existing = new Set((await this.sources.find().select('url').exec()).map(s => normaliseUrl(s.url)));
    const fresh = DEFAULT_NEWS_SOURCES.filter(s => !existing.has(normaliseUrl(s.url)));
    if (fresh.length) await this.sources.insertMany(fresh.map(s => ({ ...s, enabled: true, autoPublish: false })));
    await this.audit.log(staff, 'news', 'sources', 'added sources', `Added ${fresh.length} suggested news sources`);
    return this.status();
  }

  async saveSource(staff: Staff, input: NewsSourceInputDto, id?: string) {
    const name = input.name?.trim();
    const url = input.url?.trim();
    if (!name) throw new BadRequestException('Give the source a name.');
    if (!url || !isPublicWebUrl(url)) throw new BadRequestException('Source address must be a public web address (https://…).');
    const fields = {
      name,
      url,
      institution: input.institution?.trim() || undefined,
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(input.autoPublish !== undefined && { autoPublish: input.autoPublish }),
    };
    const clash = await this.sources.findOne({ url, ...(id && { _id: { $ne: id } }) }).exec();
    if (clash) throw new ConflictException(`That address is already a source (“${clash.name}”).`);
    let doc: NewsSourceDocument;
    if (id) {
      const found = await this.sources.findById(id).exec();
      if (!found) throw new NotFoundException('That source no longer exists.');
      found.set(fields);
      if (!input.institution?.trim()) found.set('institution', undefined);
      doc = await found.save();
    } else {
      doc = await this.sources.create({ enabled: true, autoPublish: false, ...fields });
    }
    await this.audit.log(staff, 'news', doc.id, id ? 'edited source' : 'added source', `${id ? 'Edited' : 'Added'} news source “${doc.name}”`);
    return presentSource(doc);
  }

  async deleteSource(staff: Staff, id: string) {
    const doc = await this.sources.findByIdAndDelete(id).exec();
    if (!doc) throw new NotFoundException('That source no longer exists.');
    await this.audit.log(staff, 'news', id, 'removed source', `Removed news source “${doc.name}”`);
    return { deleted: true };
  }

  // ── Fetching ──

  /** "Fetch now" on the dashboard. */
  async runNow(staff: Staff) {
    if (!this.writer) {
      throw new ServiceUnavailableException('AI news is off on this server (ANTHROPIC_API_KEY is not set).');
    }
    if (this.running) throw new ConflictException('A news fetch is already running. Try again in a few minutes.');
    const report = await this.run();
    await this.audit.log(
      staff,
      'news',
      'fetch',
      'fetched news',
      report.limitReached
        ? `Checked news: limit of ${report.limit.max} stories per ${report.limit.windowHours}h already reached`
        : `Fetched news: ${report.added} new stor${report.added === 1 ? 'y' : 'ies'} from ${report.sourcesChecked} sources`,
    );
    return report;
  }

  /** How much of the story limit the current window has used. */
  private async limit(): Promise<NewsLimit> {
    const windowMs = LIMIT_HOURS() * 3600_000;
    const recent = await this.news
      .find({ origin: 'ai', createdAt: { $gte: new Date(Date.now() - windowMs) } })
      .sort({ createdAt: 1 })
      .select('createdAt')
      .exec();
    const max = LIMIT();
    // The slot that frees up first belongs to the oldest story that has to age out.
    const blocking = recent.length >= max ? recent[recent.length - max] : undefined;
    return {
      max,
      windowHours: LIMIT_HOURS(),
      used: recent.length,
      nextSlotAt: blocking?.createdAt ? new Date(blocking.createdAt.getTime() + windowMs).toISOString() : null,
    };
  }

  /** Check enabled sources (least recently checked first) until the story limit is reached. */
  async run(): Promise<NewsRunReport> {
    if (!this.writer) throw new ServiceUnavailableException('AI news is off (ANTHROPIC_API_KEY is not set).');
    if (this.running) throw new ConflictException('A news fetch is already running.');
    this.running = true;
    const startedAt = new Date().toISOString();
    const before = await this.limit().catch(error => {
      this.running = false;
      throw error;
    });
    const budget = Math.max(0, before.max - before.used);
    const report: NewsRunReport = {
      startedAt, finishedAt: startedAt, sourcesChecked: 0, added: 0, published: 0, skipped: 0, errors: [],
      limitReached: budget === 0, limit: before,
    };
    try {
      // Limit used up: don't read any site or call the AI.
      const list = budget ? await this.sources.find({ enabled: true }).sort({ lastCheckedAt: 1 }).exec() : [];
      for (const source of list) {
        if (report.added >= budget) break;
        report.sourcesChecked++;
        try {
          const result = await this.checkSource(source, Math.min(PER_SOURCE(), budget - report.added));
          report.added += result.added;
          report.published += result.published;
          report.skipped += result.skipped;
          source.set({ lastCheckedAt: new Date(), lastAdded: result.added, lastError: undefined });
        } catch (error) {
          if (error instanceof Anthropic.AuthenticationError) throw new ServiceUnavailableException('The AI key on the server is invalid.');
          const message = (error as Error).message?.slice(0, 300) || 'Unknown error';
          report.errors.push({ source: source.name, message });
          source.set({ lastCheckedAt: new Date(), lastAdded: 0, lastError: message });
        }
        await source.save();
      }
      if (report.added) report.limit = await this.limit();
    } finally {
      this.running = false;
      report.finishedAt = new Date().toISOString();
      this.lastRun = report;
    }
    return report;
  }

  private async candidatesOf(source: NewsSourceDocument): Promise<Candidate[]> {
    const page = await fetchPage(source.url, this.fetchImpl);
    if (looksLikeFeed(page)) return parseFeed(page.body, page.url);
    const feedUrl = feedLinkOf(page.body, page.url);
    if (feedUrl && sameSite(feedUrl, source.url)) {
      try {
        const feed = await fetchPage(feedUrl, this.fetchImpl);
        const items = looksLikeFeed(feed) ? parseFeed(feed.body, feed.url) : [];
        if (items.length) return items;
      } catch {
        /* fall back to the page's links */
      }
    }
    return extractLinks(page.body, page.url);
  }

  private async checkSource(source: NewsSourceDocument, budget: number) {
    const result = { added: 0, published: 0, skipped: 0 };
    if (budget <= 0) return result;
    const ref: NewsSourceRef = { name: source.name, url: source.url, institution: source.institution };
    const oldest = Date.now() - MAX_AGE_DAYS() * 86_400_000;

    const found = (await this.candidatesOf(source)).filter(c => sameSite(c.url, source.url));
    if (!found.length) {
      throw new Error('No news links found on this page (it may load its content with JavaScript). Try the site’s news page or RSS feed.');
    }
    const all = found.filter(c => !c.publishedAt || c.publishedAt.getTime() >= oldest);
    const urls = all.map(c => c.url);
    const [seenLinks, known] = await Promise.all([
      this.seen.find({ url: { $in: urls } }).select('url').exec(),
      this.news.find({ sourceUrl: { $in: urls } }).select('sourceUrl').exec(),
    ]);
    const skip = new Set([...seenLinks.map(s => s.url), ...known.map(n => n.sourceUrl!)]);
    const fresh = all.filter(c => !skip.has(c.url)).slice(0, MAX_CANDIDATES);
    if (!fresh.length) return result;

    const picks = await this.writer!.pick(ref, fresh, budget);
    // Remember everything we showed the AI so tomorrow only new links are sent.
    await this.seen.insertMany(fresh.map(c => ({ url: c.url, seenAt: new Date() })), { ordered: false }).catch(() => undefined);

    const recentTitles = new Set(
      (await this.news.find({ publishedAt: { $gte: new Date(Date.now() - 30 * 86_400_000) } }).select('title').exec()).map(n =>
        n.title.trim().toLowerCase(),
      ),
    );

    for (const index of picks) {
      if (result.added >= budget) break;
      const candidate = fresh[index];
      try {
        const page = await fetchPage(candidate.url, this.fetchImpl);
        if (!sameSite(page.url, source.url)) {
          result.skipped++;
          continue;
        }
        const article = articleText(page.body);
        if (article.text.length < 200) {
          result.skipped++;
          continue;
        }
        const draft = await this.writer!.write(ref, {
          url: page.url,
          title: article.title ?? candidate.title,
          text: article.text,
          publishedAt: article.publishedAt ?? candidate.publishedAt,
        });
        const story = this.clean(draft);
        if (!story) {
          result.skipped++;
          continue;
        }
        const date = this.storyDate(draft.publishedDate, article.publishedAt ?? candidate.publishedAt);
        if (date.getTime() < oldest || recentTitles.has(story.title.toLowerCase())) {
          result.skipped++;
          continue;
        }
        const publish = source.autoPublish;
        await this.news.create({
          ...story,
          institution: source.institution || story.institution || undefined,
          source: source.name,
          sourceUrl: normaliseUrl(page.url),
          imageUrl: article.imageUrl,
          publishedAt: publish ? new Date() : date,
          status: publish ? ContentStatus.PUBLISHED : ContentStatus.DRAFT,
          origin: 'ai',
          sourceId: new Types.ObjectId(source.id),
          createdByName: `AI · ${source.name}`,
          isSample: false,
        });
        recentTitles.add(story.title.toLowerCase());
        result.added++;
        if (publish) result.published++;
      } catch (error) {
        if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.RateLimitError) throw error;
        result.skipped++;
        this.logger.debug(`Skipped ${candidate.url}: ${(error as Error).message}`);
      }
    }
    return result;
  }

  /** Validate the AI's story; undefined = don't use it. */
  private clean(draft: StoryDraft) {
    if (!draft?.relevant) return undefined;
    const title = draft.title?.trim().slice(0, 200);
    const summary = draft.summary?.trim().slice(0, 500);
    const body = (draft.body ?? []).map(p => p?.trim()).filter(Boolean).slice(0, 8).map(p => p.slice(0, 5000));
    if (!title || !summary || !body.length) return undefined;
    const category = (NEWS_CATEGORIES as readonly string[]).includes(draft.category) ? draft.category : 'general';
    return { title, summary, body, category, institution: draft.institution?.trim().slice(0, 120) || '' };
  }

  /** The story's date: from the article, never in the future. */
  private storyDate(fromText: string, fromPage?: Date) {
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(fromText ?? '') ? new Date(`${fromText}T08:00:00Z`) : fromPage;
    const now = new Date();
    return parsed && !Number.isNaN(parsed.getTime()) && parsed <= now ? parsed : now;
  }
}
