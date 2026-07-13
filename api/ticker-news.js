// Vercel serverless function — proxies Finnhub's /company-news endpoint
// so ticker.html can pull ticker-tagged headlines from a source that
// actually knows which articles reference which symbol.
//
// GET /api/ticker-news?sym=NVDA
//   → { symbol: "NVDA", items: [ { title, link, publisher, publishedAt }, ... ] }
//
// Why not Yahoo any more:
//   Yahoo's public /v1/finance/search endpoint is a keyword search, not a
//   ticker-tag lookup. Querying "AAPL" surfaces any article that happens
//   to contain the string "AAPL" — including sector round-ups where AAPL
//   is one of many names — while Yahoo Finance's own website uses an
//   undocumented internal ticker-tag endpoint that returns much cleaner
//   per-ticker results. Finnhub's /company-news IS a tag-based lookup
//   and matches what Yahoo Finance shows on its own quote pages.
//
// The FINNHUB_API_KEY env var is set on Vercel (same key used by
// api/analyst.js for the peers fetch). Free-tier limits are ~60 req/min
// which is more than enough for our traffic — every reader load hits
// the s-maxage=300 edge cache first anyway.

const FINNHUB_UA = 'Mozilla/5.0 (BATS.CO news proxy)';

// How many days of history to pull. Finnhub returns everything in the
// window at once (no pagination), so 30d gives plenty of headlines for
// megacaps and a full month of context for smaller tickers.
const WINDOW_DAYS = 30;

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  const raw = String(req.query.sym || '').toUpperCase().trim();
  if (!/^[A-Z0-9.\-]{1,10}$/.test(raw)) {
    return res.status(400).json({ error: 'invalid symbol' });
  }

  const key = process.env.FINNHUB_API_KEY;
  if (!key) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(500).json({ error: 'FINNHUB_API_KEY not configured' });
  }

  const now = new Date();
  const from = new Date(now.getTime() - WINDOW_DAYS * 86400 * 1000);
  const url = 'https://finnhub.io/api/v1/company-news' +
    '?symbol=' + encodeURIComponent(raw) +
    '&from=' + ymd(from) +
    '&to=' + ymd(now) +
    '&token=' + encodeURIComponent(key);

  try {
    const r = await fetch(url, { headers: { 'User-Agent': FINNHUB_UA } });
    if (!r.ok) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(502).json({ error: 'finnhub http ' + r.status });
    }
    const raw_items = await r.json();
    const arr = Array.isArray(raw_items) ? raw_items : [];

    // Map Finnhub's shape to the field names the frontend already reads.
    // Dedup by URL (Finnhub occasionally lists the same article twice
    // when syndicated to multiple sources).
    const seen = new Set();
    const items = [];
    for (const it of arr) {
      const link = String(it.url || '');
      const title = String(it.headline || '');
      if (!link || !title) continue;
      if (seen.has(link)) continue;
      seen.add(link);
      items.push({
        title,
        link,
        publisher:   String(it.source   || ''),
        publishedAt: Number(it.datetime) || 0,
      });
    }

    // Newest first, cap at 80 (matches the previous Yahoo cap so
    // the frontend's SHOW MORE pagination behaves the same).
    items.sort((a, b) => b.publishedAt - a.publishedAt);
    const trimmed = items.slice(0, 80);

    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ symbol: raw, count: trimmed.length, items: trimmed });
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: String((err && err.message) || err) });
  }
}
