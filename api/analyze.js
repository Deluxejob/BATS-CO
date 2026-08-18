// Vercel serverless function — asks Claude Haiku 4.5 to write a
// beginner-friendly research briefing on a ticker. Streams the model's
// response back to the browser as it generates so the reader watches
// the analysis appear word-by-word.
//
// Data path:
//   1. Client hits /api/analyze?sym=NVDA
//   2. We fetch our own /api/analyst + /api/quote + /api/history in
//      parallel to gather every proprietary data point (Yahoo Key
//      Stats, analyst consensus, insider trades, recent price action)
//   3. Structured "data context" gets stuffed into the Claude prompt
//   4. Claude streams a ~500-700 word research briefing back
//   5. We forward each SSE chunk to the browser and cache the complete
//      output for 24h so a re-click on the same ticker is free
//
// Cost + abuse control:
//   * Haiku 4.5 (claude-haiku-4-5-20251001), ~$0.008-0.018 per analysis
//   * 24h edge cache per ticker — one API call per ticker per day at most
//   * Per-IP rate limit: 5 analyses per hour (in-memory, per warm instance)
//   * ANTHROPIC_API_KEY env var required — set in Vercel dashboard
//
// GET /api/analyze?sym=NVDA
//   → text/event-stream with `data: {"type":"text","text":"..."}` chunks
//     ending with `data: {"type":"done"}`
//   → cached body reused across the 24h window

import Anthropic from '@anthropic-ai/sdk';

const MODEL        = 'claude-haiku-4-5-20251001';
const MAX_TOKENS   = 1800;       // ~1000 words worst case
const CACHE_TTL_MS = 24 * 3600 * 1000;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT   = 5;

// In-memory stores. Per-instance, so a cold start resets both. That's
// fine for a hobby-scale traffic pattern — a serious deployment would
// use Vercel KV or Upstash Redis instead. Both maps are bounded by
// natural churn: cache entries expire, rate entries expire.
const CACHE = new Map();            // sym → { analysis, storedAt }
const RATE  = new Map();            // ip → [timestamp, ...]

// Base URL for internal self-calls (api/analyst, api/quote, api/history).
// Vercel's VERCEL_URL is the ephemeral deployment host and doesn't
// self-fetch reliably from another serverless function, so we hit the
// canonical production domain — which shares the same edge cache the
// browser would hit anyway.
function baseUrl(req) {
  return 'https://bats.co';
}

function getClientIp(req) {
  // Vercel sits behind Cloudflare-style forwarding. Prefer the first
  // hop; fall back to raw remoteAddress if headers are missing.
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']);
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const bucket = (RATE.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (bucket.length >= RATE_LIMIT) return false;
  bucket.push(now);
  RATE.set(ip, bucket);
  return true;
}

// Fetch our own site's data endpoints for the ticker so Claude gets
// everything we already publish about it. Any failure returns null and
// the analysis just skips that section.
async function gatherContext(sym, base) {
  const [analystR, quoteR, histR] = await Promise.allSettled([
    fetch(`${base}/api/analyst?sym=${encodeURIComponent(sym)}`, { headers: { 'User-Agent': 'BATS.CO analyzer' } }),
    fetch(`${base}/api/quote?syms=${encodeURIComponent(sym)}&sector=1`,   { headers: { 'User-Agent': 'BATS.CO analyzer' } }),
    fetch(`${base}/api/history?syms=${encodeURIComponent(sym)}&range=6mo&interval=1d`, { headers: { 'User-Agent': 'BATS.CO analyzer' } }),
  ]);
  const safe = async (settled) => {
    if (settled.status !== 'fulfilled' || !settled.value.ok) return null;
    try { return await settled.value.json(); } catch (_) { return null; }
  };
  return {
    analyst: await safe(analystR),
    quote:   await safe(quoteR),
    history: await safe(histR),
  };
}

// Build a compact "here's what you know about this ticker" block for
// Claude. Deliberately compressed — Claude does not need pretty JSON,
// and every token saved is real money. Missing fields become "n/a" so
// Claude explicitly says "not available" instead of hallucinating.
function buildDataContext(sym, ctx) {
  const q  = ctx.quote  && ctx.quote.quotes && ctx.quote.quotes[sym];
  const a  = ctx.analyst;
  const ks = a && a.keyStatistics;
  const pf = a && a.profile;
  const er = a && a.earnings;
  const ins = (a && a.insiders) || [];
  const inst = (a && a.institutions) || [];

  const n = (v) => (v == null || !Number.isFinite(v)) ? 'n/a' : v;
  const pct = (v) => (v == null || !Number.isFinite(v)) ? 'n/a' : (v * 100).toFixed(1) + '%';
  const $$ = (v) => {
    if (v == null || !Number.isFinite(v)) return 'n/a';
    const abs = Math.abs(v);
    if (abs >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
    if (abs >= 1e9)  return '$' + (v / 1e9).toFixed(2)  + 'B';
    if (abs >= 1e6)  return '$' + (v / 1e6).toFixed(2)  + 'M';
    return '$' + v.toFixed(2);
  };

  // Recent price action — first vs last close of the 6-month window.
  let priceAction = 'n/a';
  const series = ctx.history && ctx.history.series && ctx.history.series[sym];
  if (Array.isArray(series) && series.length >= 2) {
    const first = series[0][1], last = series[series.length - 1][1];
    if (Number.isFinite(first) && Number.isFinite(last) && first > 0) {
      const chg = ((last - first) / first) * 100;
      priceAction = `${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% over the last 6 months (${first.toFixed(2)} → ${last.toFixed(2)})`;
    }
  }

  // Latest close + 52-week context
  const price52 = q ? `current ${$$(q.price)}, 52-wk range ${$$(q.fiftyTwoWeekLow)} – ${$$(q.fiftyTwoWeekHigh)}` : 'n/a';

  // Analyst ratings + target
  const rec  = (a && a.recommendation) || 'n/a';
  const tgt  = a && a.priceTarget;
  const tgtStr = tgt
    ? `mean ${$$(tgt.mean)}, low ${$$(tgt.low)}, high ${$$(tgt.high)}, ${n(a.analystCount)} analysts`
    : 'n/a';

  // Recent insider trades — last 5, mostly to flag "cluster of selling" or "director buying"
  const insiderLines = ins.slice(0, 5).map(t => {
    const dt = t.date ? new Date(t.date * 1000).toISOString().slice(0, 10) : 'n/a';
    return `  - ${dt}: ${t.filer || 'unknown'} (${t.title || '?'}) ${t.action || t.text || 'transaction'} ${t.shares ? t.shares.toLocaleString() + ' sh' : ''} ${t.value ? '(' + $$(t.value) + ')' : ''}`.trim();
  }).join('\n') || '  - no recent insider transactions on file';

  // Top institutional holders — top 3 for context, not exhaustive
  const instLines = inst.slice(0, 3).map(o => {
    return `  - ${o.name}: ${pct(o.pctHeld)} of shares (${o.shares ? o.shares.toLocaleString() + ' sh' : 'n/a'})`;
  }).join('\n') || '  - no institutional ownership data';

  // Earnings trajectory — annual EPS for the last 3 years + next 2 estimates
  const annual = (er && er.annual) || [];
  const epsLines = annual.slice(0, 6).map(y => {
    const yr = (y.endDate || y.period || '').slice(0, 4);
    return `  - ${yr}: EPS ${n(y.eps)}${y.period && y.period.startsWith('+') ? ' (est)' : ''}`;
  }).join('\n') || '  - no annual EPS data';

  const growthEst = (er && er.growth) || [];
  const grLines = growthEst.map(g =>
    `  - ${g.period} (${g.endDate || ''}): ${g.rate != null ? (g.rate * 100).toFixed(1) + '% YoY' : 'n/a'}`
  ).join('\n') || '  - no growth estimates';

  return `TICKER: ${sym}
COMPANY: ${(pf && pf.description) ? pf.description.slice(0, 400) : 'not available'}
SECTOR / INDUSTRY: ${(pf && pf.sector) || 'n/a'} / ${(pf && pf.industry) || 'n/a'}
EMPLOYEES: ${n(pf && pf.employees)}

PRICE:
  ${price52}
  Recent action: ${priceAction}

VALUATION:
  Market cap: ${$$(ks && ks.marketCap)}
  Trailing P/E: ${n(ks && ks.trailingPE)}
  Forward P/E: ${n(ks && ks.forwardPE)}
  PEG: ${n(ks && ks.pegRatio)}
  Price / Sales: ${n(ks && ks.priceToSales)}
  Price / Book: ${n(ks && ks.priceToBook)}
  EV / EBITDA: ${n(ks && ks.evToEbitda)}

PROFITABILITY (ttm):
  Revenue: ${$$(ks && ks.revenue)}
  Gross margin: ${pct(ks && ks.grossMargin)}
  Operating margin: ${pct(ks && ks.operatingMargin)}
  Profit margin: ${pct(ks && ks.profitMargin)}
  ROE: ${pct(ks && ks.returnOnEquity)}
  Revenue growth (yoy): ${pct(ks && ks.revenueGrowth)}
  Earnings growth (yoy): ${pct(ks && ks.earningsGrowth)}

BALANCE SHEET (mrq):
  Cash: ${$$(ks && ks.totalCash)}
  Debt: ${$$(ks && ks.totalDebt)}
  Debt/Equity: ${n(ks && ks.debtToEquity)}
  Current ratio: ${n(ks && ks.currentRatio)}

TECHNICAL:
  Beta (5Y): ${n(ks && ks.beta)}
  50-day MA: ${$$(ks && ks.day50Avg)}
  200-day MA: ${$$(ks && ks.day200Avg)}
  52-wk change: ${pct(ks && ks.change52Week)} (S&P 500 over same period: ${pct(ks && ks.sp500Change52Week)})

WALL STREET:
  Consensus: ${rec}
  Price target: ${tgtStr}

ANNUAL EPS (actual + forward estimates):
${epsLines}

FORWARD EPS GROWTH ESTIMATES:
${grLines}

RECENT INSIDER TRANSACTIONS:
${insiderLines}

TOP INSTITUTIONAL HOLDERS:
${instLines}
`;
}

// Data governs every NUMBER (Claude may never invent a figure, date,
// percentage, or forecast), but Claude is allowed to use its general
// knowledge to describe what the company does, who it competes with,
// industry dynamics, and management context.
const SYSTEM_PROMPT = `You are a senior equity research analyst writing a briefing on a stock for retail investors on BATS.CO.

TWO RULES ABOUT DATA:
1. For any NUMBER, DATE, PERCENTAGE, PRICE, or FINANCIAL FIGURE — use ONLY what the user message provides. Never invent, estimate, extrapolate, or forecast numeric values. If a number isn't in the data, say "not disclosed" or omit it.
2. For QUALITATIVE context — what the company actually does, main competitors, industry trends, competitive moat, management reputation, product cycle position, regulatory backdrop — you MAY use your general knowledge. If a claim depends on something that might have changed in the last 12 months (a specific product launch, executive change, lawsuit outcome), hedge with "as of the last available context" or "reportedly" rather than stating it as current fact.

NEVER make price predictions or forecasts of any kind.

Structure your response as these sections, in this order, each with a plain header (not markdown):
1. BUSINESS SNAPSHOT — what the company does, main product lines, how it makes money. Be specific: name actual products, business segments, customer types. This is where you use your knowledge.
2. INDUSTRY & COMPETITION — who else plays in this space, what the company's edge (or disadvantage) is, where the industry sits in its cycle. Name real competitors when you know them.
3. RECENT PRICE ACTION — last 3-6 months of movement using the price data provided. If you know a plausible narrative reason (earnings beat, sector rotation, sympathy move), suggest it as "one interpretation."
4. FUNDAMENTALS — margins, revenue growth, profitability trajectory. Contextualize: are these margins strong or weak for this industry?
5. VALUATION — vs the company's history where the data supports it, plus context on what multiples typically look like for this kind of business.
6. WHAT THE STREET SEES — analyst rating, price target, what analysts have been focused on lately if you have a sense of it.
7. TECHNICAL SETUP — using the 50-day / 200-day MA context and 52-week range provided. Plain-English description of the trend.
8. INSIDER SIGNAL — are officers and 10%+ owners buying or selling in the recent list? What's the typical pattern for this kind of company at this stage?
9. BULL / BASE / BEAR — 2-3 sentences each. Frame as "bulls point to..." and "bears worry about..." Use both the numbers AND the qualitative dynamics. NOT price predictions.
10. BOTTOM LINE — one paragraph tying it together. NO "buy" or "sell" language. "Watch for," "consider," "the setup suggests," "worth understanding before deciding" are fine.

Keep the total response under 1000 words. Write for a retail investor who understands stocks but isn't a pro — no unexplained jargon. If you use "EBITDA" once, define it in parentheses the first time.

End with this exact disclaimer on its own line, no formatting:
AI-generated commentary drawing on public data and general market context. Not investment advice. Do your own research.`;

function writeSSE(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export default async function handler(req, res) {
  const raw = String((req.query && req.query.sym) || '').toUpperCase().trim();
  if (!/^\^?[A-Z0-9.\-=]{1,10}$/.test(raw)) {
    res.status(400).json({ error: 'invalid symbol' });
    return;
  }

  // Set up SSE response early so any errors below can stream a
  // graceful failure event instead of leaving the browser hanging.
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders && res.flushHeaders();

  // 24h cache hit — replay the stored analysis in one chunk and done.
  const cached = CACHE.get(raw);
  if (cached && (Date.now() - cached.storedAt) < CACHE_TTL_MS) {
    writeSSE(res, { type: 'source', cached: true, ageMs: Date.now() - cached.storedAt });
    writeSSE(res, { type: 'text', text: cached.analysis });
    writeSSE(res, { type: 'done', cached: true });
    res.end();
    return;
  }

  // Rate limit — check after cache so cached hits stay free / unlimited.
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    writeSSE(res, {
      type: 'error',
      message: 'Rate limit reached (5 analyses per hour per visitor). Try again in a bit — cached analyses on other tickers still work.',
    });
    res.end();
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    writeSSE(res, { type: 'error', message: 'ANTHROPIC_API_KEY is not configured on the server.' });
    res.end();
    return;
  }

  // Fetch the ticker's context from our own data endpoints. Any that
  // fail leave "n/a" in the built context — the analysis just skips.
  let dataBlock, ctx;
  try {
    ctx = await gatherContext(raw, baseUrl(req));
    dataBlock = buildDataContext(raw, ctx);
  } catch (e) {
    writeSSE(res, { type: 'error', message: 'Failed to gather ticker data: ' + (e.message || e) });
    res.end();
    return;
  }

  // Fast-fail: if we couldn't pull ANY useful data from our own APIs
  // (unknown ticker, upstream Yahoo outage, etc.), don't waste an API
  // call — Claude would just write "not available" for every section.
  const q  = ctx.quote  && ctx.quote.quotes && ctx.quote.quotes[raw];
  const ks = ctx.analyst && ctx.analyst.keyStatistics;
  const hasAnyData = !!(q || ks || (ctx.history && ctx.history.series && ctx.history.series[raw]));
  if (!hasAnyData) {
    writeSSE(res, {
      type: 'error',
      message: `No data available for ${raw}. Check the ticker symbol, or try a well-covered name (e.g. AAPL, NVDA, SPY).`,
    });
    res.end();
    return;
  }

  const client = new Anthropic({ apiKey });
  let fullText = '';
  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `Write the briefing on ${raw} using this data:\n\n${dataBlock}` },
      ],
    });

    writeSSE(res, { type: 'source', cached: false });
    stream.on('text', (chunk) => {
      fullText += chunk;
      writeSSE(res, { type: 'text', text: chunk });
    });
    await stream.finalMessage();

    // Cache the full response for 24h so re-clicks are free.
    CACHE.set(raw, { analysis: fullText, storedAt: Date.now() });
    writeSSE(res, { type: 'done', cached: false });
    res.end();
  } catch (e) {
    // Any stream error — network, quota exceeded, invalid key — surfaces
    // as an SSE error event so the browser shows something explicit.
    writeSSE(res, { type: 'error', message: 'Analysis failed: ' + (e.message || e) });
    res.end();
  }
}
