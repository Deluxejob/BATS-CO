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

const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max']);
const INTERVALS = new Set(['1m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo']);

async function fetchYahooChart(sym, range, interval) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(sym) +
    '?range=' + encodeURIComponent(range) +
    '&interval=' + encodeURIComponent(interval);
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
  const raw      = String(req.query.syms     || '').toUpperCase().trim();
  const range    = String(req.query.range    || '6mo').toLowerCase().trim();
  const interval = String(req.query.interval || '1d').toLowerCase().trim();

  if (!RANGES.has(range)) {
    return res.status(400).json({ error: 'invalid range' });
  }
  if (!INTERVALS.has(interval)) {
    return res.status(400).json({ error: 'invalid interval' });
  }

  // Yahoo caret prefix (^GSPC etc) — allowed here since indices are a
  // legitimate use of this endpoint.
  const symRe = /^\^?[A-Z0-9.\-=]{1,15}$/;
  // Split, dedupe, sanitize. Cap at 6 symbols to bound the fanout.
  const syms = Array.from(new Set(
    raw.split(',').map(s => s.trim()).filter(Boolean)
  )).slice(0, 6).filter(s => symRe.test(s));

  if (!syms.length) {
    return res.status(400).json({ error: 'no valid symbols' });
  }

  try {
    const results = await Promise.all(syms.map(s => fetchYahooChart(s, range, interval)));
    const series = {};
    syms.forEach((s, i) => {
      if (results[i]) series[s] = results[i];
    });

    // Intraday responses need shorter cache since they move; daily+ are stable.
    // 60s for sub-day intervals, 15min otherwise.
    const isIntraday = /^(1m|5m|15m|30m|60m|90m|1h)$/.test(interval);
    const sMaxAge = isIntraday ? 60 : 900;
    res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=60`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ range, interval, count: Object.keys(series).length, series });
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: String((err && err.message) || err) });
  }
}
