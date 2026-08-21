/**
 * Maps reviewed scrape output onto the deck's content slots.
 *
 * The layout is fixed, so this is a fitting problem, not a formatting one: a
 * finding gets a heading and a known number of body lines, each with a
 * character budget taken from the slot schema. Copy that will not fit is
 * truncated here, visibly, rather than being left to overflow the frame.
 */
// Imported rather than read from disk: these are bundled by the build, which
// is what makes them exist in a serverless deployment. Reading them by path
// worked locally and would 500 on Vercel, where only apps/web is deployed and
// the tracer cannot see a runtime fs.readFileSync. `npm run sync-spec` (wired
// to predev/prebuild) refreshes these from packages/spec.
import bindings from '../spec/content/bindings.json';
import seoAdsSlots from '../spec/content/seo-ads.slots.json';
import seoOnlySlots from '../spec/content/seo-only.slots.json';

const SLOT_SPECS = {
  'seo-only': seoOnlySlots,
  'seo-ads': seoAdsSlots,
};

const slotCache = new Map();

export function loadBindings() {
  return bindings;
}

export function loadSlots(template) {
  if (!slotCache.has(template)) {
    const spec = SLOT_SPECS[template];
    if (!spec) throw new Error(`no slot spec for template '${template}'`);
    slotCache.set(template, new Map(spec.slots.map((s) => [s.key, s])));
  }
  return slotCache.get(template);
}

/**
 * Greedy word wrap across a fixed number of lines with individual budgets.
 * Returns exactly `budgets.length` strings, padding with '' so that unused
 * lines are explicitly blanked rather than left showing the template's copy.
 */
export function wrapToLines(text, budgets) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let i = 0;

  for (let l = 0; l < budgets.length; l++) {
    const budget = budgets[l];
    const isLast = l === budgets.length - 1;
    let line = '';

    while (i < words.length) {
      const candidate = line ? `${line} ${words[i]}` : words[i];
      if (candidate.length > budget) break;
      line = candidate;
      i++;
    }

    // A single word longer than the whole budget would loop forever otherwise.
    if (!line && i < words.length) {
      line = words[i].slice(0, Math.max(1, budget));
      i++;
    }

    // Anything still unplaced on the final line is signalled, not silently cut.
    if (isLast && i < words.length && line) {
      const ellipsis = '…';
      while (line.length + ellipsis.length > budget && line.includes(' ')) {
        line = line.slice(0, line.lastIndexOf(' '));
      }
      line = `${line}${ellipsis}`;
      i = words.length;
    }

    lines.push(line);
  }

  return lines;
}

const truncate = (s, max) =>
  String(s ?? '').length <= max ? String(s ?? '') : `${String(s).slice(0, Math.max(1, max - 1)).trimEnd()}…`;

/** Formats a number as currency with thousands separators and no decimals. */
export function money(amount, currency = '$') {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  return `${currency}${Math.round(n).toLocaleString('en-AU')}`;
}

/**
 * Writes the investment pages.
 *
 * Totals are always derived from the line items, never taken from input. The
 * deck states the same figures in several places - a heading, a prose intro,
 * the line items, the total, and on the ads deck a three-tier comparison table
 * - and any of them disagreeing is a commercial error, not a cosmetic one.
 */
function applyPricing(bindings, slots, pricing, content, notes, extras = {}) {
  const spec = bindings.pricing;
  if (!spec || !pricing) return;

  const cur = pricing.currency ?? '$';
  const seoFee = Number(pricing.seoFee) || 0;
  const adsFee = Number(pricing.adsFee) || 0;

  // The recommended tier is the single source of the headline ads spend. Taking
  // the label from `recommended` but the figure from a separate `adsAmount`
  // lets them disagree, which reads as "the Pro option fits your $2,590 target"
  // while the table shows Pro at $3,890.
  const recommendedName = pricing.recommended ?? '';
  const recommendedTier = Array.isArray(pricing.tiers)
    ? pricing.tiers.find((t) => t.name === recommendedName)
    : null;
  const adsAmount = recommendedTier
    ? Number(recommendedTier.adsAmount) || 0
    : Number(pricing.adsAmount) || 0;

  const amounts = { seoFee, adsAmount, adsFee };

  // Only line items this template actually has contribute to its total, so the
  // SEO-only deck totals the SEO fee alone rather than silently adding ads.
  const total = spec.lineItems.reduce((sum, item) => sum + (amounts[item.source] ?? 0), 0);

  const fill = (tpl, vars) =>
    tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));

  const vars = {
    seoFee: money(seoFee, cur),
    adsAmount: money(adsAmount, cur),
    adsFee: money(adsFee, cur),
    total: money(total, cur),
    recommended: pricing.recommended ?? 'Growth',
    presenter: extras.presenter || 'WPPRO',
  };

  const write = (key, text) => {
    if (!key || text === undefined || text === null) return;
    const max = slots.get(key)?.maxChars ?? 200;
    if (String(text).length > max) notes.push(`pricing: "${String(text).slice(0, 28)}…" trimmed to ${max} chars`);
    content[key] = String(text).length <= max ? String(text) : `${String(text).slice(0, max - 1).trimEnd()}…`;
  };

  if (spec.intro) write(spec.intro.key, fill(spec.intro.template, vars));
  if (spec.includesHeading) write(spec.includesHeading.key, fill(spec.includesHeading.template, vars));

  spec.lineItems.forEach((item) => {
    write(item.amount, money(amounts[item.source] ?? 0, cur));
    // An explicit label wins; otherwise a templated one keeps the row in step
    // with the recommended tier, so it cannot read "Growth package amount"
    // next to Pro's figure.
    if (pricing.labels?.[item.source]) write(item.label, pricing.labels[item.source]);
    else if (item.labelTemplate) write(item.label, fill(item.labelTemplate, vars));
  });

  write(spec.total, money(total, cur));
  if (pricing.taxLabel) write(spec.taxNote, pricing.taxLabel);

  if (Array.isArray(pricing.includes)) {
    spec.includes.forEach((key, i) => {
      if (pricing.includes[i] !== undefined) write(key, pricing.includes[i]);
    });
  }

  // Tier comparison table: every row's total is derived the same way as the
  // headline figure, so the recommended row always agrees with the page above.
  if (spec.table && Array.isArray(pricing.tiers)) {
    spec.table.rows.forEach((row, i) => {
      const tier = pricing.tiers[i];
      if (!tier) return;
      const tierAds = Number(tier.adsAmount) || 0;
      write(row.name, tier.name);
      write(row.ads, money(tierAds, cur));
      write(row.fee, money(adsFee, cur));
      write(row.seo, money(seoFee, cur));
      write(row.total, money(tierAds + adsFee + seoFee, cur));
    });

    if (spec.table.noteTemplate) {
      const budgets = spec.table.note.map((k) => slots.get(k)?.maxChars ?? 149);
      const wrapped = wrapToLines(fill(spec.table.noteTemplate, vars), budgets);
      spec.table.note.forEach((k, i) => {
        content[k] = wrapped[i];
      });
    }
  }
}

/**
 * Writes the keyword strategy page.
 *
 * A blank group leaves the template's own copy in place rather than printing an
 * empty card - a half-filled grid looks broken, whereas the sample terms at
 * least read as placeholders.
 */
function applyKeywords(bindings, slots, groups, content, notes) {
  const spec = bindings.keywords;
  if (!spec || !Array.isArray(groups)) return;

  const write = (key, text) => {
    if (!key || !text) return;
    const max = slots.get(key)?.maxChars ?? 74;
    if (String(text).length > max) {
      notes.push(`keyword "${String(text).slice(0, 30)}…" trimmed to ${max} chars`);
      content[key] = `${String(text).slice(0, max - 1).trimEnd()}…`;
    } else {
      content[key] = String(text);
    }
  };

  spec.groups.forEach((slotGroup, i) => {
    const group = groups[i];
    if (!group?.heading) return;
    write(slotGroup.heading, group.heading);
    slotGroup.terms.forEach((key, t) => write(key, group.terms?.[t]));
  });
}

/**
 * Builds the `--content` map the renderer consumes.
 *
 * Only blocks the caller actually supplied are written; everything else keeps
 * the template's original copy, so a partial review still produces a coherent
 * deck rather than a half-blank one.
 */
export function buildContent(
  template,
  {
    findings = [],
    sourceNote = '',
    findingsTitle = '',
    pricing = null,
    presenter = '',
    keywordGroups = null,
  } = {},
) {
  const bindings = loadBindings()[template];
  if (!bindings) throw new Error(`no bindings for template '${template}'`);
  const slots = loadSlots(template);
  const content = {};
  const notes = [];

  const budgetOf = (key, fallback) => slots.get(key)?.maxChars ?? fallback;

  if (findingsTitle) {
    content[bindings.findingsTitle] = truncate(findingsTitle, budgetOf(bindings.findingsTitle, 50));
  }
  if (sourceNote) {
    content[bindings.findingsSource] = truncate(sourceNote, budgetOf(bindings.findingsSource, 90));
  }

  bindings.findings.forEach((card, i) => {
    const finding = findings[i];
    if (!finding) return;

    const headingBudget = budgetOf(card.heading, 60);
    content[card.heading] = truncate(finding.label, headingBudget);
    if (finding.label.length > headingBudget) {
      notes.push(`finding ${i + 1} heading truncated to ${headingBudget} chars`);
    }

    const budgets = card.lines.map((k) => budgetOf(k, 89));
    const wrapped = wrapToLines(finding.detail, budgets);
    card.lines.forEach((key, l) => {
      content[key] = wrapped[l];
    });
    if (wrapped[wrapped.length - 1]?.endsWith('…')) {
      notes.push(`finding ${i + 1} detail did not fit in ${budgets.length} lines and was trimmed`);
    }
  });

  applyPricing(bindings, slots, pricing, content, notes, { presenter });
  applyKeywords(bindings, slots, keywordGroups, content, notes);

  return { content, notes };
}
