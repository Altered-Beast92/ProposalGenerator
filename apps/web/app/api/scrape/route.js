import { scrapeSite } from '../../../lib/scrape';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(request) {
  try {
    const { url, region } = await request.json();
    if (!url?.trim()) return Response.json({ error: 'a website URL is required' }, { status: 400 });

    const result = await scrapeSite(url.trim(), { region: region ?? '' });
    return Response.json(result);
  } catch (err) {
    // The message is the useful part here - bad URL, private address, timeout,
    // dead host - so it is passed through rather than flattened to "failed".
    return Response.json({ error: String(err.message ?? err) }, { status: 400 });
  }
}
