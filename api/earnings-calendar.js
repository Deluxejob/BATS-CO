// Vercel serverless function — proxies Finnhub's /calendar/earnings endpoint
// so quotes.html can render an at-a-glance earnings calendar for the coming
// week without exposing the API key client-side.
//
// GET /api/earnings-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
//   → { from, to, count, earnings: [{symbol, date, hour, epsEstimate,
//        epsActual, revenueEstimate, revenueActual, quarter, year}, ...] }
//
// Rows are sorted by date ascending, then by revenueEstimate descending
// (largest companies first) so consumers can just take the first N per
// date. Rows without a revenueEstimate sink to the bottom of their day.
//
// The FINNHUB_API_KEY env var is set on Vercel (same key used by
// api/ticker-news.js and api/analyst.js). Free-tier limits are ~60
// req/min; we cache 15min at the edge so real client traffic stays low.

const FINNHUB_UA = 'Mozilla/5.0 (BATS.CO earnings calendar)';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  const from = String(req.query.from || '').trim();
  const to   = String(req.query.to   || '').trim();
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
  }
  if (from > to) {
    return res.status(400).json({ error: 'from must be <= to' });
  }

  const key = process.env.FINNHUB_API_KEY;
  if (!key) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(500).json({ error: 'FINNHUB_API_KEY not configured' });
  }

  // Finnhub caps its response at ~1500 rows per call. On a 14-day window
  // during earnings season that overflow silently drops the near-term
  // days, which is exactly what we don't want. Split the requested
  // window into ≤7-day chunks, fan out in parallel, and merge.
  function fmt(d) {
    return d.getUTCFullYear() + '-' +
           String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
           String(d.getUTCDate()).padStart(2, '0');
  }
  function makeChunks(fromStr, toStr, chunkDays) {
    const start = new Date(fromStr + 'T00:00:00Z');
    const end   = new Date(toStr   + 'T00:00:00Z');
    const chunks = [];
    let cursor = start;
    while (cursor <= end) {
      const next = new Date(cursor);
      next.setUTCDate(next.getUTCDate() + chunkDays - 1);
      const chunkEnd = next > end ? end : next;
      chunks.push([fmt(cursor), fmt(chunkEnd)]);
      const jump = new Date(chunkEnd);
      jump.setUTCDate(jump.getUTCDate() + 1);
      cursor = jump;
    }
    return chunks;
  }

  async function fetchOne(f, t) {
    const url = 'https://finnhub.io/api/v1/calendar/earnings' +
      '?from=' + encodeURIComponent(f) +
      '&to='   + encodeURIComponent(t) +
      '&token=' + encodeURIComponent(key);
    const r = await fetch(url, { headers: { 'User-Agent': FINNHUB_UA } });
    if (!r.ok) throw new Error('finnhub http ' + r.status);
    const payload = await r.json();
    return Array.isArray(payload && payload.earningsCalendar) ? payload.earningsCalendar : [];
  }

  try {
    const chunks = makeChunks(from, to, 7);
    const results = await Promise.all(chunks.map(([f, t]) => fetchOne(f, t)));
    // Merge + dedupe on (symbol|date) so overlaps at chunk boundaries
    // don't produce dupes (there shouldn't be any given the +1 day step,
    // but cheap insurance).
    const seen = new Set();
    const arr = [];
    for (const chunk of results) {
      for (const x of chunk) {
        if (!x || !x.symbol || !x.date) continue;
        const key = x.symbol + '|' + x.date;
        if (seen.has(key)) continue;
        seen.add(key);
        arr.push(x);
      }
    }

    const rows = arr
      .filter(x => x && x.symbol && x.date)
      .map(x => ({
        symbol:           String(x.symbol),
        date:             String(x.date),
        hour:             x.hour || '',
        epsEstimate:      typeof x.epsEstimate === 'number' ? x.epsEstimate : null,
        epsActual:        typeof x.epsActual   === 'number' ? x.epsActual   : null,
        revenueEstimate:  typeof x.revenueEstimate === 'number' ? x.revenueEstimate : null,
        revenueActual:    typeof x.revenueActual   === 'number' ? x.revenueActual   : null,
        quarter:          x.quarter || null,
        year:             x.year    || null,
      }));

    rows.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      const aR = a.revenueEstimate == null ? -Infinity : a.revenueEstimate;
      const bR = b.revenueEstimate == null ? -Infinity : b.revenueEstimate;
      if (aR !== bR) return bR - aR;
      return a.symbol < b.symbol ? -1 : 1;
    });

    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=900, stale-while-revalidate=120');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ from, to, count: rows.length, earnings: rows });
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: String((err && err.message) || err) });
  }
}
