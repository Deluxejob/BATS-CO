// Vercel serverless function — proxies Yahoo Finance's public chart API
// so ticker.html can pull daily closes for the main ticker + a few peers
// in parallel and render an overlay comparison chart client-side. No auth
// needed (this endpoint is public), and we cache aggressively at the edge
// so repeated hits from the same page don't hammer Yahoo.
//
// GET /api/history?syms=NVDA,AVGO,AMD&range=6mo
//   → { range, series: { NVDA: [[ts, close], ...], AVGO: [...], ... } }
//
// Only symbols that fetch successfully appear in `series`. Silent skip
// on individual failures — one dead ticker shouldn't nuke the whole
// response.

const YAHOO_UA = 'Mozilla/5.0 (BATS.CO history proxy)';

const RANGES = new Set(['1mo', '3mo', '6mo', '1y', '5y']);

async function fetchYahooChart(sym, range) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(sym) +
    '?range=' + encodeURIComponent(range) +
    '&interval=1d';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': YAHOO_UA } });
    if (!r.ok) return null;
    const data = await r.json();
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    if (!result) return null;
    const tss = result.timestamp;
    const closes = result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close;
    if (!Array.isArray(tss) || !Array.isArray(closes)) return null;
    const out = [];
    for (let i = 0; i < tss.length; i++) {
      const c = closes[i];
      if (typeof c !== 'number' || !Number.isFinite(c)) continue;
      out.push([tss[i], +c.toFixed(4)]);
    }
    return out.length ? out : null;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  const raw   = String(req.query.syms  || '').toUpperCase().trim();
  const range = String(req.query.range || '6mo').toLowerCase().trim();

  if (!RANGES.has(range)) {
    return res.status(400).json({ error: 'invalid range' });
  }

  // Split, dedupe, sanitize. Cap at 6 symbols to bound the fanout.
  const syms = Array.from(new Set(
    raw.split(',').map(s => s.trim()).filter(Boolean)
  )).slice(0, 6).filter(s => /^[A-Z0-9.\-]{1,10}$/.test(s));

  if (!syms.length) {
    return res.status(400).json({ error: 'no valid symbols' });
  }

  try {
    const results = await Promise.all(syms.map(s => fetchYahooChart(s, range)));
    const series = {};
    syms.forEach((s, i) => {
      if (results[i]) series[s] = results[i];
    });

    // Cache 15 min at the edge; individual daily closes don't move.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=900, stale-while-revalidate=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ range, count: Object.keys(series).length, series });
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: String((err && err.message) || err) });
  }
}
