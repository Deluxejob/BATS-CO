// Vercel serverless function — serves data/movers.json fetched LIVE from
// GitHub raw content instead of from the deployment disk. Same reason as
// api/sectors.js: Vercel skips redeploys when a commit only touches
// data/*, so the bot's fresh movers.json sits in the repo without ever
// landing on the live deployment. Reading from GitHub's raw content URL
// at request time decouples freshness from deployment cadence.
//
// GET /api/movers → live contents of data/movers.json from the main
//   branch of Deluxejob/BATS-CO, verbatim.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const RAW_URL =
  'https://raw.githubusercontent.com/Deluxejob/BATS-CO/main/data/movers.json';

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

export default async function handler(req, res) {
  let data, source = 'github';
  try {
    data = await fetchFromGitHub();
  } catch (err) {
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
