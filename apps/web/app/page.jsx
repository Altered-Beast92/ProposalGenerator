'use client';

import { useEffect, useRef, useState } from 'react';

import { buildKeywordGroups, guessIndustry } from '../lib/keywords';

// Mirrors the roles in packages/spec/palette.json. Only the ones worth exposing
// in a first pass are here - the rest keep their defaults unless overridden.
const COLOUR_FIELDS = [
  ['primary', 'Primary accent', '#8734EF'],
  ['secondary', 'Secondary accent', '#08CDB2'],
  ['brandDeep', 'Dark background', '#211B56'],
  ['brandDeepAlt', 'Dark background (layer)', '#34247A'],
  ['primaryLight', 'Primary light', '#A85CF5'],
  ['primaryTint', 'Primary tint', '#F0E8FF'],
  ['secondaryTint', 'Secondary tint', '#E1F9F5'],
  ['ink', 'Headings', '#222132'],
  ['body', 'Body text', '#53566C'],
  ['muted', 'Captions', '#8E91A5'],
];

const PRESETS = {
  Original: {},
  Forest: {
    primary: '#0B6E4F', secondary: '#E0A526', brandDeep: '#0B2E23',
    brandDeepAlt: '#12513C', primaryLight: '#3E9B77', primaryTint: '#E4F2EC',
    secondaryTint: '#FBF1DA', ink: '#16211C', body: '#4A5952', muted: '#8A968F',
  },
  Ocean: {
    primary: '#1565C0', secondary: '#00B8D4', brandDeep: '#0A2540',
    brandDeepAlt: '#123A63', primaryLight: '#5E9CE8', primaryTint: '#E3EEFB',
    secondaryTint: '#DFF6FA', ink: '#12202E', body: '#4A5A6A', muted: '#8B98A5',
  },
  Ember: {
    primary: '#C2410C', secondary: '#0F766E', brandDeep: '#2B1508',
    brandDeepAlt: '#5A2A10', primaryLight: '#F97316', primaryTint: '#FDECE2',
    secondaryTint: '#DDF2F0', ink: '#241408', body: '#5C4A3E', muted: '#9A8A80',
  },
};

function MoneyField({ label, value, onChange }) {
  return (
    <label style={S.field}>
      <span style={S.fieldLabel}>{label}</span>
      <div style={S.moneyWrap}>
        <span style={S.moneyPrefix}>$</span>
        <input type="number" min="0" step="1" value={value}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          style={S.moneyInput} />
      </div>
    </label>
  );
}

function LogoField({ label, hint, value, onPick, onClear }) {
  return (
    <div style={S.logoRow}>
      <div style={S.logoPreview}>
        {value ? (
          <img src={value.dataUrl} alt="" style={S.logoImg} />
        ) : (
          <span style={S.logoEmpty}>none</span>
        )}
      </div>
      <div style={S.logoMeta}>
        <span style={S.fieldLabel}>{label}</span>
        <span style={S.hint}>{value ? value.name : hint}</span>
        <div style={S.logoActions}>
          <label style={S.logoPick}>
            {value ? 'Replace' : 'Choose file'}
            <input type="file" accept="image/png,image/jpeg,image/gif"
              onChange={(e) => onPick(e.target.files?.[0])} style={{ display: 'none' }} />
          </label>
          {value && (
            <button type="button" onClick={onClear} style={S.logoClear}>Remove</button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  const [template, setTemplate] = useState('seo-only');
  const [businessName, setBusinessName] = useState('');
  const [website, setWebsite] = useState('');
  const [region, setRegion] = useState('');
  const [presenter, setPresenter] = useState('');
  const [proposalDate, setProposalDate] = useState('');
  const [theme, setTheme] = useState({});
  const [preset, setPreset] = useState('Original');
  const [pdfUrl, setPdfUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [overflows, setOverflows] = useState([]);
  const [fitNotes, setFitNotes] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState(null);
  const [scanError, setScanError] = useState(null);
  // Findings are held as editable state, never sent straight through from the
  // scrape: the deck asserts these as facts about a real business.
  const [findings, setFindings] = useState([]);
  const [pricing, setPricing] = useState({
    currency: '$', seoFee: 750, adsAmount: 900, adsFee: 350,
    taxLabel: 'incl. GST', recommended: 'Growth',
    tiers: [
      { name: 'Starter', adsAmount: 300 },
      { name: 'Growth', adsAmount: 900 },
      { name: 'Pro', adsAmount: 1800 },
    ],
  });
  const [industry, setIndustry] = useState('');
  const [services, setServices] = useState([]);
  const [keywordGroups, setKeywordGroups] = useState([]);
  const [clientLogo, setClientLogo] = useState(null);

  function regenerateKeywords(next = {}) {
    const groups = buildKeywordGroups({
      industry: next.industry ?? industry,
      region: next.region ?? region,
      services: next.services ?? services,
    });
    setKeywordGroups(groups);
  }

  function updateKeyword(gi, patch) {
    setKeywordGroups((list) => list.map((g, i) => (i === gi ? { ...g, ...patch } : g)));
  }

  function updateTerm(gi, ti, value) {
    setKeywordGroups((list) =>
      list.map((g, i) =>
        i === gi ? { ...g, terms: g.terms.map((t, n) => (n === ti ? value : t)) } : g,
      ),
    );
  }
  const [presenterLogo, setPresenterLogo] = useState(null);
  const urlRef = useRef(null);

  function readLogo(file, set) {
    if (!file) return set(null);
    if (!file.type.startsWith('image/')) {
      setError(`${file.name} is not an image`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => set({ name: file.name, dataUrl: String(reader.result) });
    reader.readAsDataURL(file);
  }

  async function scanSite() {
    if (!website.trim()) return;
    setScanning(true);
    setScanError(null);
    setScan(null);
    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: website, region }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `scan failed (${res.status})`);

      setScan(json);
      setFindings(json.findings.map((f) => ({ ...f, include: true })));
      if (!businessName.trim() && json.businessName) setBusinessName(json.businessName);

      // Seed the keyword strategy from what the crawl found. Regenerated here
      // rather than from state, which has not updated yet at this point.
      const foundServices = json.services ?? [];
      const trade = industry.trim() || guessIndustry({ title: json.home.title, services: foundServices });
      setServices(foundServices);
      setIndustry(trade);
      setKeywordGroups(buildKeywordGroups({ industry: trade, region, services: foundServices }));

      // Auto-fill the client logo from the site, but never overwrite one the
      // user chose themselves.
      if (json.logo?.dataUrl && !clientLogo) {
        setClientLogo({
          name: `from ${new URL(json.site).hostname}`,
          dataUrl: json.logo.dataUrl,
          auto: true,
        });
      }
    } catch (err) {
      setScanError(String(err.message ?? err));
    } finally {
      setScanning(false);
    }
  }

  function updateFinding(i, patch) {
    setFindings((list) => list.map((f, n) => (n === i ? { ...f, ...patch } : f)));
  }

  // Blob URLs leak until explicitly revoked, and this page creates a new one on
  // every generate.
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  function applyPreset(name) {
    setPreset(name);
    setTheme({ ...PRESETS[name] });
  }

  function setColour(role, value) {
    setPreset('Custom');
    setTheme((t) => ({ ...t, [role]: value }));
  }

  async function generate(e) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    setOverflows([]);
    setFitNotes([]);

    try {
      const chosen = findings.filter((f) => f.include).slice(0, 6);
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template, businessName, region, presenter, proposalDate, theme,
          pricing,
          keywordGroups,
          clientLogo: clientLogo?.dataUrl ?? null,
          presenterLogo: presenterLogo?.dataUrl ?? null,
          findings: chosen.map(({ label, detail }) => ({ label, detail })),
          sourceNote: scan
            ? `Source: public review of ${new URL(scan.site).hostname}, ${
                proposalDate || new Date().toLocaleString('en-AU', { month: 'long', year: 'numeric' })
              }.`
            : '',
        }),
      });

      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.detail || detail.error || `render failed (${res.status})`);
      }

      const count = Number(res.headers.get('X-Overflow-Count') ?? 0);
      if (count > 0) {
        const raw = decodeURIComponent(res.headers.get('X-Overflow-Detail') ?? '');
        setOverflows(raw ? raw.split(' | ') : [`${count} text run(s) overflow their space`]);
      }

      const rawFit = decodeURIComponent(res.headers.get('X-Fit-Notes') ?? '');
      if (rawFit) setFitNotes(rawFit.split(' | '));

      const blob = await res.blob();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = URL.createObjectURL(blob);
      setPdfUrl(urlRef.current);
    } catch (err) {
      setError(String(err.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={S.page}>
      <div style={S.shell}>
        <form style={S.panel} onSubmit={generate}>
          <header style={S.header}>
            <h1 style={S.h1}>Proposal Generator</h1>
            <p style={S.sub}>Layout is fixed. Only content and colour change.</p>
          </header>

          <Section title="Proposal type">
            <div style={S.radioRow}>
              {[['seo-only', 'SEO only', '11 pages'], ['seo-ads', 'SEO + Google Ads', '18 pages']].map(
                ([value, label, meta]) => (
                  <label key={value} style={{ ...S.radio, ...(template === value ? S.radioOn : {}) }}>
                    <input
                      type="radio"
                      name="template"
                      value={value}
                      checked={template === value}
                      onChange={() => setTemplate(value)}
                      style={{ marginRight: 8 }}
                    />
                    <span>
                      <strong>{label}</strong>
                      <span style={S.meta}> · {meta}</span>
                    </span>
                  </label>
                ),
              )}
            </div>
          </Section>

          <Section title="Business">
            <Field label="Business name" value={businessName} onChange={setBusinessName}
              placeholder="e.g. Nova Care Australia" />
            <Field label="Region" value={region} onChange={setRegion}
              placeholder="e.g. Southern Sydney"
              hint="Used to judge whether the site targets local search." />
            <label style={S.field}>
              <span style={S.fieldLabel}>Website</span>
              <div style={S.inlineRow}>
                <input type="text" value={website} placeholder="https://example.com.au"
                  onChange={(e) => setWebsite(e.target.value)} style={{ ...S.input, flex: 1 }} />
                <button type="button" onClick={scanSite} disabled={scanning || !website.trim()}
                  style={{ ...S.scan, ...(scanning || !website.trim() ? S.scanOff : {}) }}>
                  {scanning ? 'Scanning…' : 'Scan site'}
                </button>
              </div>
              <span style={S.hint}>Fetches the site and drafts findings for you to review.</span>
            </label>

            {scanError && (
              <div style={S.error}><strong>Scan failed</strong><pre style={S.pre}>{scanError}</pre></div>
            )}
          </Section>

          {scan && (
            <Section title={`Findings — review before generating`}>
              <div style={S.scanMeta}>
                Scanned <strong>{scan.pagesScanned}</strong> pages on {new URL(scan.site).hostname}
                {scan.failed.length > 0 && ` · ${scan.failed.length} failed`}
              </div>
              <p style={S.reviewNote}>
                These print as statements of fact about the business. Check each one, edit the
                wording, and untick anything you don't want to claim. The deck fits six.
              </p>
              {findings.map((f, i) => (
                <div key={i} style={{ ...S.finding, ...(f.include ? {} : S.findingOff) }}>
                  <div style={S.findingHead}>
                    <input type="checkbox" checked={f.include}
                      onChange={(e) => updateFinding(i, { include: e.target.checked })} />
                    <input type="text" value={f.label}
                      onChange={(e) => updateFinding(i, { label: e.target.value })}
                      style={S.findingLabel} />
                    <span style={{ ...S.sev, ...(S[`sev_${f.severity}`] ?? {}) }}>{f.severity}</span>
                  </div>
                  <textarea value={f.detail} rows={3}
                    onChange={(e) => updateFinding(i, { detail: e.target.value })}
                    style={S.findingDetail} />
                </div>
              ))}
              {findings.filter((f) => f.include).length > 6 && (
                <div style={S.warn}>
                  {findings.filter((f) => f.include).length} findings ticked, but the layout has six
                  slots. Only the first six will be used.
                </div>
              )}
            </Section>
          )}

          <Section title="Presentation">
            <Field label="Presented by" value={presenter} onChange={setPresenter} placeholder="WPPRO" />
            <Field label="Date" value={proposalDate} onChange={setProposalDate} placeholder="August 2026" />
          </Section>

          <Section title="Keyword strategy">
            <div style={S.inlineRow}>
              <label style={{ ...S.field, flex: 1 }}>
                <span style={S.fieldLabel}>Trade term</span>
                <input type="text" value={industry} placeholder="e.g. mortgage broker"
                  onChange={(e) => setIndustry(e.target.value)} style={S.input} />
              </label>
              <button type="button" onClick={() => regenerateKeywords()}
                style={{ ...S.scan, alignSelf: 'flex-end', height: 38 }}>
                Rebuild
              </button>
            </div>
            <span style={S.hint}>
              Composed from the trade term, the region, and the services found on the site.
              Themes only — the page says volumes get validated in Keyword Planner.
            </span>

            {services.length > 0 && (
              <div style={S.scanMeta}>Services found: {services.slice(0, 6).join(', ')}</div>
            )}

            {keywordGroups.length === 0 ? (
              <span style={S.hint}>Scan a site, or set a trade term and press Rebuild.</span>
            ) : (
              keywordGroups.map((g, gi) => (
                <div key={gi} style={S.finding}>
                  <input type="text" value={g.heading} placeholder="GROUP HEADING"
                    onChange={(e) => updateKeyword(gi, { heading: e.target.value })}
                    style={S.findingLabel} />
                  {g.terms.map((t, ti) => (
                    <input key={ti} type="text" value={t} placeholder="keyword theme"
                      onChange={(e) => updateTerm(gi, ti, e.target.value)}
                      style={S.termInput} />
                  ))}
                </div>
              ))
            )}
          </Section>

          <Section title="Investment">
            <div style={S.moneyGrid}>
              <MoneyField label="SEO / month" value={pricing.seoFee}
                onChange={(v) => setPricing((p) => ({ ...p, seoFee: v }))} />
              {template === 'seo-ads' && (
                <MoneyField label="Ads mgmt fee" value={pricing.adsFee}
                  onChange={(v) => setPricing((p) => ({ ...p, adsFee: v }))} />
              )}
            </div>
            <div style={S.totalRow}>
              <span>Total per month</span>
              <strong style={S.totalValue}>
                {pricing.currency}
                {(template === 'seo-ads'
                  ? Number(pricing.seoFee || 0) +
                    Number(pricing.tiers.find((t) => t.name === pricing.recommended)?.adsAmount || 0) +
                    Number(pricing.adsFee || 0)
                  : Number(pricing.seoFee || 0)
                ).toLocaleString('en-AU')}
              </strong>
            </div>
            <span style={S.hint}>
              {template === 'seo-ads'
                ? 'Derived from the recommended tier’s ads spend plus the fees above, so the headline and the comparison table can never disagree.'
                : 'Derived, never typed in, so the deck cannot contradict itself.'}
            </span>

            {template === 'seo-ads' && (
              <>
                <span style={{ ...S.fieldLabel, marginTop: 4 }}>Package tiers (ads spend)</span>
                <div style={S.moneyGrid}>
                  {pricing.tiers.map((t, i) => (
                    <MoneyField key={t.name} label={t.name} value={t.adsAmount}
                      onChange={(v) => setPricing((p) => ({
                        ...p,
                        tiers: p.tiers.map((x, n) => (n === i ? { ...x, adsAmount: v } : x)),
                      }))} />
                  ))}
                </div>
                <label style={S.field}>
                  <span style={S.fieldLabel}>Recommended tier</span>
                  <select value={pricing.recommended} style={S.input}
                    onChange={(e) => setPricing((p) => ({ ...p, recommended: e.target.value }))}>
                    {pricing.tiers.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                  </select>
                </label>
              </>
            )}

            <Field label="Tax label" value={pricing.taxLabel}
              onChange={(v) => setPricing((p) => ({ ...p, taxLabel: v }))} placeholder="incl. GST" />
          </Section>

          <Section title="Logos">
            <p style={S.hint}>
              Both drop into panels the cover already reserves. Images are fitted inside their
              frame — the frame never resizes, so the layout cannot shift.
            </p>
            <LogoField label="Client logo" hint="Cover, upper left" value={clientLogo}
              onPick={(f) => readLogo(f, setClientLogo)} onClear={() => setClientLogo(null)} />
            <LogoField label="Presenter logo" hint="Cover, lower right" value={presenterLogo}
              onPick={(f) => readLogo(f, setPresenterLogo)} onClear={() => setPresenterLogo(null)} />
          </Section>

          <Section title="Colour scheme">
            <div style={S.presetRow}>
              {Object.keys(PRESETS).map((name) => (
                <button key={name} type="button" onClick={() => applyPreset(name)}
                  style={{ ...S.preset, ...(preset === name ? S.presetOn : {}) }}>
                  {name}
                </button>
              ))}
              {preset === 'Custom' && <span style={S.customTag}>Custom</span>}
            </div>
            <div style={S.swatchGrid}>
              {COLOUR_FIELDS.map(([role, label, fallback]) => (
                <label key={role} style={S.swatch}>
                  <input type="color" value={theme[role] ?? fallback}
                    onChange={(e) => setColour(role, e.target.value)} style={S.colourInput} />
                  <span style={S.swatchLabel}>{label}</span>
                </label>
              ))}
            </div>
          </Section>

          <button type="submit" disabled={busy} style={{ ...S.cta, ...(busy ? S.ctaBusy : {}) }}>
            {busy ? 'Generating…' : 'Generate PDF'}
          </button>

          {error && <div style={S.error}><strong>Render failed</strong><pre style={S.pre}>{error}</pre></div>}

          {fitNotes.length > 0 && (
            <div style={S.warn}>
              <strong>Copy trimmed to fit</strong>
              <p style={S.warnP}>The layout is fixed, so text longer than its slot was shortened. Edit the wording above if the trim reads badly.</p>
              <ul style={S.warnList}>{fitNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </div>
          )}

          {overflows.length > 0 && (
            <div style={S.warn}>
              <strong>Text overflow</strong>
              <p style={S.warnP}>Copy is wider than the space the design allows. Shorten it — the layout will not stretch.</p>
              <ul style={S.warnList}>{overflows.map((o, i) => <li key={i}>{o}</li>)}</ul>
            </div>
          )}
        </form>

        <section style={S.previewPane}>
          {pdfUrl ? (
            <>
              <div style={S.previewBar}>
                <span style={S.previewTitle}>Preview</span>
                <a href={pdfUrl} download={`${template}-proposal.pdf`} style={S.download}>Download</a>
              </div>
              <iframe src={pdfUrl} style={S.iframe} title="Proposal preview" />
            </>
          ) : (
            <div style={S.empty}>
              <p style={S.emptyTitle}>No proposal yet</p>
              <p style={S.emptyBody}>Fill in the details and hit Generate. Leave a field blank to keep the template's original wording.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function Section({ title, children }) {
  return (
    <section style={S.section}>
      <h2 style={S.h2}>{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, value, onChange, placeholder, hint, disabled }) {
  return (
    <label style={S.field}>
      <span style={S.fieldLabel}>{label}</span>
      <input type="text" value={value} placeholder={placeholder} disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...S.input, ...(disabled ? S.inputDisabled : {}) }} />
      {hint && <span style={S.hint}>{hint}</span>}
    </label>
  );
}

const S = {
  page: { minHeight: '100vh', background: '#F4F4F7', fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', color: '#222132' },
  shell: { display: 'grid', gridTemplateColumns: 'minmax(360px, 460px) 1fr', gap: 24, padding: 24, maxWidth: 1600, margin: '0 auto', alignItems: 'start' },
  panel: { background: '#fff', borderRadius: 14, padding: 24, boxShadow: '0 1px 3px rgba(20,20,40,.10)', display: 'flex', flexDirection: 'column', gap: 22 },
  header: { borderBottom: '1px solid #E6E6EE', paddingBottom: 16 },
  h1: { margin: 0, fontSize: 22, letterSpacing: '-0.01em' },
  sub: { margin: '6px 0 0', color: '#7A7D90', fontSize: 13 },
  section: { display: 'flex', flexDirection: 'column', gap: 12 },
  h2: { margin: 0, fontSize: 11, letterSpacing: '.10em', textTransform: 'uppercase', color: '#8E91A5' },
  radioRow: { display: 'flex', flexDirection: 'column', gap: 8 },
  // Longhand border properties throughout: mixing the `border` shorthand with a
  // conditional `borderColor` makes React drop the colour on re-render, which
  // it warns about as a styling bug.
  radio: { display: 'flex', alignItems: 'center', borderWidth: 1.5, borderStyle: 'solid', borderColor: '#E1E1EA', borderRadius: 9, padding: '11px 13px', cursor: 'pointer', fontSize: 14, background: '#fff' },
  radioOn: { borderColor: '#8734EF', background: '#F7F2FF' },
  meta: { color: '#8E91A5', fontWeight: 400 },
  field: { display: 'flex', flexDirection: 'column', gap: 5 },
  fieldLabel: { fontSize: 13, fontWeight: 600 },
  input: { border: '1.5px solid #E1E1EA', borderRadius: 8, padding: '9px 11px', fontSize: 14, fontFamily: 'inherit', color: 'inherit' },
  inputDisabled: { background: '#F5F5F8', color: '#A0A2B0', cursor: 'not-allowed' },
  hint: { fontSize: 12, color: '#9A9CAC' },
  inlineRow: { display: 'flex', gap: 8, alignItems: 'stretch' },
  termInput: { borderWidth: 1, borderStyle: 'solid', borderColor: '#E6E6EE', borderRadius: 6, padding: '6px 9px', fontSize: 12, fontFamily: 'ui-monospace, monospace', color: '#53566C', background: '#FAFAFC' },
  moneyGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 10 },
  moneyWrap: { display: 'flex', alignItems: 'center', borderWidth: 1.5, borderStyle: 'solid', borderColor: '#E1E1EA', borderRadius: 8, paddingLeft: 9, background: '#fff' },
  moneyPrefix: { fontSize: 13, color: '#8E91A5' },
  moneyInput: { flex: 1, minWidth: 0, borderWidth: 0, padding: '9px 9px 9px 3px', fontSize: 14, fontFamily: 'inherit', color: 'inherit', background: 'none', outline: 'none' },
  totalRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#F7F2FF', borderRadius: 8, padding: '10px 13px', fontSize: 13, fontWeight: 600 },
  totalValue: { fontSize: 18, color: '#8734EF' },
  logoRow: { display: 'flex', gap: 11, alignItems: 'center', borderWidth: 1, borderStyle: 'solid', borderColor: '#E6E6EE', borderRadius: 9, padding: 9 },
  logoPreview: { width: 68, height: 46, flexShrink: 0, borderRadius: 6, background: '#F5F5F8', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  logoImg: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' },
  logoEmpty: { fontSize: 11, color: '#A0A2B0' },
  logoMeta: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 },
  logoActions: { display: 'flex', gap: 8, marginTop: 3 },
  logoPick: { fontSize: 12, color: '#8734EF', fontWeight: 600, cursor: 'pointer' },
  logoClear: { fontSize: 12, color: '#96261F', fontWeight: 600, cursor: 'pointer', background: 'none', borderWidth: 0, padding: 0, fontFamily: 'inherit' },
  scan: { borderWidth: 1.5, borderStyle: 'solid', borderColor: '#8734EF', background: '#fff', color: '#8734EF', borderRadius: 8, padding: '0 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  scanOff: { borderColor: '#E1E1EA', color: '#A0A2B0', cursor: 'not-allowed' },
  scanMeta: { fontSize: 12, color: '#53566C', background: '#F5F5F8', borderRadius: 7, padding: '8px 11px' },
  reviewNote: { margin: 0, fontSize: 12, color: '#7A5B10', background: '#FFF7E6', borderWidth: 1, borderStyle: 'solid', borderColor: '#F0DCAE', borderRadius: 7, padding: '9px 11px', lineHeight: 1.45 },
  finding: { borderWidth: 1, borderStyle: 'solid', borderColor: '#E6E6EE', borderRadius: 9, padding: 10, display: 'flex', flexDirection: 'column', gap: 7 },
  findingOff: { opacity: 0.45, background: '#FAFAFC' },
  findingHead: { display: 'flex', alignItems: 'center', gap: 8 },
  findingLabel: { flex: 1, borderWidth: 0, borderBottomWidth: 1, borderStyle: 'solid', borderColor: '#E6E6EE', fontSize: 13, fontWeight: 600, padding: '3px 0', fontFamily: 'inherit', color: 'inherit', background: 'none' },
  sev: { fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', padding: '2px 7px', borderRadius: 999, fontWeight: 700 },
  sev_danger: { background: '#FDECEC', color: '#96261F' },
  sev_warning: { background: '#FFF7E6', color: '#7A5B10' },
  sev_success: { background: '#E9F6EC', color: '#1F6B33' },
  presetRow: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  preset: { borderWidth: 1.5, borderStyle: 'solid', borderColor: '#E1E1EA', background: '#fff', borderRadius: 999, padding: '6px 13px', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', color: 'inherit', fontWeight: 400 },
  presetOn: { borderColor: '#8734EF', background: '#F7F2FF', color: '#8734EF', fontWeight: 600 },
  customTag: { fontSize: 12, color: '#8734EF', fontWeight: 600 },
  swatchGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 },
  swatch: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' },
  colourInput: { width: 30, height: 30, border: '1px solid #E1E1EA', borderRadius: 6, padding: 0, background: 'none', cursor: 'pointer' },
  swatchLabel: { color: '#53566C' },
  cta: { background: '#8734EF', color: '#fff', border: 'none', borderRadius: 9, padding: '13px 18px', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  ctaBusy: { background: '#B79AE0', cursor: 'wait' },
  error: { background: '#FDECEC', border: '1px solid #F3C4C4', borderRadius: 9, padding: 13, fontSize: 13, color: '#96261F' },
  pre: { margin: '6px 0 0', whiteSpace: 'pre-wrap', fontSize: 11, fontFamily: 'ui-monospace, monospace' },
  warn: { background: '#FFF7E6', border: '1px solid #F0DCAE', borderRadius: 9, padding: 13, fontSize: 13, color: '#7A5B10' },
  warnP: { margin: '5px 0 8px' },
  warnList: { margin: 0, paddingLeft: 18, fontFamily: 'ui-monospace, monospace', fontSize: 11 },
  findingDetail: { borderWidth: 1, borderStyle: 'solid', borderColor: '#E6E6EE', borderRadius: 7, padding: '7px 9px', fontSize: 12, fontFamily: 'inherit', color: '#53566C', lineHeight: 1.45, resize: 'vertical' },
  previewPane: { background: '#fff', borderRadius: 14, boxShadow: '0 1px 3px rgba(20,20,40,.10)', overflow: 'hidden', height: 'calc(100vh - 48px)', position: 'sticky', top: 24, display: 'flex', flexDirection: 'column' },
  previewBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 18px', borderBottom: '1px solid #E6E6EE' },
  previewTitle: { fontSize: 11, letterSpacing: '.10em', textTransform: 'uppercase', color: '#8E91A5' },
  download: { fontSize: 13, color: '#8734EF', fontWeight: 600, textDecoration: 'none' },
  iframe: { flex: 1, width: '100%', border: 'none' },
  empty: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 40 },
  emptyTitle: { margin: 0, fontSize: 16, fontWeight: 600, color: '#53566C' },
  emptyBody: { margin: '8px 0 0', fontSize: 13, color: '#9A9CAC', maxWidth: 340, lineHeight: 1.5 },
};
