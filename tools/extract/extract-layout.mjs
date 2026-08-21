/**
 * Extracts the frozen layout geometry from the golden proposal PDFs.
 *
 * The two reference decks were produced by ReportLab at 960x540pt, so every
 * element already sits at an absolute coordinate. This walks the operator list
 * of each page and records those coordinates verbatim: text runs with their
 * position, size, font and fill colour, and the filled rectangles that make up
 * the cards, rules and tint panels behind them.
 *
 * The output is the source of truth for the renderer. Nothing downstream is
 * allowed to invent a frame that did not come out of here.
 *
 *   node extract-layout.mjs ../../templates/golden/seo-only.pdf seo-only
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { OPS } = pdfjs;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '../../packages/spec/layouts');

/** pdf.js hands back colour components as 0-255 ints keyed by index. */
function toHex(args) {
  const c = [args[0], args[1], args[2]].map((v) => Math.max(0, Math.min(255, Math.round(v))));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

const round = (n, p = 2) => Number(n.toFixed(p));

/**
 * Reduces a constructPath operator to one bounding box per subpath.
 *
 * ReportLab draws the card backgrounds as rounded rects, which reach the PDF as
 * line+curve sequences rather than a `rectangle` op. Only tracking true rects
 * therefore misses most of the layout, so every subpath is collapsed to its
 * bounding box instead; `curved` records whether corners were rounded so the
 * renderer can reproduce the radius.
 */
function boxesFromPath(pathOps, coords) {
  const boxes = [];
  let current = null;
  let curved = false;
  let i = 0;

  const point = (x, y) => {
    if (!current) current = { minX: x, minY: y, maxX: x, maxY: y, pts: [[x, y]] };
    else {
      current.pts.push([x, y]);
      current.minX = Math.min(current.minX, x);
      current.minY = Math.min(current.minY, y);
      current.maxX = Math.max(current.maxX, x);
      current.maxY = Math.max(current.maxY, y);
    }
  };

  const flush = () => {
    if (current) boxes.push({ ...current, curved });
    current = null;
    curved = false;
  };

  // Bezier control points sit outside the curve they describe, so feeding them
  // to the bounding box inflates every rounded shape (a circle came out ~2x too
  // wide). Flattening to sampled on-curve points keeps the box honest.
  let cx = 0;
  let cy = 0;
  const curve = (x1, y1, x2, y2, x3, y3) => {
    const [x0, y0] = [cx, cy];
    const STEPS = 16;
    for (let s = 1; s <= STEPS; s++) {
      const t = s / STEPS;
      const u = 1 - t;
      point(
        u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
      );
    }
    cx = x3;
    cy = y3;
  };

  for (const op of pathOps) {
    if (op === OPS.rectangle) {
      const [x, y, w, h] = coords.slice(i, i + 4);
      flush();
      point(x, y);
      point(x + w, y + h);
      flush();
      cx = x;
      cy = y;
      i += 4;
    } else if (op === OPS.moveTo) {
      flush();
      point(coords[i], coords[i + 1]);
      cx = coords[i];
      cy = coords[i + 1];
      i += 2;
    } else if (op === OPS.lineTo) {
      point(coords[i], coords[i + 1]);
      cx = coords[i];
      cy = coords[i + 1];
      i += 2;
    } else if (op === OPS.curveTo) {
      curved = true;
      curve(coords[i], coords[i + 1], coords[i + 2], coords[i + 3], coords[i + 4], coords[i + 5]);
      i += 6;
    } else if (op === OPS.curveTo2) {
      // control point 1 coincides with the current point
      curved = true;
      curve(cx, cy, coords[i], coords[i + 1], coords[i + 2], coords[i + 3]);
      i += 4;
    } else if (op === OPS.curveTo3) {
      // control point 2 coincides with the endpoint
      curved = true;
      curve(coords[i], coords[i + 1], coords[i + 2], coords[i + 3], coords[i + 2], coords[i + 3]);
      i += 4;
    }
    // closePath consumes no coordinates
  }
  flush();

  return boxes.map((b) => {
    // A ReportLab rounded rect never places a point in the corner itself: the
    // straight edges start one radius in. Measuring that inset along the bottom
    // edge recovers the radius, which is otherwise unrecoverable from a bbox.
    let radius = 0;
    if (b.curved) {
      const eps = 0.75;
      const bottom = b.pts.filter((p) => Math.abs(p[1] - b.minY) < eps);
      if (bottom.length) {
        const inset = Math.min(...bottom.map((p) => p[0] - b.minX));
        const maxR = Math.min(b.maxX - b.minX, b.maxY - b.minY) / 2;
        radius = Math.max(0, Math.min(inset, maxR));
      }
    }
    return {
      x: b.minX,
      y: b.minY,
      w: b.maxX - b.minX,
      h: b.maxY - b.minY,
      curved: b.curved,
      radius,
    };
  });
}

async function extractPage(page, pageNo) {
  const viewport = page.getViewport({ scale: 1 });
  const [ops, textContent] = await Promise.all([
    page.getOperatorList(),
    page.getTextContent(),
  ]);

  // --- vector shapes -------------------------------------------------------
  let fill = '#000000';
  let stroke = '#000000';
  const shapes = [];
  let pending = null;

  // Path coordinates are expressed in the current user space, so the CTM has to
  // be tracked and applied or anything drawn inside a translate lands at the
  // wrong place (several pages position whole panels this way). Text runs need
  // no such handling: pdf.js already bakes the CTM into item.transform.
  let ctm = [1, 0, 0, 1, 0, 0];
  const ctmStack = [];
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const applyCtm = (r) => {
    const [a, b, c, d, e, f] = ctm;
    const xs = [r.x, r.x + r.w];
    const ys = [r.y, r.y + r.h];
    const pts = [];
    for (const x of xs) for (const y of ys) pts.push([a * x + c * y + e, b * x + d * y + f]);
    const px = pts.map((p) => p[0]);
    const py = pts.map((p) => p[1]);
    return {
      x: Math.min(...px),
      y: Math.min(...py),
      w: Math.max(...px) - Math.min(...px),
      h: Math.max(...py) - Math.min(...py),
      curved: r.curved,
      radius: (r.radius ?? 0) * Math.hypot(a, b),
    };
  };

  // Text colour lives in the same graphics state as shape fills, and
  // getTextContent() does not report it. Recording the active fill at each
  // show-text op lets the runs be zipped back to their colours below, which is
  // what makes recolouring possible at all.
  const textFills = [];

  for (let k = 0; k < ops.fnArray.length; k++) {
    const fn = ops.fnArray[k];
    const args = ops.argsArray[k];

    if (fn === OPS.showText || fn === OPS.showSpacedText) {
      // Whitespace-only draws produce no text item on the other side, so they
      // must not consume a colour slot or every run after them shifts.
      const glyphs = Array.isArray(args[0]) ? args[0] : [];
      const hasInk = glyphs.some(
        (g) => g && typeof g === 'object' && typeof g.unicode === 'string' && g.unicode.trim(),
      );
      if (hasInk) textFills.push(fill);
    }

    if (fn === OPS.save) ctmStack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = ctmStack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.setFillRGBColor) fill = toHex(args);
    else if (fn === OPS.setStrokeRGBColor) stroke = toHex(args);
    else if (fn === OPS.constructPath) {
      // args: [pathOps, coords, minMax] across pdf.js 4.x builds
      const pathOps = args[0];
      const coords = args[1];
      pending = Array.isArray(pathOps) ? boxesFromPath(pathOps, coords).map(applyCtm) : [];
    } else if (
      fn === OPS.fill ||
      fn === OPS.eoFill ||
      fn === OPS.fillStroke ||
      fn === OPS.eoFillStroke
    ) {
      // fillStroke/eoFillStroke paint a fill AND an outline in one operator.
      // Missing them dropped the white panels on the investment pages, leaving
      // near-black text sitting on a navy background.
      const alsoStrokes = fn === OPS.fillStroke || fn === OPS.eoFillStroke;
      for (const r of pending ?? []) {
        if (r.w <= 0 && r.h <= 0) continue;
        const box = {
          x: round(r.x),
          y: round(r.y),
          w: round(r.w),
          h: round(r.h),
          radius: round(r.radius ?? 0),
        };
        shapes.push({ kind: r.curved ? 'roundRect' : 'rect', ...box, fill });
        if (alsoStrokes && stroke !== fill) {
          shapes.push({
            kind: r.curved ? 'roundRectOutline' : 'rule',
            ...box,
            stroke,
          });
        }
      }
      pending = null;
    } else if (fn === OPS.stroke) {
      for (const r of pending ?? []) {
        shapes.push({
          kind: r.curved ? 'roundRectOutline' : 'rule',
          x: round(r.x),
          y: round(r.y),
          w: round(r.w),
          h: round(r.h),
          radius: round(r.radius ?? 0),
          stroke,
        });
      }
      pending = null;
    }
  }

  // --- text runs -----------------------------------------------------------
  // pdf.js emits zero-width end-of-line items that never had a show-text op
  // behind them, so those are dropped before the colours are zipped on.
  const drawn = textContent.items.filter((it) => it.str && it.str.trim());

  // The zip assumes one show-text op per drawn item. Bail loudly rather than
  // silently colouring the deck wrong if that ever stops holding.
  if (textFills.length !== drawn.length) {
    console.warn(
      `  ! page ${pageNo}: ${textFills.length} show-text ops vs ${drawn.length} drawn items - colours may be misaligned`,
    );
  }

  const styles = textContent.styles ?? {};
  const seenRuns = new Set();
  const runs = drawn
    .map((it, idx) => ({ it, colour: textFills[idx] ?? '#000000' }))
    .map(({ it, colour }) => {
      const style = styles[it.fontName] ?? {};
      return {
        colour,
        text: it.str,
        x: round(it.transform[4]),
        y: round(it.transform[5]),
        size: round(Math.hypot(it.transform[2], it.transform[3]) || it.height),
        width: round(it.width),
        // The embedded fonts are subset with no usable family name (everything
        // reports as "sans-serif"), so the raw id is what distinguishes the
        // weights. It is mapped to a real weight by fontWeights below.
        fontId: it.fontName,
        font: style.fontFamily ?? it.fontName,
      };
    })
    // Page 10 of the SEO-only deck stamps its footer twice at identical
    // coordinates - a defect in whatever produced the original. Drawing the
    // same string twice in the same place is visually identical to drawing it
    // once, but it breaks the slot budgets, because each copy sees the other as
    // a neighbour and concludes it has no room to grow.
    .filter((r) => {
      const key = `${r.text}|${r.x}|${r.y}|${r.size}|${r.colour}`;
      if (seenRuns.has(key)) return false;
      seenRuns.add(key);
      return true;
    })
    .sort((a, b) => b.y - a.y || a.x - b.x);

  return {
    page: pageNo,
    width: round(viewport.width),
    height: round(viewport.height),
    shapes,
    runs,
  };
}

/**
 * Works out what each subset font id actually is.
 *
 * The embedded fonts carry no usable family name, so the roles are inferred
 * from behaviour: the face used for the largest type on the deck is the bold
 * one (the cover headline is always bold), and a face whose glyphs are all
 * non-alphabetic single characters is the ZapfDingbats used for the tick and
 * warning marks - those render as literal "3" and "!" if treated as text.
 */
function inferFonts(pages) {
  const byId = new Map();
  for (const p of pages) {
    for (const r of p.runs) {
      const e = byId.get(r.fontId) ?? { maxSize: 0, chars: new Set(), count: 0 };
      e.maxSize = Math.max(e.maxSize, r.size);
      e.count += 1;
      for (const ch of r.text.trim()) e.chars.add(ch);
      byId.set(r.fontId, e);
    }
  }

  const isDingbat = (e) =>
    e.count < 20 && [...e.chars].every((c) => !/[a-z0-9]/i.test(c) || '3'.includes(c));

  const textIds = [...byId.entries()].filter(([, e]) => !isDingbat(e));
  const boldId = textIds.sort((a, b) => b[1].maxSize - a[1].maxSize)[0]?.[0];

  const fonts = {};
  for (const [id, e] of byId) {
    if (isDingbat(e)) fonts[id] = 'ZapfDingbats';
    else if (id === boldId) fonts[id] = 'Helvetica-Bold';
    else fonts[id] = 'Helvetica';
  }
  return fonts;
}

/** Every colour the deck actually uses, most-used first. */
function collectPalette(pages) {
  const counts = new Map();
  const bump = (c) => c && counts.set(c, (counts.get(c) ?? 0) + 1);
  for (const p of pages) {
    for (const s of p.shapes) bump(s.fill ?? s.stroke);
    for (const r of p.runs) bump(r.colour);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
}

async function main() {
  const [file, name] = process.argv.slice(2);
  if (!file || !name) {
    console.error('usage: node extract-layout.mjs <pdf> <output-name>');
    process.exit(1);
  }

  const data = new Uint8Array(fs.readFileSync(path.resolve(file)));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;

  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    pages.push(await extractPage(await doc.getPage(p), p));
  }

  const spec = {
    source: path.basename(file),
    extractedAt: new Date().toISOString(),
    pageCount: doc.numPages,
    fonts: inferFonts(pages),
    palette: collectPalette(pages),
    pages,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${name}.geometry.json`);
  fs.writeFileSync(out, JSON.stringify(spec, null, 2));

  const shapeCount = pages.reduce((n, p) => n + p.shapes.length, 0);
  const runCount = pages.reduce((n, p) => n + p.runs.length, 0);
  console.log(`${name}: ${doc.numPages} pages, ${shapeCount} shapes, ${runCount} text runs -> ${out}`);
}

await main();
