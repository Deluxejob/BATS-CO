// Vercel serverless function — past earnings release dates for a US-listed
// company, straight from SEC EDGAR. Every US filer announces its quarterly
// results with an 8-K carrying Item 2.02 ("Results of Operations and
// Financial Condition"). The filing's acceptance time tells us whether the
// release landed before the open, during the session, or after the close.
//
// GET /api/earnings-dates?sym=AAPL
//   → { ticker, cik, source, count,
//       dates: [{ date: 'YYYY-MM-DD', time: 'bmo'|'dmh'|'amc', accepted: ISO }] }
//
// `date` is the Eastern-time calendar day of the release. Foreign issuers
// (who file 6-Ks without item codes), ETFs and indices have no such 8-Ks,
// so they get an empty list and the chart simply shows no markers.
//
// Cached at the edge for 12 hours — new releases land a few times a year.

const SEC_UA = 'BATS.CO research (deluxejob@yahoo.com)';
const MAX_EXTRA_FILES = 2;   // older-filing pages to follow beyond "recent"

async function secJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': SEC_UA } });
  if (!r.ok) return null;
  return r.json();
}

async function getCik(sym) {
  const d = await secJson('https://www.sec.gov/files/company_tickers.json');
  if (!d) return null;
  const norm = s => String(s || '').toUpperCase().replace(/[.\-]/g, '');
  for (const k in d) {
    if (d[k] && norm(d[k].ticker) === sym) return String(d[k].cik_str).padStart(10, '0');
  }
  return null;
}

// Eastern-time date and minutes-after-midnight for a UTC timestamp.
const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
function toEastern(iso) {
  const parts = ET_PARTS.formatToParts(new Date(iso));
  const g = k => (parts.find(p => p.type === k) || {}).value;
  return {
    date: `${g('year')}-${g('month')}-${g('day')}`,
    minutes: (parseInt(g('hour'), 10) % 24) * 60 + parseInt(g('minute'), 10),
  };
}

// Pull Item 2.02 8-Ks out of one EDGAR filings block (columnar arrays).
function collect(block, out) {
  if (!block || !Array.isArray(block.form)) return;
  for (let i = 0; i < block.form.length; i++) {
    if (block.form[i] !== '8-K') continue;                    // skip 8-K/A amendments
    const items = String((block.items && block.items[i]) || '');
    if (!items.split(',').map(s => s.trim()).includes('2.02')) continue;
    const accepted = block.acceptanceDateTime && block.acceptanceDateTime[i];
    if (!accepted) continue;
    const et = toEastern(accepted);
    const time = et.minutes < 9 * 60 + 30 ? 'bmo' : et.minutes >= 16 * 60 ? 'amc' : 'dmh';
    out.push({ date: et.date, time, accepted: new Date(accepted).toISOString() });
  }
}

export default async function handler(req, res) {
  const raw = String(req.query.sym || '').toUpperCase().trim();
  const sym = raw.replace(/[.\-]/g, '');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!/^[A-Z0-9]{1,10}$/.test(sym)) return res.status(400).json({ error: 'invalid symbol' });

  try {
    const cik = await getCik(sym);
    if (!cik) {
      res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=3600');
      return res.status(200).json({ ticker: raw, cik: null, source: 'sec-8k-2.02', count: 0, dates: [] });
    }
    const sub = await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
    if (!sub || !sub.filings) return res.status(502).json({ error: 'SEC submissions fetch failed' });

    const found = [];
    collect(sub.filings.recent, found);
    const extra = Array.isArray(sub.filings.files) ? sub.filings.files.slice(0, MAX_EXTRA_FILES) : [];
    for (const f of extra) {
      if (!f || !f.name) continue;
      collect(await secJson(`https://data.sec.gov/submissions/${f.name}`), found);
    }

    // One marker per day (a company occasionally files two on the same
    // day); keep the earliest acceptance. Oldest first.
    const byDate = {};
    for (const d of found) if (!byDate[d.date] || d.accepted < byDate[d.date].accepted) byDate[d.date] = d;
    const dates = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));

    res.setHeader('Cache-Control', 'public, s-maxage=43200, stale-while-revalidate=86400');
    return res.status(200).json({ ticker: raw, cik, source: 'sec-8k-2.02', count: dates.length, dates });
  } catch (err) {
    return res.status(502).json({ error: String((err && err.message) || err) });
  }
}
