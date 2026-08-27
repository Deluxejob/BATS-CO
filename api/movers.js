// Vercel serverless function — today's gainers / losers / most-active
// tickers. Same fetch-live-then-fall-back-to-GitHub pattern as
// api/sectors.js.
//
// Why not just serve data/movers.json:
//   The bot that refreshes that file runs on the same intraday cron as
//   the sectors bot (*/5 8-22 * * 1-5). GitHub Actions scheduled workflows
//   get heavily deprioritized during peak hours, and the movers script
//   is more failure-prone than sectors because Yahoo's `day_gainers` /
//   `day_losers` screeners contaminate their own lists (documented in
//   scripts/update-movers.py). When the bot's most-recent successful
//   commit is 12+ hours ago the frontend just shows yesterday's numbers.
//
// Fetching Yahoo directly from the API layer decouples freshness from
// the bot's actual firing schedule — the CDN cache guarantees data is
// always ≤60s old.
//
// Fallback chain: yahoo-live → github raw → deployment disk.
//
// GET /api/movers → same JSON shape the bot writes: { generatedAt,
//   gainers, losers, actives, preGainers, preLosers, preActives,
//   postGainers, postLosers, postActives }.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const YAHOO_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': YAHOO_UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
};

const SCREENER_URL = (scr) =>
  `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=50&scrIds=${scr}`;

const RAW_URL =
  'https://raw.githubusercontent.com/Deluxejob/BATS-CO/main/data/movers.json';

const LIST_SIZE = 25;

// ---- helpers --------------------------------------------------------------
function num(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

async function fetchScreener(scr) {
  try {
    const r = await fetch(SCREENER_URL(scr), { headers: HEADERS, cache: 'no-store' });
    if (!r.ok) return null;
    const data = await r.json();
    const result = ((data || {}).finance || {}).result || [];
    if (!result.length) return null;
    const quotes = result[0].quotes;
    return Array.isArray(quotes) ? quotes : null;
  } catch (_) {
    return null;
  }
}

function mergeUnique(pools) {
  const seen = new Map();
  for (const pool of pools) {
    if (!pool) continue;
    for (const q of pool) {
      const sym = q && q.symbol;
      if (!sym || seen.has(sym)) continue;
      seen.set(sym, q);
    }
  }
  return [...seen.values()];
}

// Partition by sign of pctKey. Returns { gainers, losers } sorted by pct
// desc / asc so the biggest movers surface first. Rows where pctKey is
// null/0 drop out entirely (nothing interesting to show).
function partitionByPct(candidates, pctKey) {
  const gainers = [];
  const losers  = [];
  for (const q of candidates) {
    const pct = num(q[pctKey]);
    if (pct === null || pct === 0) continue;
    (pct > 0 ? gainers : losers).push(q);
  }
  gainers.sort((a, b) => (num(b[pctKey]) || 0) - (num(a[pctKey]) || 0));
  losers.sort((a, b)  => (num(a[pctKey]) || 0) - (num(b[pctKey]) || 0));
  return { gainers, losers };
}

// Pick just the fields the frontend needs, using the price/change fields
// for the given session ("regular" | "pre" | "post"). Keeps the JSON
// shape identical across sessions.
function normalize(q, session) {
  let price, pct, chg;
  if (session === 'pre') {
    price = num(q.preMarketPrice);
    pct   = num(q.preMarketChangePercent);
    chg   = num(q.preMarketChange);
  } else if (session === 'post') {
    price = num(q.postMarketPrice);
    pct   = num(q.postMarketChangePercent);
    chg   = num(q.postMarketChange);
  } else {
    price = num(q.regularMarketPrice);
    pct   = num(q.regularMarketChangePercent);
    chg   = num(q.regularMarketChange);
  }
  return {
    symbol:    q.symbol,
    shortName: q.shortName || q.longName || '',
    price,
    changePct: pct,
    change:    chg,
    volume:    num(q.regularMarketVolume),
    marketCap: num(q.marketCap),
  };
}

function pack(rows, session) {
  return rows.slice(0, LIST_SIZE)
    .filter(q => q && q.symbol)
    .map(q => normalize(q, session));
}

// ---- data sources ---------------------------------------------------------
async function fetchFromYahoo() {
  // Same three screeners the Python bot uses (same rationale about the
  // day_gainers/day_losers contamination — the local partition below
  // fixes it).
  const [gainersRaw, losersRaw, activesRaw] = await Promise.all([
    fetchScreener('day_gainers'),
    fetchScreener('day_losers'),
    fetchScreener('most_actives'),
  ]);
  if (gainersRaw === null && losersRaw === null && activesRaw === null) {
    throw new Error('all yahoo screeners returned null');
  }

  // Merge into one candidate pool so pre/post partitions have a broader
  // starting set (big overnight movers often live in most_actives).
  const candidates = mergeUnique([gainersRaw, losersRaw, activesRaw]);

  // Regular-session partition
  const reg = partitionByPct(candidates, 'regularMarketChangePercent');
  const regActives = candidates
    .filter(q => num(q.regularMarketVolume) !== null)
    .sort((a, b) => (num(b.regularMarketVolume) || 0) - (num(a.regularMarketVolume) || 0));

  // Pre-market partition — only tickers with a Yahoo preMarket price/pct.
  // "Actives" here = biggest absolute pre-market move (Yahoo doesn't
  // expose pre-market volume in this screener payload).
  const pre = partitionByPct(candidates, 'preMarketChangePercent');
  const preActives = candidates
    .filter(q => num(q.preMarketChangePercent) !== null)
    .sort((a, b) => Math.abs(num(b.preMarketChangePercent) || 0)
                  - Math.abs(num(a.preMarketChangePercent) || 0));

  // After-hours partition — same treatment.
  const post = partitionByPct(candidates, 'postMarketChangePercent');
  const postActives = candidates
    .filter(q => num(q.postMarketChangePercent) !== null)
    .sort((a, b) => Math.abs(num(b.postMarketChangePercent) || 0)
                  - Math.abs(num(a.postMarketChangePercent) || 0));

  return {
    generatedAt: Math.floor(Date.now() / 1000),
    gainers:     pack(reg.gainers, 'regular'),
    losers:      pack(reg.losers,  'regular'),
    actives:     pack(regActives,  'regular'),
    preGainers:  pack(pre.gainers, 'pre'),
    preLosers:   pack(pre.losers,  'pre'),
    preActives:  pack(preActives,  'pre'),
    postGainers: pack(post.gainers, 'post'),
    postLosers:  pack(post.losers,  'post'),
    postActives: pack(postActives,  'post'),
  };
}

async function fetchFromGitHub() {
  const r = await fetch(RAW_URL, {
    headers: { 'User-Agent': 'bats.co api/movers (Vercel serverless)' },
    cache: 'no-store',
  });
  if (!r.ok) throw new Error('github raw http ' + r.status);
  return await r.json();
}

async function fetchFromDisk() {
  const p = path.join(process.cwd(), 'data', 'movers.json');
  const txt = await fs.readFile(p, 'utf-8');
  return JSON.parse(txt);
}

// ---- handler --------------------------------------------------------------
export default async function handler(req, res) {
  let data;
  let source = 'yahoo-live';
  let yahooErr = null;

  try {
    data = await fetchFromYahoo();
    // Sanity: fail loudly if we didn't get at least SOME regular gainers.
    // Empty response from Yahoo (deprecated endpoint, rate limit, etc.)
    // reads worse than the bot's older-but-populated snapshot.
    if (!data.gainers.length && !data.losers.length && !data.actives.length) {
      throw new Error('yahoo returned empty gainers/losers/actives');
    }
  } catch (err) {
    yahooErr = err;
    try {
      data = await fetchFromGitHub();
      source = 'github';
    } catch (ghErr) {
      try {
        data = await fetchFromDisk();
        source = 'disk-fallback';
      } catch (diskErr) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(502).json({
          error:  'all fetch paths failed',
          yahoo:  String((yahooErr && yahooErr.message) || yahooErr),
          github: String((ghErr && ghErr.message) || ghErr),
          disk:   String((diskErr && diskErr.message) || diskErr),
        });
      }
    }
  }

  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=30');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-BATS-Source', source);
  return res.status(200).json(data);
}
