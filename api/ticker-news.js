// Vercel serverless function — proxies Yahoo Finance's public news search
// so bats.co's client-side ticker.html can pull ticker-specific headlines
// without hitting a CORS wall. Zero auth, no crumb required (Yahoo's
// search endpoint is public), just server-side fetch + CORS headers.
//
// GET /api/ticker-news?sym=NVDA
//   → { symbol: "NVDA", items: [ { title, link, publisher, publishedAt }, ... ] }

export default async function handler(req, res) {
  const raw = String(req.query.sym || '').toUpperCase().trim();
  // Only allow reasonable ticker characters — letters, digits, . and -
  // Length capped so we can't be used as an open Yahoo proxy.
  if (!/^[A-Z0-9.\-]{1,10}$/.test(raw)) {
    return res.status(400).json({ error: 'invalid symbol' });
  }

  const yahooUrl =
    'https://query1.finance.yahoo.com/v1/finance/search' +
    '?q=' + encodeURIComponent(raw) +
    '&newsCount=30&quotesCount=0&enableFuzzyQuery=false';

  try {
    const upstream = await fetch(yahooUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (BATS.CO news proxy)' },
    });
    if (!upstream.ok) {
      throw new Error('yahoo status ' + upstream.status);
    }
    const data = await upstream.json();

    const items = (data.news || [])
      .filter((it) => it && it.title && it.link)
      .map((it) => ({
        title:       String(it.title || ''),
        link:        String(it.link || ''),
        publisher:   String(it.publisher || ''),
        publishedAt: Number(it.providerPublishTime) || 0,
      }));

    // Cache at the edge for 5 min; the browser hits us fresh (no-store below).
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ symbol: raw, count: items.length, items });
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: String(err && err.message || err) });
  }
}
