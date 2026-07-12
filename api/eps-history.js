// Vercel serverless function — proxies SEC XBRL "companyfacts" so ticker.html
// can render a historical forward-12M P/E chart without downloading a 4 MB
// data file per pageview. Returns compact quarterly EPS with fiscal Q4
// derived from the annual 10-K (since Q4 isn't filed as its own 10-Q).
//
// GET /api/eps-history?sym=NVDA
//   → { ticker, cik, quarterlyEps: [{end,eps,fp,derived}, ...] }
//
// Cached hard at the edge (24h) — financial statements only change on
// filing days, so serving the same numbers all day is fine and keeps
// SEC's rate-limiter happy.

const SEC_UA = 'BATS.CO research (deluxejob@yahoo.com)';

async function getCik(sym) {
  const r = await fetch('https://www.sec.gov/files/company_tickers.json', {
    headers: { 'User-Agent': SEC_UA },
  });
  if (!r.ok) return null;
  const d = await r.json();
  for (const k in d) {
    if (d[k] && d[k].ticker === sym) {
      return String(d[k].cik_str).padStart(10, '0');
    }
  }
  return null;
}

async function getFacts(cik) {
  const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
    headers: { 'User-Agent': SEC_UA },
  });
  if (!r.ok) return null;
  return r.json();
}

// XBRL span in days from ISO strings.
function spanDays(startIso, endIso) {
  return (Date.parse(endIso) - Date.parse(startIso)) / 86400000;
}

function extractQuarterlyEps(facts) {
  // Prefer diluted; fall back to basic if the ticker never reports diluted.
  const usgaap = (facts && facts.facts && facts.facts['us-gaap']) || {};
  const src =
    (usgaap.EarningsPerShareDiluted && usgaap.EarningsPerShareDiluted.units && usgaap.EarningsPerShareDiluted.units['USD/shares']) ||
    (usgaap.EarningsPerShareBasic   && usgaap.EarningsPerShareBasic.units   && usgaap.EarningsPerShareBasic.units['USD/shares']) ||
    [];

  // Standalone Q1/Q2/Q3 rows (has `frame`, span ~90d). Keep latest-filed
  // for each unique end date (restatements overwrite older).
  const qByEnd = {};
  for (const x of src) {
    if (!x || !x.frame || !x.start || !x.end) continue;
    const s = spanDays(x.start, x.end);
    if (s < 60 || s > 100) continue;
    if (x.fp !== 'Q1' && x.fp !== 'Q2' && x.fp !== 'Q3') continue;
    const prev = qByEnd[x.end];
    if (!prev || (x.filed || '') > (prev.filed || '')) {
      qByEnd[x.end] = { end: x.end, eps: Number(x.val), fp: x.fp, filed: x.filed || '' };
    }
  }
  const quarterly = Object.values(qByEnd).sort((a, b) => a.end.localeCompare(b.end));

  // Annual 10-K rows (~365d, form=10-K)
  const aByEnd = {};
  for (const x of src) {
    if (!x || !x.start || !x.end) continue;
    const s = spanDays(x.start, x.end);
    if (s < 350 || s > 380) continue;
    if (x.form !== '10-K') continue;
    const prev = aByEnd[x.end];
    if (!prev || (x.filed || '') > (prev.filed || '')) {
      aByEnd[x.end] = { end: x.end, eps: Number(x.val), filed: x.filed || '' };
    }
  }
  const annual = Object.values(aByEnd).sort((a, b) => a.end.localeCompare(b.end));

  // Derive Q4 = annual − (Q1+Q2+Q3) via end-date proximity, since XBRL's
  // fy field gets restated by later filings and can't be trusted for
  // grouping. Match by "3 most recent quarterlies ending within 300 days
  // before this annual's end date."
  const q4 = [];
  for (const ann of annual) {
    const E = Date.parse(ann.end);
    const win = quarterly.filter(q => {
      const t = Date.parse(q.end);
      return (E - t) > 60 * 86400000 && (E - t) <= 300 * 86400000;
    }).sort((a, b) => a.end.localeCompare(b.end));
    if (win.length < 3) continue;
    const prior3 = win.slice(-3);
    const q4Eps = ann.eps - prior3.reduce((s, q) => s + q.eps, 0);
    q4.push({ end: ann.end, eps: Math.round(q4Eps * 100) / 100, fp: 'Q4', derived: true });
  }

  return [...quarterly, ...q4].sort((a, b) => a.end.localeCompare(b.end));
}

export default async function handler(req, res) {
  const raw = String(req.query.sym || '').toUpperCase().trim();
  // SEC only lists US-domiciled equities without dots/dashes for our lookup
  // format — sanitize but stay permissive. Dot-tickers (BRK.B) look up as
  // BRKB in the company_tickers file, so we normalize.
  const sym = raw.replace(/[.\-]/g, '');
  if (!/^[A-Z0-9]{1,10}$/.test(sym)) {
    return res.status(400).json({ error: 'invalid symbol' });
  }

  try {
    const cik = await getCik(sym);
    if (!cik) {
      // Not an error — the ticker just isn't in SEC's US-equities file
      // (ETFs, indices, ADRs, etc.). Return empty for graceful client hide.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=3600');
      return res.status(200).json({ ticker: raw, cik: null, quarterlyEps: [] });
    }

    const facts = await getFacts(cik);
    if (!facts) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(502).json({ error: 'SEC XBRL fetch failed' });
    }

    const quarterlyEps = extractQuarterlyEps(facts);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=3600');
    return res.status(200).json({
      ticker: raw,
      cik,
      count: quarterlyEps.length,
      quarterlyEps,
    });
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: String((err && err.message) || err) });
  }
}
