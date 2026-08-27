// Vercel serverless function — live sector heatmap data.
//
// Primary source: Yahoo v7 quote endpoint, fetched fresh at request time
// (cached 60s at the Vercel edge). Same pattern api/quote.js uses. One
// HTTP round-trip covers all 11 SPDR sector ETFs.
//
// Why not just serve data/sectors_live.json:
//   The bot that refreshes that file runs on GitHub Actions cron
//   (*/5 12-22 * * 1-5), but GH Actions scheduled workflows get heavily
//   deprioritized during peak hours. In practice the bot commits ~1x/hour
//   instead of the scheduled 12x/hour, and the gap between the first
//   morning commit and the second is often 90-120 minutes. During that
//   gap the client-side heatmap sees a > 4-hour-old sectors_live.json
//   and falls back to the daily CSV, so the tiles show *yesterday's*
//   percentage change for the first hour or two of trading.
//
// Fetching Yahoo directly from the API layer decouples freshness from
// the bot's actual firing schedule — the CDN cache guarantees data is
// always ≤60s old, at market open and every minute after.
//
// Fallback chain: yahoo-live → github raw → deployment disk. The bot
// keeps running and committing sectors_live.json to the repo, so if
// Yahoo is unreachable from Vercel we serve the bot's most-recent
// snapshot instead of hard-erroring.
//
// GET /api/sectors → { generatedAt, generatedAtTs, sectorCount, sectors }
//   with X-BATS-Source: yahoo-live | github | disk-fallback so we can
//   tell which path served the response.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const YAHOO_UA = 'Mozilla/5.0 (BATS.CO sectors proxy)';
const SECTORS = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
const RAW_URL =
  'https://raw.githubusercontent.com/Deluxejob/BATS-CO/main/data/sectors_live.json';

// Yahoo v7 quote requires a crumb rotated per request. Prime a cookie
// from fc.yahoo.com, then trade it for a crumb at /v1/test/getcrumb.
// Same pattern as api/quote.js.
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

async function fetchFromYahoo() {
  const { crumb, cookieHeader } = await getCrumb();
  const url = 'https://query1.finance.yahoo.com/v7/finance/quote'
    + '?symbols=' + encodeURIComponent(SECTORS.join(','))
    + '&crumb=' + encodeURIComponent(crumb);
  const r = await fetch(url, {
    headers: { 'User-Agent': YAHOO_UA, 'Cookie': cookieHeader },
    cache: 'no-store',
  });
  if (!r.ok) throw new Error('yahoo v7 http ' + r.status);
  const data = await r.json();
  const results = data && data.quoteResponse && data.quoteResponse.result;
  if (!Array.isArray(results) || !results.length) {
    throw new Error('unexpected yahoo response shape');
  }
  const sectors = {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  for (const q of results) {
    const sym = String(q.symbol || '').toUpperCase();
    if (!sym || !SECTORS.includes(sym)) continue;
    const price = Number(q.regularMarketPrice);
    const prevClose = Number(q.regularMarketPreviousClose);
    if (!Number.isFinite(price) || !Number.isFinite(prevClose) || !prevClose) continue;
    const changePct = (price / prevClose - 1) * 100;
    sectors[sym.toLowerCase()] = {
      symbol: sym,
      price:      Math.round(price * 10000) / 10000,
      prevClose:  Math.round(prevClose * 10000) / 10000,
      changePct:  Math.round(changePct * 10000) / 10000,
      marketTime: Number.isFinite(q.regularMarketTime) ? q.regularMarketTime : null,
      // Pre-market fields let the sector heatmap frontend show pre-market
      // movement during 4-9:30am ET instead of yesterday's regular close.
      // marketState is one of PRE, PREPRE, REGULAR, POST, POSTPOST, CLOSED.
      marketState:         q.marketState || null,
      preMarketPrice:      num(q.preMarketPrice),
      preMarketChangePct:  num(q.preMarketChangePercent),
      preMarketTime:       num(q.preMarketTime),
    };
  }
  // Fail loudly if Yahoo returned an incomplete set — a partial grid
  // would render worse than falling back to the bot's snapshot.
  if (Object.keys(sectors).length < Math.floor(SECTORS.length * 0.7)) {
    throw new Error('yahoo returned ' + Object.keys(sectors).length + '/' + SECTORS.length + ' sectors');
  }
  const nowTs = Math.floor(Date.now() / 1000);
  return {
    generatedAt:   new Date(nowTs * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    generatedAtTs: nowTs,
    sectorCount:   Object.keys(sectors).length,
    sectors,
  };
}

async function fetchFromGitHub() {
  const r = await fetch(RAW_URL, {
    headers: { 'User-Agent': YAHOO_UA },
    cache: 'no-store',
  });
  if (!r.ok) throw new Error('github raw http ' + r.status);
  return await r.json();
}

async function fetchFromDisk() {
  const p = path.join(process.cwd(), 'data', 'sectors_live.json');
  const txt = await fs.readFile(p, 'utf-8');
  return JSON.parse(txt);
}

export default async function handler(req, res) {
  let data;
  let source = 'yahoo-live';
  let yahooErr = null;

  try {
    data = await fetchFromYahoo();
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
