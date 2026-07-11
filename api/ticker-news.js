// Vercel serverless function — proxies Yahoo Finance's public news search
// so bats.co's client-side ticker.html can pull ticker-specific headlines
// without hitting a CORS wall. Zero auth, no crumb required (Yahoo's
// search endpoint is public), just server-side fetch + CORS headers.
//
// GET /api/ticker-news?sym=NVDA
//   → { symbol: "NVDA", items: [ { title, link, publisher, publishedAt }, ... ] }
//
// Yahoo's search endpoint caps each query at ~10 news items regardless of
// the newsCount param. To surface more unique headlines per ticker we run
// several parallel queries with different phrasings (bare ticker, ticker +
// "stock" / "earnings" / "news") and dedup by link. That's the same trick
// scripts/update-market-news.py uses for the broad-market feed.

const YAHOO_UA = 'Mozilla/5.0 (BATS.CO news proxy)';

async function fetchYahooNews(query) {
  const url = 'https://query1.finance.yahoo.com/v1/finance/search' +
    '?q=' + encodeURIComponent(query) +
    '&newsCount=30&quotesCount=0&enableFuzzyQuery=false';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': YAHOO_UA } });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data.news) ? data.news : [];
  } catch (e) {
    return [];  // one bad query shouldn't kill the whole response
  }
}

export default async function handler(req, res) {
  const raw = String(req.query.sym || '').toUpperCase().trim();
  // Only allow reasonable ticker characters — letters, digits, . and -
  // Length capped so we can't be used as an open Yahoo proxy.
  if (!/^[A-Z0-9.\-]{1,10}$/.test(raw)) {
    return res.status(400).json({ error: 'invalid symbol' });
  }

  const queries = [raw, `${raw} stock`, `${raw} earnings`, `${raw} news`];
  try {
    const buckets = await Promise.all(queries.map(fetchYahooNews));

    // Dedup by link; if a title-only duplicate slips in, fall back to title.
    const seen = new Set();
    const items = [];
    for (const bucket of buckets) {
      for (const it of bucket) {
        if (!it || !it.title || !it.link) continue;
        const key = it.link || it.title;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          title:       String(it.title       || ''),
          link:        String(it.link        || ''),
          publisher:   String(it.publisher   || ''),
          publishedAt: Number(it.providerPublishTime) || 0,
        });
      }
    }

    // Newest first, cap at 80 (well past a quarter's worth for any ticker).
    items.sort((a, b) => b.publishedAt - a.publishedAt);
    const trimmed = items.slice(0, 80);

    // Cache at the edge for 5 min; the browser hits us fresh (no-store below).
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ symbol: raw, count: trimmed.length, items: trimmed });
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: String((err && err.message) || err) });
  }
}
