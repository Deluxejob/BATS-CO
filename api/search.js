// Vercel serverless function — company/ETF name search that resolves
// "apple" → AAPL, "vanguard total stock" → VTI, etc. Powers the
// autocomplete dropdown on the site's ticker lookup box.
//
// Backing endpoint: Yahoo Finance's public search API. No crumb dance
// required — this endpoint doesn't return quote data, so Yahoo hands
// results back with just a user-agent header. That means we skip the
// api/quote.js cookie-priming path entirely and just proxy the query
// through.
//
// GET /api/search?q=apple
//   → { results: [ { symbol, name, exchange, type }, ... ] }
//   → cached 5 min at the edge so repeat queries (e.g. every keystroke
//     as a visitor types "app", "appl", "apple") are usually free.
//
// The response is deliberately compact — no news, no market caps, no
// score field — so the autocomplete dropdown stays fast to render.

const YAHOO_URL = 'https://query1.finance.yahoo.com/v1/finance/search';
const MAX_RESULTS = 8;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
};

// Yahoo's quoteType values are inconsistent-case abbreviations
// (EQUITY / ETF / MUTUALFUND / INDEX / CURRENCY / CRYPTOCURRENCY / FUTURE).
// Trim to a small display-friendly label so the dropdown reads cleanly.
function labelType(t) {
  const s = String(t || '').toUpperCase();
  if (s === 'EQUITY')         return 'Stock';
  if (s === 'ETF')            return 'ETF';
  if (s === 'MUTUALFUND')     return 'Fund';
  if (s === 'INDEX')          return 'Index';
  if (s === 'CURRENCY')       return 'FX';
  if (s === 'CRYPTOCURRENCY') return 'Crypto';
  if (s === 'FUTURE')         return 'Future';
  return s || '';
}

export default async function handler(req, res) {
  const q = String((req.query && req.query.q) || '').trim();

  // Trivial input guard — bail early so we don't burn a network call on
  // an empty box (the client debounces but paranoia is cheap).
  if (q.length < 1 || q.length > 50) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ results: [] });
  }

  const url = YAHOO_URL
    + '?q=' + encodeURIComponent(q)
    + '&quotesCount=' + MAX_RESULTS
    + '&newsCount=0'
    + '&lang=en-US&region=US';

  try {
    const r = await fetch(url, { headers: HEADERS, cache: 'no-store' });
    if (!r.ok) throw new Error('yahoo status ' + r.status);
    const data = await r.json();
    const raw = Array.isArray(data && data.quotes) ? data.quotes : [];

    const results = raw
      .filter(q => q && q.symbol)
      .slice(0, MAX_RESULTS)
      .map(q => ({
        symbol:   String(q.symbol).toUpperCase(),
        name:     q.shortname || q.longname || q.symbol,
        exchange: q.exchDisp || q.exchange || '',
        type:     labelType(q.quoteType || q.typeDisp),
      }));

    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ results });
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ results: [], error: String(err && err.message || err) });
  }
}
