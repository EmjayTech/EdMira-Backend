/**
 * Small, dependency-free helpers the news fetcher uses to read source sites:
 * download a page safely, read RSS/Atom feeds, list a page's links and turn an
 * article into plain text. Nothing here talks to the AI.
 */

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 15_000;
const USER_AGENT = 'EdMiraNewsBot/1.0 (+https://edmira.app; campus news for health students)';

export interface FetchedPage {
  /** Final address after redirects. */
  url: string;
  contentType: string;
  body: string;
}

export interface Candidate {
  title: string;
  url: string;
  /** From the feed, when it has one. */
  publishedAt?: Date;
  description?: string;
}

/** The site part of a host: "www.ncdc.gov.ng" → "ncdc.gov.ng". */
export const siteOf = (host: string) => host.toLowerCase().replace(/^www\./, '');

/** Is `url` on the same site as `sourceUrl` (sub-domains allowed)? */
export function sameSite(url: string, sourceUrl: string): boolean {
  try {
    const a = siteOf(new URL(url).hostname);
    const b = siteOf(new URL(sourceUrl).hostname);
    return a === b || a.endsWith(`.${b}`);
  } catch {
    return false;
  }
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i;

/** Public http(s) address? Keeps the fetcher away from internal services. */
export function isPublicWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !PRIVATE_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

/** Drop fragments and tracking parameters so the same story isn't seen twice. */
export function normaliseUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|ref$)/i.test(key)) url.searchParams.delete(key);
  }
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  return url.toString();
}

/** GET a public page with a timeout and size limit. */
export async function fetchPage(url: string, fetchImpl: typeof fetch = fetch): Promise<FetchedPage> {
  if (!isPublicWebUrl(url)) throw new Error(`Not a public web address: ${url}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.5' },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText || 'error'} from ${url}`);
    const finalUrl = res.url || url;
    if (!isPublicWebUrl(finalUrl)) throw new Error(`Redirected to a non-public address: ${finalUrl}`);
    const contentType = res.headers.get('content-type') ?? '';
    if (/pdf|image\/|video\/|audio\/|zip|octet-stream/i.test(contentType)) {
      throw new Error(`Not a web page (${contentType.split(';')[0]})`);
    }
    const buffer = await res.arrayBuffer();
    const body = new TextDecoder('utf-8').decode(buffer.byteLength > MAX_BYTES ? buffer.slice(0, MAX_BYTES) : buffer);
    return { url: finalUrl, contentType, body };
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error(`Timed out reading ${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', naira: '₦',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

const squash = (text: string) => decodeEntities(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

const unwrapCdata = (text: string) => text.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? unwrapCdata(m[1]) : undefined;
};

const attr = (html: string, name: string) => {
  const m = html.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : undefined;
};

const parseDate = (value?: string) => {
  if (!value) return undefined;
  const d = new Date(value.trim());
  return Number.isNaN(d.getTime()) ? undefined : d;
};

export const looksLikeFeed = (page: FetchedPage) =>
  /xml|rss|atom/i.test(page.contentType) || /^\s*(<\?xml[^>]*>\s*)?<(rss|feed|rdf:RDF)\b/i.test(page.body);

/** Items of an RSS 2.0 or Atom feed. */
export function parseFeed(xml: string, baseUrl: string): Candidate[] {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  const items: Candidate[] = [];
  for (const block of blocks) {
    const title = squash(unwrapCdata(tag(block, 'title') ?? ''));
    let link = tag(block, 'link');
    if (!link || !link.trim()) {
      // Atom: <link rel="alternate" href="…"/>
      const links = block.match(/<link\b[^>]*>/gi) ?? [];
      const alt = links.find(l => !/rel\s*=\s*["'](?!alternate)/i.test(l)) ?? links[0];
      link = alt ? attr(alt, 'href') : undefined;
    }
    if (!title || !link) continue;
    try {
      items.push({
        title,
        url: normaliseUrl(new URL(decodeEntities(link.trim()), baseUrl).toString()),
        publishedAt: parseDate(tag(block, 'pubDate') ?? tag(block, 'published') ?? tag(block, 'updated') ?? tag(block, 'dc:date')),
        // Feed descriptions are often escaped HTML: decode, then strip the tags.
        description: squash(decodeEntities(unwrapCdata(tag(block, 'description') ?? tag(block, 'summary') ?? ''))).slice(0, 400) || undefined,
      });
    } catch {
      /* skip malformed links */
    }
  }
  return items;
}

/** RSS/Atom feed a page advertises in its <head>, if any. */
export function feedLinkOf(html: string, baseUrl: string): string | undefined {
  const links = html.match(/<link\b[^>]*>/gi) ?? [];
  const feed = links.find(l => /rel\s*=\s*["']?alternate/i.test(l) && /type\s*=\s*["']?application\/(rss|atom)\+xml/i.test(l));
  const href = feed && attr(feed, 'href');
  if (!href) return undefined;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return undefined;
  }
}

const SKIP_PATH = /\.(jpe?g|png|gif|webp|svg|pdf|docx?|xlsx?|pptx?|zip|mp3|mp4)(\?|$)|\/(wp-login|login|signin|register|cart|tag|author|feed)\b|\/(about|contact|privacy|terms|faq|careers)\/?$/i;

const isHeadline = (text: string) => text.length >= 20 && text.split(' ').length >= 4;

/** "/news/534/ncdc-calls-for-action-as-lassa-cases-rise" → "ncdc calls for action as lassa cases rise". */
export function slugTitle(url: string): string | undefined {
  let last: string;
  try {
    last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    last = decodeURIComponent(last);
  } catch {
    return undefined;
  }
  const title = squash(last.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[-_+]+/g, ' ')).replace(/\s*\|\s*/g, ' – ');
  return isHeadline(title) && /[a-z]/i.test(title) ? title.slice(0, 200) : undefined;
}

/**
 * Links on a page that could be stories: same site, not files or menu pages,
 * with a headline-length link text. Keeps page order, no duplicates.
 */
export function extractLinks(html: string, baseUrl: string, limit = 120): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const anchors = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? [];
  for (const anchor of anchors) {
    const href = attr(anchor.slice(0, anchor.indexOf('>') + 1), 'href');
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    let url: string;
    try {
      url = normaliseUrl(new URL(href, baseUrl).toString());
    } catch {
      continue;
    }
    // Card-style links wrap only an image: fall back to the headline in the address.
    const text = squash(anchor) || attr(anchor, 'title') || '';
    const title = isHeadline(text) ? text : slugTitle(url);
    if (!title) continue;
    if (!sameSite(url, baseUrl) || SKIP_PATH.test(url) || normaliseUrl(baseUrl) === url || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: title.slice(0, 200), url });
    if (out.length >= limit) break;
  }
  return out;
}

export interface ArticleText {
  title?: string;
  text: string;
  imageUrl?: string;
  /** From page metadata, when present. */
  publishedAt?: Date;
}

const meta = (html: string, key: string) => {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  const found = tags.find(t => new RegExp(`(property|name|itemprop)\\s*=\\s*["']${key}["']`, 'i').test(t));
  return found ? attr(found, 'content') : undefined;
};

const NOISE = /<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)\b[\s\S]*?<\/\1>/gi;

/** Characters of paragraph text in a chunk of HTML. */
const paragraphChars = (chunk: string): number => {
  const paragraphs: string[] = chunk.replace(NOISE, ' ').match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) ?? [];
  return paragraphs.reduce((n, p) => n + squash(p).length, 0);
};

/**
 * The part of the page holding the story. Many sites have <article> cards for
 * related stories (or an empty <article>), so pick the <article>/<main> with
 * most of the page's paragraph text, else the whole body.
 */
function mainContent(html: string): string {
  const body = html.match(/<body\b[\s\S]*<\/body>/i)?.[0] ?? html;
  const total = paragraphChars(body);
  const blocks = [...(body.match(/<article\b[\s\S]*?<\/article>/gi) ?? []), ...(body.match(/<main\b[\s\S]*?<\/main>/gi) ?? [])];
  let best: string | undefined;
  let bestChars = 0;
  for (const block of blocks) {
    const chars = paragraphChars(block);
    if (chars > bestChars) {
      best = block;
      bestChars = chars;
    }
  }
  return best && total > 0 && bestChars >= total * 0.5 ? best : body;
}

/** Readable text of an article page, plus its title, share image and date. */
export function articleText(html: string, maxChars = 12_000): ArticleText {
  let main = mainContent(html);
  main = main
    .replace(NOISE, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/h[1-6]|\/li|\/div|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  const text = decodeEntities(main)
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 1)
    .join('\n')
    .slice(0, maxChars);
  const image = meta(html, 'og:image') ?? meta(html, 'twitter:image');
  return {
    title: meta(html, 'og:title') ?? (tag(html, 'title') ? squash(tag(html, 'title')!) : undefined),
    text,
    imageUrl: image && /^https:\/\//i.test(image) ? image : undefined,
    publishedAt: parseDate(meta(html, 'article:published_time') ?? meta(html, 'datePublished') ?? meta(html, 'date')),
  };
}
