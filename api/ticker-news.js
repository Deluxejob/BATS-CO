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
// Why we still need to filter Finnhub's output:
//   Finnhub tags articles liberally — a "S&P 500 top movers" roundup
//   might list 30+ related tickers, and every one of those tickers
//   gets that article in its feed. To cut the noise, we require the
//   ticker OR the company's short name (pulled from Finnhub's
//   /profile2 endpoint) to appear as a whole word in the HEADLINE.
//   This is the same bar Yahoo Finance's own site uses — an editor
//   put the ticker/name in the headline because the article is
//   primarily about that company. Anything that only mentions the
//   ticker deep in a sector roundup gets dropped. We tried also
//   using Finnhub's `related` field to signal primary subject, but
//   Finnhub ranks related tickers alphabetically-ish, not by
//   relevance, so it let all the roundup noise through. If filtering
//   leaves fewer than 5 items we fall back to the raw list so tiny
//   tickers never end up with an empty card.
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

// Minimum items to leave in the filtered response. If aggressive
// filtering drops below this we return the raw list — tiny/OTC tickers
// often have only sector-roundup coverage and an empty card is worse
// than a noisy one.
const MIN_FILTERED = 5;

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

// Extract the "core" identifying word(s) from a company name so we
// can match it in headlines even when the article uses a short form.
// "Lumentum Holdings, Inc." → "lumentum"
// "The Coca-Cola Company"  → "coca-cola" (drops leading "The" + trailing "Company")
// "JPMorgan Chase & Co."   → "jpmorgan"
function shortNameTokens(fullName) {
  if (!fullName) return [];
  const cleaned = String(fullName)
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const stop = new Set([
    'the', 'inc', 'corp', 'corporation', 'company', 'co',
    'ltd', 'llc', 'plc', 'holdings', 'holding', 'group',
    'international', 'global', 'systems', 'technologies',
    'technology', 'industries', 'motors', 'and', '&',
  ]);
  const tokens = cleaned.toLowerCase().split(' ')
    .filter(w => w && !stop.has(w));
  // Keep the first 1-2 significant words. Most companies are known
  // by their leading word (Lumentum, Apple, Nvidia, JPMorgan) and
  // matching too aggressively (whole name) misses short-form usage.
  return tokens.slice(0, 2);
}

// Build a case-insensitive whole-word matcher for a ticker or name.
// Whole-word to avoid substring false positives (e.g. matching "LITE"
// inside "SATELLITE" or "Lumentum" inside "Lumen").
function wholeWordMatcher(term) {
  const t = String(term || '').trim();
  if (!t) return null;
  // Escape regex specials; allow hyphens (Coca-Cola) as word chars.
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^\\w-])' + esc + '($|[^\\w-])', 'i');
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
  const newsUrl = 'https://finnhub.io/api/v1/company-news' +
    '?symbol=' + encodeURIComponent(raw) +
    '&from=' + ymd(from) +
    '&to=' + ymd(now) +
    '&token=' + encodeURIComponent(key);
  const profileUrl = 'https://finnhub.io/api/v1/stock/profile2' +
    '?symbol=' + encodeURIComponent(raw) +
    '&token=' + encodeURIComponent(key);

  try {
    // Fire both requests in parallel — profile2 is cheap and its
    // result feeds our name-based headline filter.
    const [newsRes, profRes] = await Promise.all([
      fetch(newsUrl,    { headers: { 'User-Agent': FINNHUB_UA } }),
      fetch(profileUrl, { headers: { 'User-Agent': FINNHUB_UA } }),
    ]);

    if (!newsRes.ok) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(502).json({ error: 'finnhub news http ' + newsRes.status });
    }

    const raw_items = await newsRes.json();
    const arr = Array.isArray(raw_items) ? raw_items : [];

    // Profile is best-effort — if it fails, filter falls back to
    // ticker-only matching, which still cuts most of the roundup noise.
    let companyName = '';
    if (profRes.ok) {
      try {
        const p = await profRes.json();
        companyName = String(p && p.name || '');
      } catch (_) { /* ignore */ }
    }
    const nameTokens = shortNameTokens(companyName);
    const tickerRe   = wholeWordMatcher(raw);
    const nameRes    = nameTokens.map(wholeWordMatcher).filter(Boolean);

    // Score every article. Anything with score > 0 passes the filter.
    // We don't sort by score — we want chronological ordering — but
    // the scoring lets us reason about why an item was kept.
    const seen = new Set();
    const scored = [];
    for (const it of arr) {
      const link = String(it.url || '');
      const title = String(it.headline || '');
      if (!link || !title) continue;
      if (seen.has(link)) continue;
      seen.add(link);

      let score = 0;
      // Ticker as whole word in headline — strong "primary subject" signal
      if (tickerRe && tickerRe.test(title)) score += 3;
      // Any short-name token in headline — equally strong
      if (nameRes.some(r => r.test(title))) score += 3;

      scored.push({
        title,
        link,
        publisher:   String(it.source   || ''),
        publishedAt: Number(it.datetime) || 0,
        _score:      score,
      });
    }

    // Chronological newest-first, then split into kept vs dropped.
    scored.sort((a, b) => b.publishedAt - a.publishedAt);
    const filtered = scored.filter(x => x._score > 0);

    // Fallback: if filtering was too aggressive (tiny/OTC ticker with
    // only sector-roundup coverage) fall back to the unfiltered list
    // so the news card is never blank.
    const usedFallback = filtered.length < MIN_FILTERED;
    const finalList = (usedFallback ? scored : filtered).slice(0, 80);

    // Strip the internal _score before shipping.
    const items = finalList.map(({ _score, ...rest }) => rest);

    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({
      symbol: raw,
      count: items.length,
      companyName,
      filtered: !usedFallback,
      totalBeforeFilter: scored.length,
      items,
    });
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: String((err && err.message) || err) });
  }
}
