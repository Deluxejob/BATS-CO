// Vercel serverless function — assembles a per-ticker news feed by
// merging TWO sources so we get both freshness AND clean tagging:
//
//   1. Yahoo Finance's per-ticker RSS feed
//      (feeds.finance.yahoo.com/rss/2.0/headline?s=SYM)
//      → publishes wire-service headlines within minutes of the event
//      → the FRESH source; catches earnings-drop / breaking news
//      → noisy: some items are cross-ticker roundups that mention SYM
//        only in passing
//
//   2. Finnhub's /company-news endpoint
//      → publishes 2-6 hours behind Yahoo on hot news
//      → cleaner primary-subject tagging
//      → the CLEAN backfill source
//
// Both sources are filtered by the SAME headline-match rule: the ticker
// or the company's short name must appear as a whole word in the title.
// This removes the "S&P 500 top movers" roundups from both feeds while
// letting through anything an editor deemed primarily about the company.
// After filtering, we merge, dedupe by normalized title, and sort by
// publishedAt descending.
//
// GET /api/ticker-news?sym=NVDA
//   → { symbol, items: [ { title, link, publisher, publishedAt, source }, ... ] }
//
// The FINNHUB_API_KEY env var is set on Vercel (same key used by
// api/analyst.js for the peers fetch). Yahoo RSS has no auth.
// Every reader load hits the s-maxage=300 edge cache first anyway.

const FINNHUB_UA = 'Mozilla/5.0 (BATS.CO news proxy)';
const YAHOO_UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

// Minimal HTML-entity decode for RSS content — Yahoo escapes &amp; &lt;
// &gt; &quot; &apos; and numeric entities. Anything more exotic passes
// through as-is; ticker headlines almost never contain them.
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// Strip surrounding CDATA markers if present. Yahoo occasionally wraps
// title/description in <![CDATA[...]]> when they contain HTML entities.
function stripCData(s) {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i.exec(String(s || ''));
  return m ? m[1] : String(s || '');
}

// Parse a Yahoo RSS feed body into [{ title, link, publisher, publishedAt }].
// Deliberately regex-based (no XML parser dependency) — RSS shape is
// simple and stable, and we control what we do with the output.
function parseYahooRss(xml) {
  const out = [];
  if (typeof xml !== 'string' || !xml) return out;
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[1];
    const grab = (tag) => {
      const r = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
      const mm = r.exec(body);
      return mm ? decodeEntities(stripCData(mm[1]).trim()) : '';
    };
    const title = grab('title');
    const link  = grab('link');
    const pub   = grab('pubDate');
    if (!title || !link) continue;
    const ts = pub ? Math.floor(Date.parse(pub) / 1000) : 0;
    // Publisher — pull the domain from the URL. Yahoo RSS doesn't
    // include a publisher field, but the URL host tells us
    // (finance.yahoo.com, fool.com, thestreet.com, etc.).
    let publisher = '';
    try {
      const u = new URL(link);
      publisher = u.hostname.replace(/^www\./, '').replace(/\.com$/, '');
    } catch (_) { /* leave blank */ }
    out.push({
      title,
      link,
      publisher,
      publishedAt: Number.isFinite(ts) ? ts : 0,
    });
  }
  return out;
}

// Fetch Yahoo's per-ticker RSS feed. Best-effort — returns [] on any
// error so the caller falls back to Finnhub-only.
async function fetchYahooRss(sym) {
  const url = 'https://feeds.finance.yahoo.com/rss/2.0/headline'
    + '?s=' + encodeURIComponent(sym)
    + '&region=US&lang=en-US';
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': YAHOO_UA, 'Accept': 'application/rss+xml, text/xml' },
      redirect: 'follow',
    });
    if (!r.ok) return [];
    const xml = await r.text();
    return parseYahooRss(xml);
  } catch (_) {
    return [];
  }
}

// Normalized-title key for dedupe across sources. Same story from Yahoo
// and Finnhub often has slight punctuation/spacing differences, so
// squash to lowercase alnum for the compare.
function titleKey(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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
    // Fire all three requests in parallel:
    //   1. Finnhub /company-news — the clean-tagging backfill
    //   2. Finnhub /profile2     — company name for the headline filter
    //   3. Yahoo RSS             — the fresh headlines
    // profile2 is cheap and its result feeds our name-based headline
    // filter. Yahoo RSS is what gives us breaking-news speed.
    const [newsRes, profRes, yahooItems] = await Promise.all([
      fetch(newsUrl,    { headers: { 'User-Agent': FINNHUB_UA } }),
      fetch(profileUrl, { headers: { 'User-Agent': FINNHUB_UA } }),
      fetchYahooRss(raw),
    ]);

    // Finnhub failure isn't fatal any more — Yahoo RSS is often enough
    // on its own for hot names. We only 502 if BOTH sources are empty.
    let finnhubItems = [];
    if (newsRes.ok) {
      try {
        const raw_items = await newsRes.json();
        if (Array.isArray(raw_items)) finnhubItems = raw_items;
      } catch (_) { /* ignore */ }
    }

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

    // Score + normalize both feeds into one common shape.
    // Dedupe uses a normalized title key so the same story from Yahoo
    // and Finnhub (each with different URL formats and slight punctuation
    // differences) doesn't appear twice.
    const seenTitle = new Set();
    const scored = [];

    function scoreAndPush(title, link, publisher, publishedAt, source) {
      if (!title || !link) return;
      const key = titleKey(title);
      if (!key || seenTitle.has(key)) return;
      seenTitle.add(key);
      let s = 0;
      if (tickerRe && tickerRe.test(title)) s += 3;
      if (nameRes.some(r => r.test(title))) s += 3;
      scored.push({ title, link, publisher, publishedAt, source, _score: s });
    }

    // Yahoo first (fresher) so if two identical-titled stories arrive,
    // the Yahoo one wins the dedupe (its publishedAt is the earlier
    // wire time, so the reader sees the freshest timestamp).
    for (const it of yahooItems) {
      scoreAndPush(it.title, it.link, it.publisher || 'Yahoo', it.publishedAt, 'yahoo');
    }
    for (const it of finnhubItems) {
      scoreAndPush(
        String(it.headline || ''),
        String(it.url || ''),
        String(it.source || ''),
        Number(it.datetime) || 0,
        'finnhub',
      );
    }

    if (!scored.length) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(502).json({ error: 'both news sources returned empty' });
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
      sourceCounts: {
        yahoo:   yahooItems.length,
        finnhub: finnhubItems.length,
      },
      items,
    });
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: String((err && err.message) || err) });
  }
}
