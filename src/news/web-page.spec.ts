import {
  articleText,
  decodeEntities,
  extractLinks,
  feedLinkOf,
  isPublicWebUrl,
  looksLikeFeed,
  normaliseUrl,
  parseFeed,
  sameSite,
  slugTitle,
} from './web-page';

describe('news web-page helpers', () => {
  it('treats sub-domains and www as the same site, and nothing else', () => {
    expect(sameSite('https://www.ncdc.gov.ng/news/1', 'https://ncdc.gov.ng/')).toBe(true);
    expect(sameSite('https://portal.jamb.gov.ng/x', 'https://www.jamb.gov.ng/')).toBe(true);
    expect(sameSite('https://ncdc.gov.ng.evil.com/x', 'https://ncdc.gov.ng/')).toBe(false);
    expect(sameSite('https://twitter.com/ncdcgov', 'https://ncdc.gov.ng/')).toBe(false);
  });

  it('only allows public web addresses', () => {
    expect(isPublicWebUrl('https://ncdc.gov.ng/')).toBe(true);
    for (const bad of ['http://localhost:4000', 'http://127.0.0.1/', 'http://10.0.0.5/', 'http://192.168.1.1', 'ftp://x.org', 'file:///etc/passwd', 'nonsense']) {
      expect(isPublicWebUrl(bad)).toBe(false);
    }
  });

  it('normalises addresses so one story is not seen twice', () => {
    expect(normaliseUrl('https://ncdc.gov.ng/news/12/?utm_source=x&id=3#top')).toBe('https://ncdc.gov.ng/news/12?id=3');
  });

  it('decodes HTML entities', () => {
    expect(decodeEntities('Lassa &amp; cholera &#8211; update &quot;now&quot; &nbsp;')).toBe('Lassa & cholera – update "now"  ');
  });

  it('reads RSS and Atom feeds', () => {
    const rss = `<?xml version="1.0"?><rss><channel><title>NCDC</title>
      <item><title><![CDATA[Lassa fever situation report, week 40]]></title><link>https://ncdc.gov.ng/news/501</link>
        <pubDate>Mon, 22 Sep 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Cases rise in Edo&lt;/p&gt;</description></item>
      <item><title>No link</title></item>
    </channel></rss>`;
    expect(looksLikeFeed({ url: '', contentType: 'text/xml', body: rss })).toBe(true);
    const items = parseFeed(rss, 'https://ncdc.gov.ng/feed');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'Lassa fever situation report, week 40', url: 'https://ncdc.gov.ng/news/501', description: 'Cases rise in Edo' });
    expect(items[0].publishedAt?.toISOString()).toBe('2026-09-22T10:00:00.000Z');

    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Post-UTME screening begins</title>
      <link rel="alternate" href="/news/screening"/><updated>2026-09-20T08:00:00Z</updated></entry></feed>`;
    expect(parseFeed(atom, 'https://unilag.edu.ng/feed')[0]).toMatchObject({ url: 'https://unilag.edu.ng/news/screening' });
  });

  it('finds a feed advertised in a page head', () => {
    const html = '<head><link rel="alternate" type="application/rss+xml" href="/feed/"></head>';
    expect(feedLinkOf(html, 'https://nigeriahealthwatch.com/')).toBe('https://nigeriahealthwatch.com/feed/');
  });

  it('lists headline links on the same site, skipping menus and files', () => {
    const html = `
      <a href="/about">About us and our mission statement</a>
      <a href="/news/lassa-week-40">NCDC publishes Lassa fever situation report for week 40</a>
      <a href="/news/lassa-week-40#comments">NCDC publishes Lassa fever situation report for week 40</a>
      <a href="https://twitter.com/ncdc">Follow the NCDC on Twitter for all the updates</a>
      <a href="/files/report.pdf">Download the full report as a PDF document</a>
      <a href="/news/short">Short</a>
      <a href="mailto:info@ncdc.gov.ng">Email the centre for any enquiries today</a>`;
    expect(extractLinks(html, 'https://ncdc.gov.ng/')).toEqual([
      { title: 'NCDC publishes Lassa fever situation report for week 40', url: 'https://ncdc.gov.ng/news/lassa-week-40' },
    ]);
  });

  it('uses the headline in the address when a link wraps only an image', () => {
    const html = '<a href="/news/534/2-march-2026-%7C-ncdc-calls-for-action-as-lassa-fever-cases-rise"><img src="x.jpg"></a><a href="/about-us"><img src="y.jpg"></a>';
    expect(extractLinks(html, 'https://ncdc.gov.ng/news/press')).toEqual([
      { title: '2 march 2026 – ncdc calls for action as lassa fever cases rise', url: 'https://ncdc.gov.ng/news/534/2-march-2026-%7C-ncdc-calls-for-action-as-lassa-fever-cases-rise' },
    ]);
    expect(slugTitle('https://x.org/p/123')).toBeUndefined();
  });

  it('extracts an article’s text, title, image and date', () => {
    const html = `<html><head><title>Ignored</title>
      <meta property="og:title" content="MDCN announces induction dates">
      <meta property="og:image" content="https://mdcn.gov.ng/img/induction.jpg">
      <meta property="article:published_time" content="2026-09-25T09:00:00+01:00"></head>
      <body><nav>Home | About</nav><article><h1>Induction</h1><p>The council will hold induction on 10 October.</p>
      <script>track()</script><p>Graduates must register by 1 October.</p></article><footer>© MDCN</footer></body></html>`;
    const a = articleText(html);
    expect(a.title).toBe('MDCN announces induction dates');
    expect(a.imageUrl).toBe('https://mdcn.gov.ng/img/induction.jpg');
    expect(a.publishedAt?.toISOString()).toBe('2026-09-25T08:00:00.000Z');
    expect(a.text).toBe('Induction\nThe council will hold induction on 10 October.\nGraduates must register by 1 October.');
  });
});
