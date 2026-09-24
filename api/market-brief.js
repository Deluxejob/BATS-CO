// Vercel serverless function — asks Claude Haiku 4.5 for a short,
// time-of-day-aware brief on the overall market: overnight action,
// this morning's headlines, what is driving markets (rates, energy, the
// dollar, Washington, notable company news), earnings in focus, the tone
// right now, and what to watch next. Streams back over SSE exactly like
// api/analyze.js so the browser can reuse the same renderer.
//
// Everything the model sees is gathered at request time:
//   * live quotes for the major indexes, futures, VIX, 10-yr yield, the
//     dollar, oil, gold and bitcoin (our own /api/quote)
//   * the sector heatmap (/api/sectors) and today's movers (/api/movers)
//   * today's earnings calendar (/api/earnings-calendar)
//   * fresh headlines from Yahoo Finance's news search across a handful
//     of market topics, filtered to real newsrooms and the last ~18 hours
// The model may not invent a number or a headline; it summarises what it
// is handed and says "no fresh headline" when a topic is quiet.
//
// Cost / abuse control: the brief is market-wide, so one generation is
// cached and shared by every visitor — 10 minutes while the market (or
// pre-market) is open, 30 minutes otherwise. Per-IP limit of 6 fresh
// generations an hour on top of that. ANTHROPIC_API_KEY env var required.
//
// GET /api/market-brief
//   → text/event-stream:
//        data: {"type":"meta","asOf":"...","state":"REGULAR","cached":false}
//        data: {"type":"text","text":"..."}   (repeated)
//        data: {"type":"done"}

import Anthropic from '@anthropic-ai/sdk';

const MODEL          = 'claude-haiku-4-5-20251001';
const MAX_TOKENS     = 1100;
const TTL_OPEN_MS    = 10 * 60 * 1000;
const TTL_CLOSED_MS  = 30 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT     = 6;
const BASE           = 'https://bats.co';
const UA             = { 'User-Agent': 'BATS.CO market brief' };

let CACHE = null;                  // { text, storedAt, asOf, state }
const RATE = new Map();            // ip → [timestamp, ...]

// ---------------------------------------------------------------- time
function etNow() {
  const d = new Date();
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(d).forEach(p => { parts[p.type] = p.value; });
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d); // YYYY-MM-DD
  return {
    label: `${parts.weekday} ${parts.month} ${parts.day}, ${parts.year} · ${parts.hour}:${parts.minute} ${parts.dayPeriod} ET`,
    time:  `${parts.hour}:${parts.minute} ${parts.dayPeriod} ET`,
    ymd,
    weekday: parts.weekday,
  };
}

function ttlFor(state) {
  return (state === 'REGULAR' || state === 'PRE' || state === 'PREPRE') ? TTL_OPEN_MS : TTL_CLOSED_MS;
}

function getClientIp(req) {
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

// ---------------------------------------------------------------- data
const QUOTE_SYMS = [
  'SPY', 'QQQ', 'DIA', 'IWM', '^VIX', '^TNX',
  'ES=F', 'NQ=F', 'YM=F', 'RTY=F',
  'CL=F', 'GC=F', 'DX-Y.NYB', 'BTC-USD',
];

async function getJson(url) {
  try {
    const r = await fetch(url, { headers: UA });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

// Fresh headlines from Yahoo's news search. Several topic queries, merged,
// deduped, limited to real newsrooms and the last ~18 hours (36 on a
// Monday morning / weekend so the "overnight" section has something to
// say). Newest first, capped so the prompt stays cheap.
const NEWS_QUERIES = [
  'stock market today', 'S&P 500', 'Nasdaq', 'Federal Reserve interest rates',
  'Treasury yields', 'oil prices', 'White House economy', 'earnings',
];
const PUBLISHER_ALLOW = /reuters|bloomberg|cnbc|wall street journal|wsj|barron|investor'?s business daily|marketwatch|associated press|ap news|financial times|the economist|yahoo finance|fortune|forbes|axios|politico|the street|thestreet/i;

async function fetchNews(maxAgeHours) {
  const now = Math.floor(Date.now() / 1000);
  const seen = new Set();
  const items = [];
  const results = await Promise.allSettled(NEWS_QUERIES.map(q =>
    getJson('https://query1.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(q) +
            '&newsCount=20&quotesCount=0&enableFuzzyQuery=false&region=US&lang=en-US')
  ));
  for (const r of results) {
    const list = (r.status === 'fulfilled' && r.value && r.value.news) || [];
    for (const it of list) {
      const title = (it.title || '').trim(), link = (it.link || '').trim();
      const pub = (it.publisher || '').trim();
      const ts = Number(it.providerPublishTime || 0);
      if (!title || !link || !ts) continue;
      if (!PUBLISHER_ALLOW.test(pub)) continue;
      if (now - ts > maxAgeHours * 3600) continue;
      const key = it.uuid || link;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ title, pub, ts });
    }
  }
  items.sort((a, b) => b.ts - a.ts);
  return items.slice(0, 30);
}

async function gather(et) {
  const isWeekendOrMonday = et.weekday === 'Sat' || et.weekday === 'Sun' || et.weekday === 'Mon';
  const [quotes, sectors, movers, earnings, news] = await Promise.all([
    getJson(`${BASE}/api/quote?syms=${encodeURIComponent(QUOTE_SYMS.join(','))}`),
    getJson(`${BASE}/api/sectors`),
    getJson(`${BASE}/api/movers`),
    getJson(`${BASE}/api/earnings-calendar?from=${et.ymd}&to=${et.ymd}`),
    fetchNews(isWeekendOrMonday ? 36 : 18),
  ]);
  return { quotes: (quotes && quotes.quotes) || {}, sectors, movers, earnings, news };
}

// --------------------------------------------------------------- prompt
const pct = v => (v == null || !Number.isFinite(v)) ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const num = (v, d = 2) => (v == null || !Number.isFinite(v)) ? 'n/a' : v.toFixed(d);
const money = v => (v == null || !Number.isFinite(v)) ? 'n/a' : '$' + v.toLocaleString('en-US', { maximumFractionDigits: 2 });

function fmtEt(ts) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true, month: 'short', day: 'numeric' })
    .format(new Date(ts * 1000)) + ' ET';
}

function buildContext(et, state, ctx) {
  const q = ctx.quotes;
  const line = (sym, label, opts = {}) => {
    const x = q[sym]; if (!x) return `  ${label}: n/a`;
    const price = opts.yield ? num(x.price / 10) + '%' : (opts.plain ? num(x.price) : money(x.price));
    let s = `  ${label}: ${price} (${pct(x.dayChangePct)} vs prior close)`;
    if (x.preMarketPrice != null && x.preMarketChangePercent != null)  s += ` · pre-market ${money(x.preMarketPrice)} (${pct(x.preMarketChangePercent)})`;
    if (x.postMarketPrice != null && x.postMarketChangePercent != null) s += ` · after-hours ${money(x.postMarketPrice)} (${pct(x.postMarketChangePercent)})`;
    return s;
  };

  // /api/sectors keys the sectors by lowercase symbol; accept a list too.
  const rawSectors = ctx.sectors && ctx.sectors.sectors;
  const sectorList = Array.isArray(rawSectors) ? rawSectors : (rawSectors && typeof rawSectors === 'object' ? Object.values(rawSectors) : []);
  const secPct = s => Number.isFinite(s.changePct) ? s.changePct : (Number.isFinite(s.pct) ? s.pct : (Number.isFinite(s.change) ? s.change : null));
  const secSym = s => s.symbol || s.sym || s.ticker || '?';
  const secName = s => s.name || s.sector || '';
  const sectorsSorted = sectorList.map(s => ({ sym: secSym(s), name: secName(s), pct: secPct(s) }))
    .filter(s => s.pct != null).sort((a, b) => b.pct - a.pct);
  const sectorsTxt = sectorsSorted.length
    ? sectorsSorted.map(s => `${s.sym}${s.name ? ' ' + s.name : ''} ${pct(s.pct)}`).join(' · ')
    : 'n/a';

  const mv = ctx.movers || {};
  const moverLine = (arr, n = 6) => (Array.isArray(arr) && arr.length)
    ? arr.slice(0, n).map(m => `${m.symbol} ${pct(m.changePct)}${m.shortName ? ' (' + String(m.shortName).slice(0, 28) + ')' : ''}`).join(' · ')
    : 'n/a';
  const usePre = state === 'PRE' || state === 'PREPRE';
  const moversTxt = usePre
    ? `  Pre-market gainers: ${moverLine(mv.preGainers)}\n  Pre-market losers: ${moverLine(mv.preLosers)}\n  Yesterday's session gainers: ${moverLine(mv.gainers)}\n  Yesterday's session losers: ${moverLine(mv.losers)}`
    : `  Gainers: ${moverLine(mv.gainers)}\n  Losers: ${moverLine(mv.losers)}` +
      ((state === 'POST' || state === 'POSTPOST') ? `\n  After-hours gainers: ${moverLine(mv.postGainers)}\n  After-hours losers: ${moverLine(mv.postLosers)}` : '');

  const er = Array.isArray(ctx.earnings && ctx.earnings.earnings) ? ctx.earnings.earnings : [];
  const bySize = er.slice().sort((a, b) => (b.revenueEstimate || 0) - (a.revenueEstimate || 0));
  const erLine = (list) => list.slice(0, 8).map(e => {
    const beat = (e.epsActual != null && e.epsEstimate != null)
      ? ` — reported ${num(e.epsActual)} vs ${num(e.epsEstimate)} est (${e.epsActual >= e.epsEstimate ? 'beat' : 'miss'})`
      : (e.epsEstimate != null ? ` — est EPS ${num(e.epsEstimate)}` : '');
    return `${e.symbol}${beat}`;
  }).join(' · ') || 'none listed';
  const bmo = bySize.filter(e => /bmo/i.test(e.hour || ''));
  const amc = bySize.filter(e => /amc/i.test(e.hour || ''));
  const other = bySize.filter(e => !/bmo|amc/i.test(e.hour || ''));
  const earningsTxt = `  Before the open: ${erLine(bmo)}\n  After the close: ${erLine(amc)}` + (other.length ? `\n  Time unspecified: ${erLine(other)}` : '');

  const newsTxt = ctx.news.length
    ? ctx.news.map(n => `  - ${fmtEt(n.ts)} · ${n.pub} · ${n.title}`).join('\n')
    : '  - (no qualifying headlines returned)';

  const stateWords = {
    PRE: 'pre-market (session not open yet)', PREPRE: 'pre-market (session not open yet)',
    REGULAR: 'regular session is OPEN', POST: 'after-hours (session closed today)',
    POSTPOST: 'after-hours (session closed today)', CLOSED: 'market closed',
  }[state] || state;

  return `NOW: ${et.label} — ${stateWords}

INDEXES (ETF proxies; change is today's regular session vs prior close, or the last session if closed):
${line('SPY', 'S&P 500 (SPY)')}
${line('QQQ', 'Nasdaq-100 (QQQ)')}
${line('DIA', 'Dow (DIA)')}
${line('IWM', 'Russell 2000 (IWM)')}

FUTURES (front month):
${line('ES=F', 'S&P 500 futures', { plain: true })}
${line('NQ=F', 'Nasdaq-100 futures', { plain: true })}
${line('YM=F', 'Dow futures', { plain: true })}
${line('RTY=F', 'Russell 2000 futures', { plain: true })}

RATES, VOLATILITY, DOLLAR, COMMODITIES, CRYPTO:
${line('^VIX', 'VIX', { plain: true })}
${line('^TNX', '10-year Treasury yield', { yield: true })}
${line('DX-Y.NYB', 'US dollar index (DXY)', { plain: true })}
${line('CL=F', 'WTI crude oil')}
${line('GC=F', 'Gold')}
${line('BTC-USD', 'Bitcoin')}

SECTORS TODAY (SPDR ETFs, best to worst):
  ${sectorsTxt}

MOVERS:
${moversTxt}

EARNINGS SCHEDULED TODAY (largest companies first):
${earningsTxt}

HEADLINES (newest first, real newsrooms only, last day or so):
${newsTxt}
`;
}

const SYSTEM_PROMPT = `You are a market strategist writing a short "state of the market" brief for retail investors on BATS.CO, generated the moment the reader clicks.

RULES ABOUT DATA:
1. Every NUMBER (index moves, yields, prices, percentages) must come from the data block. Never invent, round into a different figure, or forecast a number.
2. Every NEWS CLAIM must come from the HEADLINES list. Cite the outlet in parentheses the first time you lean on a headline, e.g. "(Reuters)". If the headlines say nothing about a topic — rates, oil, Washington, a CEO, an earnings report — write that there is no fresh headline on it rather than inventing one.
3. Use general knowledge only to explain WHY something matters (e.g. why higher yields pressure growth stocks), never to assert what happened today.
4. No price predictions or "buy/sell" language. "Watch for", "the tape suggests", "traders are treating X as" are fine.

TIME OF DAY: the data block says whether the session is open, pre-market, after-hours or closed. Write accordingly — before the open, lead with overnight and futures and "this morning"; during the session, with "so far today"; after the close, with how the day ended and what after-hours is doing. Do not describe a session that has not happened.

Structure the response as these sections, in this order, each with a plain header line exactly as written (no markdown):
OVERNIGHT & FUTURES
TODAY'S HEADLINES
WHAT'S DRIVING MARKETS
EARNINGS IN FOCUS
TONE & DIRECTION RIGHT NOW
WHAT TO WATCH NEXT

Under WHAT'S DRIVING MARKETS, touch on rates, energy/the dollar, Washington or policy, and company/CEO news where the headlines support it — one or two sentences each, and say "no fresh headline" where they don't.
Keep the whole brief under 450 words. Short paragraphs, no bullet lists, no unexplained jargon.

End with this exact line on its own, no formatting:
AI-generated summary of live quotes and published headlines at the time shown. Not investment advice.`;

function writeSSE(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders && res.flushHeaders();

  // Shared cache — one brief serves everyone for its TTL.
  if (CACHE && (Date.now() - CACHE.storedAt) < ttlFor(CACHE.state)) {
    writeSSE(res, { type: 'meta', asOf: CACHE.asOf, state: CACHE.state, cached: true, ageMs: Date.now() - CACHE.storedAt });
    writeSSE(res, { type: 'text', text: CACHE.text });
    writeSSE(res, { type: 'done', cached: true });
    res.end();
    return;
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    writeSSE(res, { type: 'error', message: 'Rate limit reached (6 fresh briefs per hour per visitor). Try again in a few minutes.' });
    res.end();
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    writeSSE(res, { type: 'error', message: 'ANTHROPIC_API_KEY is not configured on the server.' });
    res.end();
    return;
  }

  const et = etNow();
  let ctx, state, dataBlock;
  try {
    ctx = await gather(et);
    const spy = ctx.quotes.SPY;
    state = String((spy && spy.marketState) || 'CLOSED').toUpperCase();
    dataBlock = buildContext(et, state, ctx);
  } catch (e) {
    writeSSE(res, { type: 'error', message: 'Failed to gather market data: ' + (e.message || e) });
    res.end();
    return;
  }
  if (!ctx.quotes.SPY && !ctx.news.length) {
    writeSSE(res, { type: 'error', message: 'Market data is unavailable right now. Try again in a minute.' });
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
      messages: [{ role: 'user', content: `Write the market brief from this data:\n\n${dataBlock}` }],
    });
    writeSSE(res, { type: 'meta', asOf: et.time, state, cached: false });
    stream.on('text', (chunk) => {
      fullText += chunk;
      writeSSE(res, { type: 'text', text: chunk });
    });
    await stream.finalMessage();
    CACHE = { text: fullText, storedAt: Date.now(), asOf: et.time, state };
    writeSSE(res, { type: 'done', cached: false });
    res.end();
  } catch (e) {
    writeSSE(res, { type: 'error', message: 'Brief failed: ' + (e.message || e) });
    res.end();
  }
}
