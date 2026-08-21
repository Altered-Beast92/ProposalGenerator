/**
 * Fetches a prospect's website and pulls out the facts the proposal deck needs.
 *
 * Everything here is *observation*, not judgement: it records what the site
 * says, which pages exist, and where the obvious SEO problems are. Turning that
 * into proposal copy is a separate step, and one a human reviews before it
 * reaches a PDF - the deck makes factual claims about a real business, and a
 * wrong one is expensive.
 */
import * as cheerio from 'cheerio';

const USER_AGENT =
  'Mozilla/5.0 (compatible; ProposalGenerator/0.1; +local research tool)';
const FETCH_TIMEOUT_MS = 15000;
const MAX_PAGES = 8;
const MAX_HTML_BYTES = 3_000_000;

/**
 * Rejects anything that is not a public http(s) address.
 *
 * The URL comes from a form field, so without this the server would happily
 * fetch loopback and private-range addresses on behalf of whoever typed it.
 */
export function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    throw new Error(`not a valid URL: ${raw}`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`unsupported protocol: ${url.protocol}`);
  }

  const host = url.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (blocked) throw new Error(`refusing to fetch a private address: ${host}`);
  return url;
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
      redirect: 'follow',
      signal: controller.signal,
    });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok) return { url, status: res.status, error: `HTTP ${res.status}` };
    if (!type.includes('html')) return { url, status: res.status, error: `not HTML (${type})` };

    const html = (await res.text()).slice(0, MAX_HTML_BYTES);
    return { url: res.url || url, status: res.status, html };
  } catch (err) {
    return { url, error: err.name === 'AbortError' ? 'timed out' : String(err.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Pulls the structured facts out of one HTML document. */
function parsePage(html, pageUrl) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const h1s = $('h1').map((_, el) => clean($(el).text())).get().filter(Boolean);
  const h2s = $('h2').map((_, el) => clean($(el).text())).get().filter(Boolean).slice(0, 25);
  const bodyText = clean($('body').text());

  return {
    url: pageUrl,
    title: clean($('title').first().text()),
    metaDescription: clean($('meta[name="description"]').attr('content')),
    canonical: clean($('link[rel="canonical"]').attr('href')),
    ogTitle: clean($('meta[property="og:title"]').attr('content')),
    h1s,
    h2s,
    wordCount: bodyText.split(/\s+/).filter(Boolean).length,
    hasSchema: $('script[type="application/ld+json"]').length > 0 || /itemtype=/i.test(html),
    forms: $('form').length,
    phones: [...new Set((bodyText.match(/(?:\+?61|0)[\s-]?[2-478](?:[\s-]?\d){8}/g) ?? []).map(clean))].slice(0, 5),
    emails: [...new Set(html.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g) ?? [])]
      .filter((e) => !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(e))
      .slice(0, 5),
    bodyText,
  };
}

/**
 * Finds the site's own logo.
 *
 * Ranked by how likely each source is to be the real brand mark rather than a
 * social-share banner or a 32px favicon: an <img> that calls itself a logo
 * beats a schema.org logo field, which beats og:image, which beats a touch
 * icon. SVG is excluded because ReportLab cannot place it.
 */
function findLogo(html, origin) {
  const $ = cheerio.load(html);
  const candidates = [];

  const add = (src, rank) => {
    if (!src) return;
    try {
      const abs = new URL(src, origin).toString();
      if (/\.svg(\?|$)/i.test(abs)) return;
      if (abs.startsWith('data:')) return;
      candidates.push({ url: abs, rank });
    } catch {
      /* unparseable src */
    }
  };

  $('img').each((_, el) => {
    const $el = $(el);
    const hay = `${$el.attr('src') ?? ''} ${$el.attr('alt') ?? ''} ${$el.attr('class') ?? ''} ${$el.attr('id') ?? ''}`;
    if (!/logo|brand/i.test(hay)) return;
    const inHeader = $el.closest('header, nav, .header, #header, .navbar, .site-header').length > 0;
    add($el.attr('src') || $el.attr('data-src'), inHeader ? 0 : 1);
  });

  for (const script of $('script[type="application/ld+json"]').get()) {
    try {
      const data = JSON.parse($(script).text());
      const nodes = Array.isArray(data) ? data : [data, ...(data['@graph'] ?? [])];
      for (const node of nodes) {
        const logo = node?.logo?.url ?? node?.logo;
        if (typeof logo === 'string') add(logo, 2);
      }
    } catch {
      /* malformed JSON-LD is common; ignore */
    }
  }

  add($('meta[property="og:image"]').attr('content'), 3);
  add($('link[rel="apple-touch-icon"]').attr('href'), 4);
  add($('link[rel="icon"]').attr('href'), 5);

  candidates.sort((a, b) => a.rank - b.rank);
  return candidates.length ? candidates[0].url : null;
}

/** Downloads a logo and returns it as a data URL the form can preview directly. */
async function fetchLogo(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' },
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!/^image\/(png|jpeg|jpg|gif|webp)$/i.test(type)) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 3_000_000) return null;

    // WebP is reported honestly rather than relabelled: the renderer would
    // reject it, and a silent mislabel would fail deep inside ReportLab.
    return { dataUrl: `data:${type};base64,${buf.toString('base64')}`, type, bytes: buf.length };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Discovers internal links worth following, ranked by how useful they tend to be. */
function discoverLinks(html, origin) {
  const $ = cheerio.load(html);
  const seen = new Map();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
    let abs;
    try {
      abs = new URL(href, origin);
    } catch {
      return;
    }
    if (abs.origin !== origin) return;
    abs.hash = '';
    const key = abs.toString().replace(/\/$/, '');
    if (!seen.has(key)) seen.set(key, clean($(el).text()));
  });

  // Service, about and contact pages carry the detail a proposal needs; legal
  // and utility pages carry none, so they are pushed to the back.
  const score = (u) => {
    const p = u.toLowerCase();
    if (/(service|solution|what-we-do|treatment|product)/.test(p)) return 0;
    if (/(about|team|why-)/.test(p)) return 1;
    if (/(contact|location|area)/.test(p)) return 2;
    if (/(blog|news|article|testimonial|review|case-stud)/.test(p)) return 3;
    if (/(privacy|terms|cookie|sitemap|cart|checkout|login|account)/.test(p)) return 9;
    return 5;
  };

  return [...seen.entries()]
    .map(([url, text]) => ({ url, text, score: score(url) }))
    .sort((a, b) => a.score - b.score)
    .filter((l) => l.score < 9);
}

/**
 * Flags the SEO problems the deck's "Priority findings" page is built around.
 * Each finding names what was observed, so a reviewer can check it rather than
 * take it on trust.
 */
function deriveFindings(home, pages, region) {
  const findings = [];
  const title = home.title ?? '';
  const regionWords = clean(region).toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const mentionsRegion = (s) =>
    regionWords.length > 0 && regionWords.some((w) => (s ?? '').toLowerCase().includes(w));

  // Homepage title
  const halves = title.split(/\s*[|\-–—]\s*/).map(clean).filter(Boolean);
  if (!title) {
    findings.push({ id: 'title', label: 'Homepage metadata', severity: 'danger',
      detail: 'The homepage has no title tag, so search engines have nothing to display.' });
  } else if (halves.length > 1 && new Set(halves.map((h) => h.toLowerCase())).size === 1) {
    findings.push({ id: 'title', label: 'Homepage metadata', severity: 'danger',
      detail: `The search result title is "${title}", which repeats the business name instead of describing the service or location.` });
  } else if (!mentionsRegion(title)) {
    findings.push({ id: 'title', label: 'Homepage metadata', severity: 'warning',
      detail: `The title is "${title}" - it does not target a location, so local searches have nothing to match.` });
  }

  // Meta description
  if (!home.metaDescription) {
    findings.push({ id: 'meta', label: 'Meta description', severity: 'warning',
      detail: 'The homepage has no meta description, leaving Google to invent the snippet shown in results.' });
  } else if (home.metaDescription.length < 70) {
    findings.push({ id: 'meta', label: 'Meta description', severity: 'warning',
      detail: `The meta description is only ${home.metaDescription.length} characters, well short of the ~155 available.` });
  }

  // H1
  if (home.h1s.length === 0) {
    findings.push({ id: 'h1', label: 'Heading structure', severity: 'warning',
      detail: 'The homepage has no H1, so the page has no clear primary heading for search engines.' });
  } else if (home.h1s.length > 1) {
    findings.push({ id: 'h1', label: 'Heading structure', severity: 'warning',
      detail: `The homepage has ${home.h1s.length} H1 headings, which dilutes the page's primary topic.` });
  }

  // Duplicate titles. Checked before the mismatch test below, because when
  // every page shares one title that is the finding, and per-page mismatches
  // are just noise on top of it.
  const titled = pages.filter((p) => p.title);
  const uniqueTitles = new Set(titled.map((p) => p.title.toLowerCase()));
  const duplicateTitles = titled.length > 1 && uniqueTitles.size === 1;
  if (duplicateTitles) {
    findings.push({ id: 'dupTitles', label: 'Duplicate titles', severity: 'danger',
      detail: `All ${titled.length} pages reviewed share the same title, "${titled[0].title}". Each page needs its own title describing that specific service.` });
  } else if (titled.length > 2 && uniqueTitles.size < titled.length) {
    findings.push({ id: 'dupTitles', label: 'Duplicate titles', severity: 'warning',
      detail: `${titled.length - uniqueTitles.size} of ${titled.length} pages reviewed reuse another page's title.` });
  }

  // URL / heading mismatch. The *last* meaningful path segment is the page's
  // own topic - matching on the first would compare every page against the
  // section folder ("services"), flagging correct pages as broken.
  const GENERIC_SEGMENTS = new Set([
    'services', 'service', 'solutions', 'products', 'pages', 'page', 'category',
    'blog', 'news', 'index', 'home', 'en', 'au',
  ]);
  const mismatches = duplicateTitles ? [] : pages.filter((p) => {
    if (!p.h1s.length) return false;
    const segments = new URL(p.url).pathname.split('/').filter(Boolean);
    const topic = [...segments].reverse().find((s) => !GENERIC_SEGMENTS.has(s.toLowerCase()));
    if (!topic) return false;
    const words = topic.replace(/[^a-z]+/gi, ' ').trim().toLowerCase().split(' ')
      .filter((w) => w.length > 3);
    if (!words.length) return false;
    const haystack = `${p.h1s[0]} ${p.title}`.toLowerCase();
    // Mismatched only if none of the URL's own words appear on the page.
    return !words.some((w) => haystack.includes(w));
  });
  if (mismatches.length) {
    findings.push({ id: 'mapping', label: 'URL / page mapping', severity: 'warning',
      detail: `${mismatches.length} page${mismatches.length > 1 ? 's appear' : ' appears'} mismatched with its URL - for example ${new URL(mismatches[0].url).pathname} presents "${mismatches[0].h1s[0]}".` });
  }

  // Local relevance
  if (region && !mentionsRegion(home.bodyText)) {
    findings.push({ id: 'local', label: 'Local relevance', severity: 'danger',
      detail: `The homepage copy does not mention ${clean(region)}, so it sends no signal for local search intent.` });
  }

  // NAP consistency
  if (home.phones.length > 1) {
    findings.push({ id: 'nap', label: 'NAP consistency', severity: 'warning',
      detail: `The site shows ${home.phones.length} different phone numbers (${home.phones.slice(0, 2).join(', ')}). These should be confirmed and standardised.` });
  } else if (home.phones.length === 0) {
    findings.push({ id: 'nap', label: 'NAP consistency', severity: 'warning',
      detail: 'No phone number was found in the page text, which weakens both local SEO and conversion.' });
  }

  // Schema
  if (!home.hasSchema) {
    findings.push({ id: 'schema', label: 'Structured data', severity: 'warning',
      detail: 'No structured data was detected, so Google has no machine-readable description of the business.' });
  }

  // Content depth
  const thin = pages.filter((p) => p.wordCount < 300);
  if (thin.length) {
    findings.push({ id: 'depth', label: 'Content depth', severity: 'warning',
      detail: `${thin.length} of ${pages.length} pages reviewed carry under 300 words, which is thin for competitive search terms.` });
  }

  // Conversion assets - deliberately framed as a strength where present
  if (home.forms > 0 || home.phones.length) {
    findings.push({ id: 'conversion', label: 'Conversion assets', severity: 'success',
      detail: `${home.forms > 0 ? `${home.forms} enquiry form${home.forms > 1 ? 's' : ''}` : 'Phone contact'} already in place, which can be strengthened rather than rebuilt.` });
  }

  return findings;
}

/**
 * Names the services the site sells, for use as keyword groups.
 *
 * Derived from URL slugs rather than link text: anchors on these sites tend to
 * swallow the whole card, producing names like "Home LoanFind the perfect home
 * loan solution tailored to your needs.Learn More". A slug is short, stable and
 * already the page's own topic.
 */
function serviceNames(links, pages) {
  const GENERIC = new Set([
    'services', 'service', 'solutions', 'products', 'index', 'home', 'page', 'pages', 'en', 'au',
  ]);
  const names = new Map();

  const record = (url) => {
    let segments;
    try {
      segments = new URL(url).pathname.split('/').filter(Boolean);
    } catch {
      return;
    }
    const slug = [...segments].reverse().find((s) => !GENERIC.has(s.toLowerCase()));
    if (!slug) return;

    const name = slug
      .replace(/\.(html?|php|aspx)$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!name || name.length < 3 || name.length > 40 || /^\d+$/.test(name)) return;

    // Singularise the common plural so "home loans" and "home loan" do not both
    // claim a keyword group.
    const key = name.replace(/s$/, '');
    if (!names.has(key)) names.set(key, name);
  };

  for (const link of links.filter((l) => l.score === 0)) record(link.url);
  for (const page of pages) if (/(service|solution|treatment)/i.test(page.url)) record(page.url);

  return [...names.values()].slice(0, 10);
}

/** Facts worth promoting to the three stat tiles on the executive summary. */
function deriveStats(home, pages) {
  const stats = [];
  const services = pages.filter((p) => /(service|solution|treatment|what-we-do)/i.test(p.url));
  if (services.length) stats.push({ value: String(services.length), caption: 'service pages on site' });
  stats.push({ value: String(pages.length), caption: 'pages reviewed' });

  // A bare year on a page is almost always the copyright line. Claiming it as a
  // founding date would put a fabricated fact in front of a client, so the year
  // is only used when the copy explicitly says that is what it means.
  const established = home.bodyText.match(
    /\b(?:since|established(?:\s+in)?|founded(?:\s+in)?|est\.?|serving[^.]{0,40}since)\s+((?:19|20)\d{2})\b/i,
  );
  const year = established ? Number(established[1]) : null;
  if (year && year >= 1900 && year <= new Date().getFullYear()) {
    stats.push({ value: String(year), caption: 'established' });
  }

  const totalWords = pages.reduce((n, p) => n + p.wordCount, 0);
  stats.push({ value: String(totalWords.toLocaleString()), caption: 'words of content reviewed' });

  return stats.slice(0, 3);
}

/** Crawls a site and returns everything the proposal needs, for human review. */
export async function scrapeSite(rawUrl, { region = '', maxPages = MAX_PAGES } = {}) {
  const url = assertPublicUrl(rawUrl);
  const homeRes = await fetchPage(url.toString());
  if (homeRes.error) throw new Error(`could not fetch ${url.hostname}: ${homeRes.error}`);

  const home = parsePage(homeRes.html, homeRes.url);
  const origin = new URL(homeRes.url).origin;
  const links = discoverLinks(homeRes.html, origin);

  const toVisit = links
    .filter((l) => l.url.replace(/\/$/, '') !== homeRes.url.replace(/\/$/, ''))
    .slice(0, Math.max(0, maxPages - 1));

  const others = [];
  const failed = [];
  // Sequential on purpose: this points at a stranger's site, and a burst of
  // parallel requests is rude at best and rate-limited at worst.
  for (const link of toVisit) {
    const res = await fetchPage(link.url);
    if (res.error) failed.push({ url: link.url, error: res.error });
    else others.push(parsePage(res.html, res.url));
  }

  const pages = [home, ...others];
  const businessName =
    clean(home.ogTitle) ||
    clean(home.title.split(/\s*[|\-–—]\s*/)[0]) ||
    new URL(homeRes.url).hostname.replace(/^www\./, '');

  const logoUrl = findLogo(homeRes.html, origin);
  const logo = logoUrl ? await fetchLogo(logoUrl) : null;

  return {
    scannedAt: new Date().toISOString(),
    site: origin,
    businessName,
    logo: logo ? { ...logo, sourceUrl: logoUrl } : null,
    logoUrl,
    pagesScanned: pages.length,
    failed,
    home: {
      title: home.title,
      metaDescription: home.metaDescription,
      h1: home.h1s[0] ?? '',
      phones: home.phones,
      emails: home.emails,
      forms: home.forms,
      hasSchema: home.hasSchema,
    },
    pages: pages.map((p) => ({
      url: p.url, title: p.title, h1: p.h1s[0] ?? '', wordCount: p.wordCount,
    })),
    services: serviceNames(links, pages),
    findings: deriveFindings(home, pages, region),
    stats: deriveStats(home, pages),
  };
}
