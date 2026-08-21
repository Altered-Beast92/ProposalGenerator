import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildContent } from '../../../lib/bind';

export const runtime = 'nodejs';

const ROOT = path.resolve(process.cwd(), '..', '..');
const RENDERER = path.join(ROOT, 'services', 'renderer');
const VENV_PYTHON = path.join(
  RENDERER,
  '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python',
);

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

function runPython(args) {
  return new Promise((resolve) => {
    const proc = spawn(VENV_PYTHON, args, { cwd: RENDERER });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function POST(request) {
  let tmp;
  try {
    const body = await request.json();
    const template = TEMPLATES[body.template] ? body.template : 'seo-only';
    const defaults = TEMPLATES[template];

    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'proposal-'));
    const outPath = path.join(tmp, 'proposal.pdf');
    const args = ['render.py', '--template', template, '--out', outPath];

    // Only send a replacement when the user actually supplied a value, so an
    // empty field leaves the original text rather than blanking the deck.
    const replacements = {};
    if (body.businessName?.trim()) replacements[defaults.business] = body.businessName.trim();
    if (body.region?.trim()) replacements[defaults.region] = body.region.trim();
    if (body.presenter?.trim()) replacements[defaults.presenter] = body.presenter.trim();
    if (body.proposalDate?.trim()) replacements[defaults.date] = body.proposalDate.trim();

    if (Object.keys(replacements).length) {
      const p = path.join(tmp, 'replace.json');
      await fs.writeFile(p, JSON.stringify(replacements), 'utf8');
      args.push('--replace', p);
    }

    // Reviewed scrape findings are written through the semantic bindings, which
    // fit them to each slot's character budget before they reach the renderer.
    let bindNotes = [];
    if (
      body.findings?.length ||
      body.sourceNote ||
      body.findingsTitle ||
      body.pricing ||
      body.keywordGroups?.length
    ) {
      const { content, notes } = buildContent(template, {
        findings: body.findings ?? [],
        sourceNote: body.sourceNote ?? '',
        findingsTitle: body.findingsTitle ?? '',
        pricing: body.pricing ?? null,
        presenter: body.presenter ?? '',
        keywordGroups: body.keywordGroups ?? null,
      });
      bindNotes = notes;
      if (Object.keys(content).length) {
        const p = path.join(tmp, 'content.json');
        await fs.writeFile(p, JSON.stringify(content), 'utf8');
        args.push('--content', p);
      }
    }

    // Logos arrive as data URLs and are written to the temp dir so the renderer
    // gets a plain file path. The directory is removed in `finally`, so nothing
    // uploaded outlives the request.
    const logoPaths = {};
    for (const frame of ['clientLogo', 'presenterLogo']) {
      const dataUrl = body[frame];
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) continue;

      const match = /^data:image\/(png|jpeg|jpg|gif);base64,(.+)$/i.exec(dataUrl);
      if (!match) continue;
      const buf = Buffer.from(match[2], 'base64');
      if (buf.length > 5_000_000) continue; // keep a stray huge upload out of the PDF

      const p = path.join(tmp, `${frame}.${match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase()}`);
      await fs.writeFile(p, buf);
      logoPaths[frame] = p;
    }
    if (Object.keys(logoPaths).length) {
      const p = path.join(tmp, 'logos.json');
      await fs.writeFile(p, JSON.stringify(logoPaths), 'utf8');
      args.push('--logos', p);
    }

    if (body.theme && Object.keys(body.theme).length) {
      const p = path.join(tmp, 'theme.json');
      await fs.writeFile(p, JSON.stringify(body.theme), 'utf8');
      args.push('--theme', p);
    }

    const result = await runPython(args);
    if (result.code !== 0) {
      return Response.json(
        { error: 'render failed', detail: result.stderr || result.stdout },
        { status: 500 },
      );
    }

    const pdf = await fs.readFile(outPath);
    // Overflows are surfaced to the browser rather than swallowed: they mean
    // supplied copy is too long for the space the design allows.
    const overflows = (result.stderr.match(/^\s+p\d+ run .*$/gm) ?? []).map((s) => s.trim());

    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${template}-proposal.pdf"`,
        'X-Overflow-Count': String(overflows.length),
        'X-Overflow-Detail': encodeURIComponent(overflows.slice(0, 5).join(' | ')),
        'X-Fit-Notes': encodeURIComponent(bindNotes.slice(0, 5).join(' | ')),
      },
    });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  } finally {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
