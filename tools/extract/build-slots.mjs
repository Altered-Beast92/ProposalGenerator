/**
 * Derives the editable content schema from an extracted geometry spec.
 *
 * The geometry says where ink landed; it does not say how much room a slot
 * actually has. Budgeting copy off the original string length would therefore
 * be far too strict - the golden text happens to fill its own width exactly, so
 * every slot would forbid a single extra character.
 *
 * Instead the space available to each run is inferred from its neighbours: the
 * next run along the same baseline, or the right edge of the card it sits in,
 * or the page margin. That distance is the real budget, and it is what makes
 * "will this business name fit?" answerable before rendering rather than after.
 *
 *   node build-slots.mjs seo-only
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = path.resolve(HERE, '../../packages/spec');
const LAYOUT_DIR = path.join(SPEC_DIR, 'layouts');
const OUT_DIR = path.join(SPEC_DIR, 'content');

const PAGE_MARGIN = 46; // matches the decks' left/right gutter
const SAME_LINE = 2.5; // pt tolerance for "on the same baseline"
const CARD_PADDING = 8; // breathing room inside a card edge

/**
 * Average glyph width as a fraction of font size, for Helvetica. Used to turn
 * an available width in points into a character budget. Deliberately a mean
 * rather than a max: an exact answer needs real font metrics, which the
 * renderer already applies at draw time - this is the UI's estimate.
 */
const AVG_CHAR_RATIO = { regular: 0.5, bold: 0.54 };

/** Classifies a run so the UI can group and label the fields sensibly. */
function classify(run, page, spec) {
  const bold = spec.fonts[run.fontId] === 'Helvetica-Bold';
  const isDingbat = spec.fonts[run.fontId] === 'ZapfDingbats';
  const size = run.size;
  const text = run.text.trim();

  if (isDingbat) return 'icon';
  if (run.y < 30) return 'footer';
  if (size >= 26) return 'pageTitle';
  if (bold && size <= 9 && text === text.toUpperCase()) return 'eyebrow';
  if (/^\$[\d,]+$/.test(text) || /^\d+\+?$/.test(text) || /^\d{4}$/.test(text)) return 'stat';
  if (bold && size >= 10) return 'heading';
  if (size <= 7) return 'caption';
  return 'body';
}

/**
 * How much horizontal room this run has, and which way it grows.
 *
 * Alignment has to be inferred, because a PDF records only where glyphs were
 * placed. It matters: the page footers are right-aligned, so measuring their
 * headroom rightwards reports zero slack when in truth they can grow leftwards
 * across the width of the page.
 */
function measure(run, page) {
  const pageRight = page.width - PAGE_MARGIN;
  const runRight = run.x + run.width;

  // The smallest filled card containing this run bounds it. Two kinds of shape
  // are excluded: full-bleed page backgrounds, which bound nothing, and circles
  // (radius == half the shorter side), which on these decks are decorative
  // cover artwork sitting *behind* text rather than a container around it.
  let card = null;
  for (const s of page.shapes) {
    if (s.kind !== 'rect' && s.kind !== 'roundRect') continue;
    if (s.w >= page.width - 1 && s.h >= page.height - 1) continue;
    const isCircle = (s.radius ?? 0) >= Math.min(s.w, s.h) / 2 - 0.5;
    if (isCircle) continue;
    // Shapes bleeding off the canvas are decorative artwork, never containers.
    // Their radius is also unreliable, since the clipped bounding box defeats
    // circle detection above - which is how a cover circle came to "contain"
    // the byline and crush its budget to 49pt.
    const offCanvas = s.x < 0 || s.y < 0 || s.x + s.w > page.width || s.y + s.h > page.height;
    if (offCanvas) continue;
    const inside =
      run.x >= s.x - 1 && run.x <= s.x + s.w + 1 && run.y >= s.y - 1 && run.y <= s.y + s.h + 1;
    if (!inside) continue;
    if (!card || s.w * s.h < card.w * card.h) card = s;
  }

  const boundLeft = card ? card.x + CARD_PADDING : PAGE_MARGIN;
  const boundRight = card ? card.x + card.w - CARD_PADDING : pageRight;

  // Nearest neighbours on the same baseline.
  let leftLimit = boundLeft;
  let rightLimit = boundRight;
  for (const other of page.runs) {
    if (other === run) continue;
    if (Math.abs(other.y - run.y) > SAME_LINE) continue;
    if (other.x > run.x) rightLimit = Math.min(rightLimit, other.x);
    else leftLimit = Math.max(leftLimit, other.x + other.width);
  }

  // Sitting flush against the right bound means right-aligned.
  const align = Math.abs(runRight - boundRight) < 1.5 ? 'right' : 'left';
  const available = align === 'right'
    ? Math.max(0, runRight - leftLimit)
    : Math.max(0, rightLimit - run.x);

  return { available, align };
}

function build(template) {
  const spec = JSON.parse(
    fs.readFileSync(path.join(LAYOUT_DIR, `${template}.geometry.json`), 'utf8'),
  );

  const slots = [];
  for (const page of spec.pages) {
    page.runs.forEach((run, index) => {
      const role = classify(run, page, spec);
      if (role === 'icon') return; // not text; cannot be edited as such

      const { available, align } = measure(run, page);
      const bold = spec.fonts[run.fontId] === 'Helvetica-Bold';
      const ratio = bold ? AVG_CHAR_RATIO.bold : AVG_CHAR_RATIO.regular;
      const maxChars = Math.floor(available / (run.size * ratio));

      slots.push({
        id: `p${String(page.page).padStart(2, '0')}.${index}`,
        key: `${page.page}:${index}`, // what the renderer's --content expects
        page: page.page,
        role,
        align,
        default: run.text,
        // Slack is what the design left spare. A negative or near-zero value
        // means the original copy already fills the slot, so any replacement
        // must be shorter.
        widthPt: Math.round(run.width * 10) / 10,
        availablePt: Math.round(available * 10) / 10,
        slackPt: Math.round((available - run.width) * 10) / 10,
        maxChars,
      });
    });
  }

  const byRole = {};
  for (const s of slots) byRole[s.role] = (byRole[s.role] ?? 0) + 1;

  const out = {
    template,
    generatedAt: new Date().toISOString(),
    source: `${template}.geometry.json`,
    slotCount: slots.length,
    byRole,
    slots,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${template}.slots.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  const tight = slots.filter((s) => s.slackPt < 2).length;
  console.log(
    `${template}: ${slots.length} slots -> ${path.relative(process.cwd(), file)}\n` +
      `  roles: ${Object.entries(byRole).map(([k, v]) => `${k}=${v}`).join(' ')}\n` +
      `  ${tight} slot(s) with under 2pt of slack`,
  );
}

const templates = process.argv.slice(2);
if (!templates.length) {
  console.error('usage: node build-slots.mjs <template> [template...]');
  process.exit(1);
}
for (const t of templates) build(t);
