// Vercel serverless function — serves data/sectors_live.json fetched
// LIVE from GitHub raw content instead of from the deployment disk.
//
// Why not read from disk:
//   Vercel bundles static files into each deployment at build time. Files
//   pushed to the repo AFTER the deployment don't appear on the deployment
//   disk until Vercel redeploys. On this project Vercel skips redeploys
//   when a commit only touches data/*, so the intraday-sector bot's fresh
//   sectors_live.json commits sit in the repo without ever landing on the
//   live deployment — the /api/sectors function keeps returning
//   deploy-time-frozen data even hours after new commits.
//
// Reading from GitHub's raw content URL at request time decouples data
// freshness from deployment cadence: GitHub serves the newest committed
// version of the file within seconds of each push.
//
// With s-maxage=60 CDN caching, each Vercel region hits GitHub at most
// once per minute — well under GitHub's raw content rate limits and
// well within our intraday bot's 5-minute cadence.
//
// GET /api/sectors → live contents of data/sectors_live.json from the
//   main branch of Deluxejob/BATS-CO, verbatim.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const RAW_URL =
  'https://raw.githubusercontent.com/Deluxejob/BATS-CO/main/data/sectors_live.json';

async function fetchFromGitHub() {
  const r = await fetch(RAW_URL, {
    headers: { 'User-Agent': 'bats.co api/sectors (Vercel serverless)' },
    // Vercel Node fetch: use force-cache: 'no-store' so the request itself
    // isn't cached by the runtime — the CDN cache header on our response
    // is what actually controls how often we hit GitHub.
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
  let data, source = 'github';
  try {
    data = await fetchFromGitHub();
  } catch (err) {
    // Fall back to the deployment-bundled file if GitHub is unreachable.
    // Older but still better than nothing.
    try {
      data = await fetchFromDisk();
      source = 'disk-fallback';
    } catch (err2) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(502).json({
        error: 'both fetch paths failed',
        github: String(err && err.message || err),
        disk:   String(err2 && err2.message || err2),
      });
    }
  }

  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=30');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-BATS-Source', source);
  return res.status(200).json(data);
}
