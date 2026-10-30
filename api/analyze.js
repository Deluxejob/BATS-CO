// Vercel serverless function — asks Claude Haiku 4.5 to write a
// beginner-friendly research briefing on a ticker. Streams the model's
// response back to the browser as it generates so the reader watches
// the analysis appear word-by-word.
//
// Data path:
//   1. Client hits /api/analyze?sym=NVDA
//   2. We fetch our own /api/analyst + /api/quote + /api/history +
//      /api/earnings-dates + /api/ticker-news in parallel to gather every
//      data point we publish (Yahoo Key Stats, analyst consensus, insider
//      trades, recent price action, the latest earnings release and the
//      stock's reaction to it, the latest headlines)
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
const MAX_TOKENS   = 2200;       // ~1100 words plus an earnings section
const CACHE_TTL_MS = 24 * 3600 * 1000;
// Right after an earnings report the reaction changes by the hour
// (pre-market, then the session), so the briefing is kept for less time.
const CACHE_TTL_RECENT_REPORT_MS = 2 * 3600 * 1000;
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
  const H = { headers: { 'User-Agent': 'BATS.CO analyzer' } };
  const [analystR, quoteR, histR, datesR, newsR] = await Promise.allSettled([
    fetch(`${base}/api/analyst?sym=${encodeURIComponent(sym)}`, H),
    fetch(`${base}/api/quote?syms=${encodeURIComponent(sym)}&sector=1`, H),
    fetch(`${base}/api/history?syms=${encodeURIComponent(sym)}&range=6mo&interval=1d`, H),
    // Exact earnings-release days from SEC 8-Ks (with before/after the
    // close) and the headlines of the last month: together they let the
    // briefing cover a report that landed last night and this morning's
    // reaction to it.
    fetch(`${base}/api/earnings-dates?sym=${encodeURIComponent(sym)}`, H),
    fetch(`${base}/api/ticker-news?sym=${encodeURIComponent(sym)}`, H),
  ]);
  const safe = async (settled) => {
    if (settled.status !== 'fulfilled' || !settled.value.ok) return null;
    try { return await settled.value.json(); } catch (_) { return null; }
  };
  return {
    analyst:       await safe(analystR),
    quote:         await safe(quoteR),
    history:       await safe(histR),
    earningsDates: await safe(datesR),
    news:          await safe(newsR),
  };
}

// Eastern-time formatting for the "today" line and the earnings block, so
// "last night" and "this morning" mean what a US reader expects.
const ET_WHEN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const etWhen = (ms) => ET_WHEN.format(new Date(ms)) + ' ET';
const etDay  = (ms) => ET_DAY.format(new Date(ms));          // YYYY-MM-DD in New York

// The most recent earnings release date on file (SEC 8-K Item 2.02), or ''.
function latestReportDate(earningsDates) {
  const dates = earningsDates && Array.isArray(earningsDates.dates) ? earningsDates.dates : [];
  return dates.length ? String(dates[dates.length - 1].date || '') : '';
}

// How many days a report is considered "recent" enough to get its own
// section in the briefing (and to shorten the cache so the reaction stays
// current through the day).
const RECENT_REPORT_DAYS = 10;

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

  // Today, in New York, and whether the market is open: without this the
  // model cannot tell "last night's report" from an old one.
  const nowMs = Date.now();
  const stateWord = { PRE: 'pre-market (before the 9:30 open)', PREPRE: 'pre-market (before the 9:30 open)', REGULAR: 'open (regular session)',
                      POST: 'after-hours', POSTPOST: 'closed (after-hours over)', CLOSED: 'closed' };
  const todayLine = `${etWhen(nowMs)} · market ${stateWord[q && q.marketState] || 'status unknown'}`;

  // ---- The latest earnings report and how the stock took it ----
  // SEC gives the exact release day and whether it was before or after the
  // close; Yahoo gives the quarter's numbers (sometimes a day late); the
  // daily closes give the last price before the release and the first
  // session after it; the live quote gives this morning's pre-market or
  // today's session move; the news feed gives what the market is reacting to.
  const earningsBlock = (() => {
    const dates = ctx.earningsDates && Array.isArray(ctx.earningsDates.dates) ? ctx.earningsDates.dates : [];
    const last = dates.length ? dates[dates.length - 1] : null;
    const nextTs = a && a.overview && a.overview.nextEarningsDate;
    const nextStr = nextTs ? ` Next report expected around ${etDay(nextTs * 1000)}.` : '';
    if (!last) return `LAST EARNINGS REPORT: no release date on file.${nextStr}`;
    const timing = last.time === 'amc' ? 'after the close' : last.time === 'bmo' ? 'before the open' : 'during the session';
    const ageDays = (nowMs - Date.parse(last.date + 'T16:00:00-04:00')) / 86400000;
    if (ageDays > RECENT_REPORT_DAYS) {
      return `LAST EARNINGS REPORT: ${last.date} (${timing}), about ${Math.round(ageDays)} days ago; not recent enough for its own section.${nextStr}`;
    }
    const L = [`LATEST EARNINGS REPORT (recent: ${Math.max(0, Math.round(ageDays))} day(s) ago):`];
    L.push(`  Released ${last.date} ${timing} (SEC 8-K filed ${etWhen(Date.parse(last.accepted))}).`);

    // The quarter's numbers, as Yahoo has them. Fiscal labels ("3Q2026") can
    // differ from calendar quarters, and Yahoo can lag the release by a day.
    const qs = (er && er.quarterly) || [];
    const lastQ = qs.length ? qs[qs.length - 1] : null;
    if (lastQ) {
      let surprise = '';
      if (Number.isFinite(lastQ.actual) && Number.isFinite(lastQ.estimate) && lastQ.estimate !== 0) {
        const s = (lastQ.actual / lastQ.estimate - 1) * 100;
        surprise = ` (${s >= 0 ? 'beat' : 'missed'} consensus by ${Math.abs(s).toFixed(1)}%)`;
      }
      L.push(`  Most recent quarter on file (Yahoo, fiscal label ${lastQ.period}): EPS ${n(lastQ.actual)} vs consensus ${Number.isFinite(lastQ.estimate) ? lastQ.estimate.toFixed(2) : 'n/a'}${surprise}`);
    }
    const fq = (er && er.finQuarterly) || [];
    const lastF = fq.length ? fq[fq.length - 1] : null;
    const prevF = fq.length > 1 ? fq[fq.length - 2] : null;
    const yoyF  = fq.length > 4 ? fq[fq.length - 5] : null;
    if (lastF) {
      L.push(`  ${lastF.period}: revenue ${$$(lastF.revenue)}, net income ${$$(lastF.netIncome)}` +
        (prevF ? `; prior quarter ${prevF.period}: ${$$(prevF.revenue)} / ${$$(prevF.netIncome)}` : '') +
        (yoyF ? `; same quarter a year earlier ${yoyF.period}: ${$$(yoyF.revenue)} / ${$$(yoyF.netIncome)}` : ''));
      L.push('  Revenue consensus: not on file. Do not say revenue beat or missed expectations unless a headline says so, and then attribute it.');
    }
    if (!lastQ && !lastF) L.push('  The quarter\'s numbers are not on file yet.');
    L.push('  (If the quarter label on file does not match this release, Yahoo has not updated yet: say the detailed numbers are not in and lean on the headlines.)');

    // The stock's reaction. Baseline = the last regular close before the
    // numbers came out: the report day's close for an after-the-close
    // release, the previous session's close otherwise.
    const series = ctx.history && ctx.history.series && ctx.history.series[sym];
    const rows = Array.isArray(series) ? series.map(r => ({ d: etDay(r[0] * 1000), c: r[1] })).filter(r => Number.isFinite(r.c)) : [];
    let base = null, baseIdx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if ((last.time === 'amc' && rows[i].d <= last.date) || (last.time !== 'amc' && rows[i].d < last.date)) { base = rows[i]; baseIdx = i; break; }
    }
    const chg = (now, then) => (Number.isFinite(now) && Number.isFinite(then) && then > 0) ? `${(now / then - 1) * 100 >= 0 ? '+' : ''}${((now / then - 1) * 100).toFixed(1)}%` : 'n/a';
    // The daily history includes today's bar while the session is running,
    // so a row dated today is a live price, not a close.
    const todayDay = etDay(nowMs);
    const st0 = q && q.marketState;
    const inProgress = (d) => d === todayDay && (st0 === 'REGULAR' || st0 === 'PRE' || st0 === 'PREPRE');
    if (base) {
      L.push(`  Last close before the release: $${base.c.toFixed(2)} on ${base.d}.`);
      if (last.time === 'amc' && baseIdx > 0) {
        L.push(`  (That day's regular session, before the numbers: ${chg(base.c, rows[baseIdx - 1].c)} close to close.)`);
      }
      const after = rows[baseIdx + 1];
      if (after && !inProgress(after.d)) L.push(`  First full session after the release: closed $${after.c.toFixed(2)} on ${after.d} (${chg(after.c, base.c)}).`);
      else if (after) L.push(`  The first session after the release is today and still in progress (no close yet).`);
      const lastRow = rows[rows.length - 1];
      if (rows[baseIdx + 2] && !inProgress(lastRow.d)) L.push(`  Latest close on file: $${lastRow.c.toFixed(2)} on ${lastRow.d} (${chg(lastRow.c, base.c)} since the release).`);
      if (q) {
        const st = q.marketState;
        if ((st === 'PRE' || st === 'PREPRE') && Number.isFinite(q.preMarketPrice)) {
          L.push(`  THIS MORNING (pre-market, ${etWhen(q.preMarketTime ? q.preMarketTime * 1000 : nowMs)}): $${q.preMarketPrice.toFixed(2)}, ${chg(q.preMarketPrice, q.price)} vs yesterday's close and ${chg(q.preMarketPrice, base.c)} since the last close before the release.`);
        } else if (st === 'REGULAR' && Number.isFinite(q.price)) {
          L.push(`  TODAY'S SESSION SO FAR (${etWhen(q.regularMarketTime ? q.regularMarketTime * 1000 : nowMs)}): $${q.price.toFixed(2)}, ${chg(q.price, q.prevClose)} on the day and ${chg(q.price, base.c)} since the last close before the release.`);
        } else if ((st === 'POST' || st === 'POSTPOST') && Number.isFinite(q.postMarketPrice)) {
          L.push(`  AFTER-HOURS (${etWhen(q.postMarketTime ? q.postMarketTime * 1000 : nowMs)}): $${q.postMarketPrice.toFixed(2)}, ${chg(q.postMarketPrice, q.price)} vs the regular close and ${chg(q.postMarketPrice, base.c)} since the last close before the release.`);
        } else if (Number.isFinite(q.price)) {
          L.push(`  Latest price: $${q.price.toFixed(2)} (${chg(q.price, base.c)} since the last close before the release).`);
        }
      }
    } else {
      L.push('  Price history around the release is not on file.');
    }

    // What the market is reacting to: headlines from shortly before the
    // filing (previews) through now, newest first.
    const items = ctx.news && Array.isArray(ctx.news.items) ? ctx.news.items : [];
    const since = Date.parse(last.accepted) / 1000 - 6 * 3600;
    const recent = items.filter(it => Number(it.publishedAt) >= since).slice(0, 8);
    if (recent.length) {
      L.push('  Headlines since the report (newest first):');
      for (const it of recent) L.push(`    - ${etWhen(Number(it.publishedAt) * 1000)} · ${it.publisher || 'news'}: ${String(it.title || '').slice(0, 160)}`);
    } else {
      L.push('  Headlines since the report: none on file yet.');
    }
    return L.join('\n');
  })();

  // The latest headlines on the ticker (report or no report), so the
  // briefing can say what has been moving the stock lately instead of
  // guessing. Titles only, newest first, last two weeks, capped at 8.
  const newsItems = ctx.news && Array.isArray(ctx.news.items) ? ctx.news.items : [];
  const newsCut = nowMs / 1000 - 14 * 86400;
  const newsLines = newsItems.filter(it => Number(it.publishedAt) >= newsCut).slice(0, 8)
    .map(it => `  - ${etWhen(Number(it.publishedAt) * 1000)} · ${it.publisher || 'news'}: ${String(it.title || '').slice(0, 160)}`)
    .join('\n') || '  - no headlines on file for the last two weeks';

  return `TICKER: ${sym}
TODAY: ${todayLine}
COMPANY: ${(pf && pf.description) ? pf.description.slice(0, 400) : 'not available'}
SECTOR / INDUSTRY: ${(pf && pf.sector) || 'n/a'} / ${(pf && pf.industry) || 'n/a'}
EMPLOYEES: ${n(pf && pf.employees)}

PRICE:
  ${price52}
  Recent action: ${priceAction}

${earningsBlock}

RECENT HEADLINES (last 14 days, newest first; titles only, treat as reports not verified facts):
${newsLines}

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
3. RECENT PRICE ACTION — last 3-6 months of movement using the price data provided. Use the RECENT HEADLINES to say what has been moving the stock lately (a product, a deal, a downgrade, a lawsuit, a sector move), attributing them as "according to recent headlines" and never adding details the titles do not contain. If the headlines do not explain the move, you may offer a plausible reason as "one interpretation." If the data says the last earnings report is not recent, mention its date here in passing.
4. LATEST EARNINGS & REACTION — include this section ONLY when the data has a "LATEST EARNINGS REPORT (recent" block; otherwise skip it entirely. Use the TODAY line to describe timing naturally ("last night after the close", "this morning in pre-market trading", "in today's session"). Cover: when the company reported; what it reported against expectations, using only the numbers given (EPS vs consensus, revenue, net income, and the comparisons provided); how the stock has reacted, quoting the moves given (the last close before the release, the first session after it, and this morning's pre-market or today's session move); and what the headlines say the market is focused on (guidance, a segment, spending, margins). Treat headlines as reports of what others said, not as facts you verified. If the block says the quarter on file may not match the release, say the detailed numbers are not in yet and describe the reaction and the headlines. This section is the most time-sensitive part of the briefing: a reader opening it the morning after a report wants this first and in full.
5. FUNDAMENTALS — margins, revenue growth, profitability trajectory. Contextualize: are these margins strong or weak for this industry?
6. VALUATION — vs the company's history where the data supports it, plus context on what multiples typically look like for this kind of business.
7. WHAT THE STREET SEES — analyst rating, price target, what analysts have been focused on lately if you have a sense of it (the post-report headlines count here when present).
8. TECHNICAL SETUP — using the 50-day / 200-day MA context and 52-week range provided. Plain-English description of the trend. If the stock gapped on a recent report, note where that leaves it against the averages.
9. INSIDER SIGNAL — are officers and 10%+ owners buying or selling in the recent list? What's the typical pattern for this kind of company at this stage?
10. BULL / BASE / BEAR — 2-3 sentences each. Frame as "bulls point to..." and "bears worry about..." Use both the numbers AND the qualitative dynamics. NOT price predictions.
11. BOTTOM LINE — one paragraph tying it together. If there was a recent earnings report, lead with what it changed. NO "buy" or "sell" language. "Watch for," "consider," "the setup suggests," "worth understanding before deciding" are fine.

Keep the total response under 1100 words. Write for a retail investor who understands stocks but isn't a pro — no unexplained jargon. If you use "EBITDA" once, define it in parentheses the first time.

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

  // Cache hit — replay the stored analysis in one chunk and done. Two
  // exceptions: a briefing written around a recent report expires after
  // two hours instead of a day, and a briefing written BEFORE a report
  // that has since landed (the release day is newer than the one the
  // briefing knew about) is thrown away so a reader the morning after
  // never gets last week's story.
  const cached = CACHE.get(raw);
  if (cached && (Date.now() - cached.storedAt) < (cached.ttlMs || CACHE_TTL_MS)) {
    let stale = false;
    try {
      const r = await fetch(`${baseUrl(req)}/api/earnings-dates?sym=${encodeURIComponent(raw)}`, { headers: { 'User-Agent': 'BATS.CO analyzer' } });
      if (r.ok) stale = latestReportDate(await r.json()) > (cached.reportDate || '');
    } catch (_) { /* keep serving the cached briefing */ }
    if (!stale) {
      writeSSE(res, { type: 'source', cached: true, ageMs: Date.now() - cached.storedAt });
      writeSSE(res, { type: 'text', text: cached.analysis });
      writeSSE(res, { type: 'done', cached: true });
      res.end();
      return;
    }
    CACHE.delete(raw);
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

    // Cache the full response so re-clicks are free: 24h normally, 2h when
    // a report landed in the last few days (the reaction keeps moving).
    const reportDate = latestReportDate(ctx.earningsDates);
    const reportAgeDays = reportDate ? (Date.now() - Date.parse(reportDate + 'T16:00:00-04:00')) / 86400000 : Infinity;
    CACHE.set(raw, {
      analysis: fullText,
      storedAt: Date.now(),
      reportDate,
      ttlMs: reportAgeDays <= 3 ? CACHE_TTL_RECENT_REPORT_MS : CACHE_TTL_MS,
    });
    writeSSE(res, { type: 'done', cached: false });
    res.end();
  } catch (e) {
    // Any stream error — network, quota exceeded, invalid key — surfaces
    // as an SSE error event so the browser shows something explicit.
    writeSSE(res, { type: 'error', message: 'Analysis failed: ' + (e.message || e) });
    res.end();
  }
}
