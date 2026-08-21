import { buildContent } from '../../../lib/bind';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Where to reach the Python renderer.
 *
 * On Vercel it is the sibling function at /api/render, in the same deployment.
 * `next dev` cannot run Vercel's Python runtime, so locally it falls back to
 * the uvicorn service (see services/renderer). RENDERER_URL overrides both.
 */
function rendererEndpoint() {
  if (process.env.RENDERER_URL) {
    return `${process.env.RENDERER_URL.replace(/\/$/, '')}/render`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}/api/render`;
  }
  return 'http://127.0.0.1:8000/render';
}

const TEMPLATES = {
  'seo-only': {
    // The strings the golden deck was written around. Deck-wide swaps are
    // driven off these, since the business name and locality appear on the
    // cover and repeat in every page footer.
    business: 'Vibes Mortgage & Finance',
    region: 'Ingleburn and South-West Sydney',
    presenter: 'WPPRO',
    date: 'August 2026',
  },
  'seo-ads': {
    business: 'Nova Care Australia',
    region: 'Southern Sydney',
    presenter: 'WPPRO',
    date: 'August 2026',
  },
};

export async function POST(request) {
  try {
    const body = await request.json();
    const template = TEMPLATES[body.template] ? body.template : 'seo-only';
    const defaults = TEMPLATES[template];

    // Only send a replacement when the user actually supplied a value, so an
    // empty field leaves the original text rather than blanking the deck.
    const replacements = {};
    if (body.businessName?.trim()) replacements[defaults.business] = body.businessName.trim();
    if (body.region?.trim()) replacements[defaults.region] = body.region.trim();
    if (body.presenter?.trim()) replacements[defaults.presenter] = body.presenter.trim();
    if (body.proposalDate?.trim()) replacements[defaults.date] = body.proposalDate.trim();

    // Reviewed scrape findings, pricing and keywords are written through the
    // semantic bindings, which fit them to each slot's character budget before
    // they reach the renderer.
    let content = {};
    let bindNotes = [];
    if (
      body.findings?.length ||
      body.sourceNote ||
      body.findingsTitle ||
      body.pricing ||
      body.keywordGroups?.length
    ) {
      const built = buildContent(template, {
        findings: body.findings ?? [],
        sourceNote: body.sourceNote ?? '',
        findingsTitle: body.findingsTitle ?? '',
        pricing: body.pricing ?? null,
        presenter: body.presenter ?? '',
        keywordGroups: body.keywordGroups ?? null,
      });
      content = built.content;
      bindNotes = built.notes;
    }

    const logos = {};
    for (const frame of ['clientLogo', 'presenterLogo']) {
      const dataUrl = body[frame];
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) logos[frame] = dataUrl;
    }

    const endpoint = rendererEndpoint();
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template,
          theme: body.theme && Object.keys(body.theme).length ? body.theme : null,
          content: Object.keys(content).length ? content : null,
          replacements: Object.keys(replacements).length ? replacements : null,
          logos: Object.keys(logos).length ? logos : null,
          icon_style: body.iconStyle ?? 'none',
        }),
      });
    } catch (err) {
      // A dead renderer is the most likely failure in production, and "fetch
      // failed" alone tells the user nothing actionable.
      return Response.json(
        {
          error: 'renderer unreachable',
          detail: `Could not reach the render service at ${endpoint}. ${String(err.message ?? err)}`,
        },
        { status: 502 },
      );
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return Response.json({ error: 'render failed', detail }, { status: res.status });
    }

    const pdf = Buffer.from(await res.arrayBuffer());
    const overflowDetail = res.headers.get('X-Overflow-Detail') ?? '';

    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${template}-proposal.pdf"`,
        'X-Overflow-Count': res.headers.get('X-Overflow-Count') ?? '0',
        'X-Overflow-Detail': encodeURIComponent(overflowDetail),
        'X-Fit-Notes': encodeURIComponent(bindNotes.slice(0, 5).join(' | ')),
      },
    });
  } catch (err) {
    return Response.json({ error: String(err.message ?? err) }, { status: 500 });
  }
}
