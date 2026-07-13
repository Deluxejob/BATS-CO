// Vercel serverless function — serves data/sectors_live.json as a dynamic
// API route instead of a static file.
//
// Why this exists: Vercel's edge CDN aggressively caches static files, even
// with `Cache-Control: max-age=0, s-maxage=0, must-revalidate` set on the
// response. When the intraday-sector bot pushes a fresh sectors_live.json,
// the deployed build has the new file, but the CDN sometimes keeps serving
// the previous build's version for hours (X-Vercel-Cache: HIT with a big
// Age header). Static-file cache invalidation on Vercel is tied to build
// fingerprints, not runtime headers, so we can't defeat it from vercel.json.
//
// An API route runs server-side on each request, so the response is bound to
// runtime cache headers instead. We serve with a short s-maxage=60 so the
// CDN caches for one minute at most — well below the intraday-bot's 5-minute
// cadence and any stale-perception threshold.
//
// GET /api/sectors → contents of data/sectors_live.json, verbatim.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export default async function handler(req, res) {
  try {
    // process.cwd() is the deployment root for Vercel Node functions.
    const p = path.join(process.cwd(), 'data', 'sectors_live.json');
    const txt = await fs.readFile(p, 'utf-8');
    const data = JSON.parse(txt);

    // Short edge cache — 60s is far below the intraday bot's 5-min cadence
    // and well below the 4-hour "trust live" threshold the client uses,
    // so readers always see near-fresh data without hammering the file.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=30');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(data);
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: String((err && err.message) || err) });
  }
}
