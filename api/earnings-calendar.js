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

  const url = 'https://finnhub.io/api/v1/calendar/earnings' +
    '?from=' + encodeURIComponent(from) +
    '&to='   + encodeURIComponent(to) +
    '&token=' + encodeURIComponent(key);

  try {
    const r = await fetch(url, { headers: { 'User-Agent': FINNHUB_UA } });
    if (!r.ok) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(502).json({ error: 'finnhub http ' + r.status });
    }
    const payload = await r.json();
    const arr = Array.isArray(payload && payload.earningsCalendar) ? payload.earningsCalendar : [];

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
