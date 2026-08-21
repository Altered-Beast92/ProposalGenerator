/**
 * Composes the keyword themes for the strategy page.
 *
 * These are deliberately *themes*, not researched terms - the deck says so on
 * the page itself ("Final keywords, volumes and priorities should be validated
 * in Keyword Planner during onboarding"). Nothing here knows search volume, so
 * it composes the intent patterns that matter for local service businesses
 * (service + location) and leaves ranking to the tools that can measure it.
 */

const TITLE_EXCEPTIONS = new Set(['ndis', 'sil', 'seo', 'gp', 'nsw', 'qld', 'vic']);

/** Cleans a location or service fragment for use inside a search phrase. */
function tidy(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Splits a free-text region into usable location tokens.
 * "Ingleburn and South-West Sydney" -> ["Ingleburn", "South-West Sydney"]
 */
export function splitLocations(region) {
  return tidy(region)
    .split(/\s*(?:,|\band\b|&|\/|\|)\s*/i)
    .map(tidy)
    .filter((s) => s.length > 2);
}

/**
 * Builds four keyword groups of three terms each, matching the page layout.
 *
 * The first group is always the core local theme (the industry term against
 * each location). The rest are one per service, so a business with three
 * service lines gets a group each.
 */
export function buildKeywordGroups({ industry = '', region = '', services = [] } = {}) {
  const locations = [...new Set(splitLocations(region))];
  const trade = tidy(industry);
  const phrase = (...parts) => parts.map(tidy).filter(Boolean).join(' ');

  // One shared seen-set across every group. Without it the same phrase turns up
  // in two cards - which happened whenever the trade term was also the first
  // service, so "CORE LOCAL" and "HOME LOAN" listed identical terms.
  const seen = new Set();
  const take = (candidates, count) => {
    const out = [];
    for (const c of candidates) {
      const term = tidy(c);
      // Reject empties, duplicates, and phrases that repeat a word back to
      // themselves ("home loan home loan").
      if (!term || seen.has(term.toLowerCase())) continue;
      const words = term.toLowerCase().split(' ');
      if (new Set(words).size !== words.length) continue;
      seen.add(term.toLowerCase());
      out.push(term);
      if (out.length === count) break;
    }
    while (out.length < count) out.push('');
    return out;
  };

  /** Location variants first, then intent modifiers to fill the third slot. */
  const variants = (subject) => [
    ...locations.map((loc) => phrase(subject, loc)),
    phrase('best', subject, locations[0]),
    phrase(subject, 'near me'),
  ];

  const groups = [{ heading: 'CORE LOCAL', terms: take(variants(trade), 3) }];

  // A service identical to the trade term would just restate the core group.
  const chosen = services
    .map(tidy)
    .filter(Boolean)
    .filter((s) => s.toLowerCase() !== trade.toLowerCase())
    .slice(0, 3);

  for (const service of chosen) {
    groups.push({ heading: service.toUpperCase(), terms: take(variants(service), 3) });
  }

  // The layout has exactly four groups of three. Short-handed inputs leave
  // blanks rather than inventing filler, so an unedited slot is obvious.
  while (groups.length < 4) groups.push({ heading: '', terms: ['', '', ''] });

  return groups.slice(0, 4);
}

/** Best guess at the trade term, e.g. "mortgage broker". Always user-editable. */
export function guessIndustry({ title = '', services = [] } = {}) {
  const words = tidy(title)
    .split(/\s*[|\-–—:]\s*/)
    .map(tidy)
    .filter(Boolean);

  // A tagline half of the title ("Mortgage & Finance Brokers Sydney") describes
  // the trade far more often than the brand half does.
  const descriptive = words.find((w) => /\b(broker|provider|services|specialist|agency|clinic|care|consultant|solicitor|lawyer|dentist|plumber|electrician)\b/i.test(w));
  if (descriptive) return descriptive.toLowerCase();

  return tidy(services[0] ?? '');
}

export function titleCase(value) {
  return tidy(value)
    .split(' ')
    .map((w) => (TITLE_EXCEPTIONS.has(w.toLowerCase()) ? w.toUpperCase() : w))
    .join(' ');
}
