/**
 * Round-trip check: does a rendered PDF land on the same coordinates as the
 * golden deck it was replayed from?
 *
 * This is the regression gate for "nothing moved". It re-extracts geometry from
 * the render and diffs it against the stored spec run by run, shape by shape.
 * Position drift is reported in points; anything above the tolerance fails.
 *
 *   node verify-fidelity.mjs seo-only ../../services/renderer/build/seo-only.pdf
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = path.resolve(HERE, '../../packages/spec');
const LAYOUT_DIR = path.join(SPEC_DIR, 'layouts');
const TOLERANCE = 0.5; // points

const argv = process.argv.slice(2);
const themeIdx = argv.indexOf('--theme');
const themePath = themeIdx >= 0 ? argv[themeIdx + 1] : null;
// Guard on themeIdx >= 0: when the flag is absent it is -1, and -1 + 1 === 0
// would drop the first positional argument.
const positional = argv.filter(
  (_, i) => themeIdx < 0 || (i !== themeIdx && i !== themeIdx + 1),
);
const [template, renderedPath] = positional;
if (!template || !renderedPath) {
  console.error('usage: node verify-fidelity.mjs <template> <rendered.pdf> [--theme theme.json]');
  process.exit(1);
}

// Colours are compared by semantic role rather than literal hex. The two decks
// ship slightly different values for the same role, and theming deliberately
// rewrites hexes, so a literal comparison would flag every intentional change.
// Comparing roles still catches the failure that matters: a mark coming out as
// the wrong *kind* of colour.
const paletteSpec = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, 'palette.json'), 'utf8'));
const roleOfHex = new Map();
for (const [role, meta] of Object.entries(paletteSpec.roles)) {
  for (const alias of meta.aliases) roleOfHex.set(alias.toUpperCase(), role);
}
// A themed render emits hexes that appear nowhere in the golden decks, so the
// active theme's values are registered as aliases too. Without this every
// recoloured run reads as an unknown literal and the whole check goes red.
const themedRole = new Map();
if (themePath) {
  const theme = JSON.parse(fs.readFileSync(path.resolve(themePath), 'utf8'));
  for (const [role, hex] of Object.entries(theme)) {
    if (role.startsWith('$')) continue;
    themedRole.set(String(hex).toUpperCase(), role);
  }
}

const roleOf = (hex) => {
  const key = String(hex).toUpperCase();
  return themedRole.get(key) ?? roleOfHex.get(key) ?? `literal:${hex}`;
};

// Re-use the extractor rather than duplicating its logic, so the comparison is
// always against the same interpretation of the PDF.
const tmp = path.join(HERE, '.verify');
fs.mkdirSync(tmp, { recursive: true });
const res = spawnSync(
  process.execPath,
  [path.join(HERE, 'extract-layout.mjs'), renderedPath, `__verify_${template}`],
  { encoding: 'utf8' },
);
if (res.status !== 0) {
  console.error(res.stderr || res.stdout);
  process.exit(1);
}

const golden = JSON.parse(
  fs.readFileSync(path.join(LAYOUT_DIR, `${template}.geometry.json`), 'utf8'),
);
const actualPath = path.join(LAYOUT_DIR, `__verify_${template}.geometry.json`);
const actual = JSON.parse(fs.readFileSync(actualPath, 'utf8'));

const problems = [];
let maxRunDrift = 0;
let maxShapeDrift = 0;
let comparedRuns = 0;
let comparedShapes = 0;
let iconRuns = 0;

if (golden.pageCount !== actual.pageCount) {
  problems.push(`page count: expected ${golden.pageCount}, got ${actual.pageCount}`);
}

for (const gp of golden.pages) {
  const ap = actual.pages.find((p) => p.page === gp.page);
  if (!ap) {
    problems.push(`p${gp.page}: missing from render`);
    continue;
  }

  if (gp.runs.length !== ap.runs.length) {
    problems.push(`p${gp.page}: ${gp.runs.length} runs expected, ${ap.runs.length} rendered`);
  }

  for (let i = 0; i < Math.min(gp.runs.length, ap.runs.length); i++) {
    const g = gp.runs[i];
    const a = ap.runs[i];
    comparedRuns++;

    // ZapfDingbats has no reliable reverse mapping to unicode - pdf.js decodes
    // every glyph in it as "n" - so icon runs are compared on geometry only.
    // See ICONS.md: these six marks are pending replacement with vector icons.
    const isIcon =
      golden.fonts?.[g.fontId] === 'ZapfDingbats' || actual.fonts?.[a.fontId] === 'ZapfDingbats';

    if (!isIcon && g.text !== a.text) {
      problems.push(`p${gp.page} run ${i}: text ${JSON.stringify(g.text)} != ${JSON.stringify(a.text)}`);
      continue;
    }
    if (isIcon) iconRuns++;
    const drift = Math.max(Math.abs(g.x - a.x), Math.abs(g.y - a.y));
    maxRunDrift = Math.max(maxRunDrift, drift);
    if (drift > TOLERANCE) {
      problems.push(
        `p${gp.page} run ${i}: moved ${drift.toFixed(2)}pt ` +
          `(${g.x},${g.y} -> ${a.x},${a.y}) ${JSON.stringify(g.text.slice(0, 30))}`,
      );
    }
    if (roleOf(g.colour) !== roleOf(a.colour)) {
      problems.push(
        `p${gp.page} run ${i}: colour role ${roleOf(g.colour)} (${g.colour}) ` +
          `-> ${roleOf(a.colour)} (${a.colour})`,
      );
    }
    if (Math.abs(g.size - a.size) > 0.05) {
      problems.push(`p${gp.page} run ${i}: size ${g.size} -> ${a.size}`);
    }
  }

  // Shapes are matched positionally; a count mismatch is itself the finding.
  if (gp.shapes.length !== ap.shapes.length) {
    problems.push(`p${gp.page}: ${gp.shapes.length} shapes expected, ${ap.shapes.length} rendered`);
  }
  for (let i = 0; i < Math.min(gp.shapes.length, ap.shapes.length); i++) {
    const g = gp.shapes[i];
    const a = ap.shapes[i];
    comparedShapes++;
    const drift = Math.max(
      Math.abs(g.x - a.x),
      Math.abs(g.y - a.y),
      Math.abs(g.w - a.w),
      Math.abs(g.h - a.h),
    );
    maxShapeDrift = Math.max(maxShapeDrift, drift);
    if (drift > TOLERANCE) {
      problems.push(
        `p${gp.page} shape ${i} (${g.kind}): moved/resized ${drift.toFixed(2)}pt ` +
          `(${g.x},${g.y} ${g.w}x${g.h} -> ${a.x},${a.y} ${a.w}x${a.h})`,
      );
    }
  }
}

fs.rmSync(actualPath, { force: true });
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`fidelity: ${template}`);
console.log(
  `  compared ${comparedRuns} runs, ${comparedShapes} shapes` +
    (iconRuns ? ` (${iconRuns} icon runs: geometry only)` : ''),
);
console.log(`  max text drift  ${maxRunDrift.toFixed(3)}pt (tolerance ${TOLERANCE})`);
console.log(`  max shape drift ${maxShapeDrift.toFixed(3)}pt (tolerance ${TOLERANCE})`);

if (problems.length) {
  console.error(`\n  ${problems.length} problem(s):`);
  for (const p of problems.slice(0, 40)) console.error(`    ${p}`);
  if (problems.length > 40) console.error(`    ... and ${problems.length - 40} more`);
  process.exit(1);
}

console.log('  PASS - render is positionally identical to the golden deck');
