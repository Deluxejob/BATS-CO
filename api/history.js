// Vercel serverless function — proxies Yahoo Finance's public chart API
// so ticker.html can pull daily closes for the main ticker + a few peers
// in parallel and render an overlay comparison chart client-side. No auth
// needed (this endpoint is public), and we cache aggressively at the edge
// so repeated hits from the same page don't hammer Yahoo.
//
// GET /api/history?syms=NVDA,AVGO,AMD&range=6mo
//   → { range, series: { NVDA: [[ts, close], ...], AVGO: [...], ... } }
//
// Add &prepost=1 to include pre-market and after-hours bars on intraday
// intervals. The response then also carries `sessions`, the pre /
// regular / post boundaries (unix seconds) Yahoo reports for each
// symbol's current trading day, so a chart can lay the day out on a
// fixed 4:00 AM – 8:00 PM ET axis without guessing at DST or half-days.
//
// Only symbols that fetch successfully appear in `series`. Silent skip
// on individual failures — one dead ticker shouldn't nuke the whole
// response.

const YAHOO_UA = 'Mozilla/5.0 (BATS.CO history proxy)';

const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max']);
const INTERVALS = new Set(['1m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo']);

async function fetchYahooChart(sym, range, interval, wantOhlc, prepost) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(sym) +
    '?range=' + encodeURIComponent(range) +
    '&interval=' + encodeURIComponent(interval) +
    (prepost ? '&includePrePost=true' : '');
  try {
    const r = await fetch(url, { headers: { 'User-Agent': YAHOO_UA } });
    if (!r.ok) return null;
    const data = await r.json();
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    if (!result) return null;
    const tss = result.timestamp;
    const q = result.indicators && result.indicators.quote && result.indicators.quote[0];
    const closes = q && q.close;
    if (!Array.isArray(tss) || !Array.isArray(closes)) return null;
    const opens = q && q.open;
    const highs = q && q.high;
    const lows  = q && q.low;
    const vols  = q && q.volume;
    // Yahoo leaves the just-finished session's last bar with a null close
    // for hours after the bell (open/high/low are populated, close is not).
    // The loop below would drop that bar entirely, so every page fed by
    // this route showed the PRIOR day as "last close" all evening. The
    // response meta carries the official close (regularMarketPrice stamped
    // regularMarketTime), so patch it into the last bar — and only there.
    const meta = result.meta || {};
    // Session boundaries for the current trading day (pre / regular /
    // post), when Yahoo reports them. Passed through for intraday charts.
    let sessions = null;
    const ctp = meta.currentTradingPeriod;
    if (ctp && ctp.regular && Number.isFinite(ctp.regular.start) && Number.isFinite(ctp.regular.end)) {
      const span = p => (p && Number.isFinite(p.start) && Number.isFinite(p.end)) ? [p.start, p.end] : null;
      sessions = {
        pre: span(ctp.pre), regular: span(ctp.regular), post: span(ctp.post),
        gmtoffset: Number.isFinite(ctp.regular.gmtoffset) ? ctp.regular.gmtoffset
                 : (Number.isFinite(meta.gmtoffset) ? meta.gmtoffset : null),
      };
    }
    const lastI = tss.length - 1;
    if (lastI >= 0 && !Number.isFinite(closes[lastI])
        && Number.isFinite(meta.regularMarketPrice) && Number.isFinite(meta.regularMarketTime)
        && meta.regularMarketTime >= tss[lastI]) {
      const c = meta.regularMarketPrice;
      closes[lastI] = c;
      if (opens && !Number.isFinite(opens[lastI])) opens[lastI] = c;
      if (highs) highs[lastI] = Number.isFinite(highs[lastI]) ? Math.max(highs[lastI], c) : c;
      if (lows)  lows[lastI]  = Number.isFinite(lows[lastI])  ? Math.min(lows[lastI],  c) : c;
    }
    const out = [];
    for (let i = 0; i < tss.length; i++) {
      const c = closes[i];
      if (typeof c !== 'number' || !Number.isFinite(c)) continue;
      if (wantOhlc) {
        const o = opens && opens[i], h = highs && highs[i], l = lows && lows[i];
        if (![o, h, l].every(v => typeof v === 'number' && Number.isFinite(v))) continue;
        // Volume is optional — some indices report null. Zero-fill so the
        // client-side chart engine can always index p[5] safely.
        const rawV = vols && vols[i];
        const v = (typeof rawV === 'number' && Number.isFinite(rawV)) ? Math.round(rawV) : 0;
        out.push([tss[i], +o.toFixed(4), +h.toFixed(4), +l.toFixed(4), +c.toFixed(4), v]);
      } else {
        out.push([tss[i], +c.toFixed(4)]);
      }
    }
    return out.length ? { bars: out, sessions } : null;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  const raw       = String(req.query.syms     || '').toUpperCase().trim();
  const range     = String(req.query.range    || '6mo').toLowerCase().trim();
  const interval  = String(req.query.interval || '1d').toLowerCase().trim();
  const wantOhlc  = String(req.query.fields   || '').toLowerCase() === 'ohlc';
  const prepost   = String(req.query.prepost  || '') === '1';

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
    const results = await Promise.all(syms.map(s => fetchYahooChart(s, range, interval, wantOhlc, prepost)));
    const series = {}, sessions = {};
    syms.forEach((s, i) => {
      if (results[i]) {
        series[s] = results[i].bars;
        if (results[i].sessions) sessions[s] = results[i].sessions;
      }
    });

    // Intraday responses need shorter cache since they move; daily+ are stable.
    // 60s for sub-day intervals, 15min otherwise.
    const isIntraday = /^(1m|5m|15m|30m|60m|90m|1h)$/.test(interval);
    const sMaxAge = isIntraday ? 60 : 900;
    res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=60`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ range, interval, count: Object.keys(series).length, series, sessions });
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: String((err && err.message) || err) });
  }
}
