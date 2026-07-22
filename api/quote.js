// Vercel serverless function — proxies Yahoo Finance's v7 quote endpoint
// so the watchlist can pull a batch of quick-look fields (name, price,
// day change, dividend yield, market cap) for many symbols in a single
// HTTP round-trip.
//
// Yahoo's v7 quote requires the same crumb rotation as quoteSummary
// (fc.yahoo.com cookie primer → /v1/test/getcrumb → module fetch), so we
// reuse the same pattern that api/analyst.js uses.
//
// GET /api/quote?syms=NVDA,AAPL,MU
//   → { symbols, quotes: { NVDA: {...}, AAPL: {...}, ... } }

const YAHOO_UA = 'Mozilla/5.0 (BATS.CO quote proxy)';

async function getCrumb() {
  const primer = await fetch('https://fc.yahoo.com/', {
    headers: { 'User-Agent': YAHOO_UA },
    redirect: 'follow',
  });
  const setCookies = primer.headers.getSetCookie
    ? primer.headers.getSetCookie()
    : (primer.headers.get('set-cookie') || '').split(/,(?=[^;]+=[^;]+;)/);
  const cookieHeader = (setCookies || [])
    .map(c => (c || '').split(';')[0])
    .filter(Boolean)
    .join('; ');

  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': YAHOO_UA, 'Cookie': cookieHeader },
  });
  const crumb = (await crumbRes.text()).trim();
  if (!crumb) throw new Error('empty crumb');
  return { crumb, cookieHeader };
}

// Trim Yahoo's fat quote object down to what the watchlist actually needs,
// plus the pre/post-market fields the quotes-page cards use to show
// extended-hours prices.
function compactQuote(q) {
  if (!q || typeof q !== 'object') return null;
  const pick = (k) => (typeof q[k] === 'number' && Number.isFinite(q[k])) ? q[k] : null;
  return {
    symbol:                 q.symbol || null,
    shortName:              q.shortName || q.longName || null,
    currency:               q.currency || null,
    price:                  pick('regularMarketPrice'),
    prevClose:              pick('regularMarketPreviousClose'),
    dayChange:              pick('regularMarketChange'),
    dayChangePct:           pick('regularMarketChangePercent'),
    // Yahoo returns dividend yield as a percentage number (e.g. 0.44 = 0.44%)
    // in trailingAnnualDividendYield (fraction) — normalize to percent below.
    dividendYieldPct:       Number.isFinite(q.trailingAnnualDividendYield)
                              ? q.trailingAnnualDividendYield * 100
                              : (Number.isFinite(q.dividendYield) ? q.dividendYield : null),
    marketCap:              pick('marketCap'),
    fiftyTwoWeekHigh:       pick('fiftyTwoWeekHigh'),
    fiftyTwoWeekLow:        pick('fiftyTwoWeekLow'),
    // Trailing 12-month PE and analyst-consensus forward 12-month PE.
    // For SPY/^GSPC these give us the forward-P/E for the whole US market.
    trailingPE:             pick('trailingPE'),
    forwardPE:              pick('forwardPE'),
    // Extended-hours fields. marketState is one of PRE, PREPRE, REGULAR,
    // POST, POSTPOST, CLOSED. Pre/post prices are only populated during
    // (or shortly after) their respective sessions.
    marketState:            q.marketState || null,
    preMarketPrice:         pick('preMarketPrice'),
    preMarketChange:        pick('preMarketChange'),
    preMarketChangePercent: pick('preMarketChangePercent'),
    preMarketTime:          pick('preMarketTime'),
    postMarketPrice:        pick('postMarketPrice'),
    postMarketChange:       pick('postMarketChange'),
    postMarketChangePercent: pick('postMarketChangePercent'),
    postMarketTime:         pick('postMarketTime'),
  };
}

export default async function handler(req, res) {
  const raw = String(req.query.syms || '').toUpperCase().trim();
  // Split, dedupe, sanitize. Cap at 20 (Yahoo v7 has no hard limit but we
  // don't want a runaway request either).
  // Allow the ^ prefix used for indices (^GSPC, ^DJI, ^IXIC) and the
  // trailing =F / =X suffixes used for futures and forex pairs
  // (ES=F, NQ=F, RTY=F, YM=F, EMD=F, EURUSD=X, DX-Y.NYB) alongside the
  // usual A-Z0-9.- ticker chars.
  const syms = Array.from(new Set(
    raw.split(',').map(s => s.trim()).filter(Boolean)
  )).filter(s => /^\^?[A-Z0-9.\-=]{1,10}$/.test(s)).slice(0, 20);

  if (!syms.length) {
    return res.status(400).json({ error: 'no valid symbols' });
  }

  try {
    const { crumb, cookieHeader } = await getCrumb();
    const url = 'https://query1.finance.yahoo.com/v7/finance/quote'
      + '?symbols=' + encodeURIComponent(syms.join(','))
      + '&crumb=' + encodeURIComponent(crumb);
    const r = await fetch(url, {
      headers: { 'User-Agent': YAHOO_UA, 'Cookie': cookieHeader },
    });
    if (!r.ok) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(502).json({ error: 'quote status ' + r.status });
    }
    const data = await r.json();
    const result = data && data.quoteResponse && data.quoteResponse.result;
    if (!Array.isArray(result)) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(502).json({ error: 'unexpected quote shape' });
    }

    const quotes = {};
    for (const q of result) {
      const c = compactQuote(q);
      if (c && c.symbol) quotes[c.symbol] = c;
    }

    // Cache 60 s at the edge — tight enough that pre-market / post-market
    // prices on the quotes page tick reasonably fresh, still cheap for
    // repeat page loads. Watchlist consumers get slightly fresher data
    // than before too.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=60');
    return res.status(200).json({ symbols: syms, count: Object.keys(quotes).length, quotes });
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: String((err && err.message) || err) });
  }
}
