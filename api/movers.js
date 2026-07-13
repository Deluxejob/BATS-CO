// Vercel serverless function — serves data/movers.json as a dynamic
// API route instead of a static file. See api/sectors.js for the full
// explanation; short version: Vercel's edge CDN aggressively caches
// static /data/*.json responses, so after the intraday bot pushes a
// fresh copy the deployed build has the new file but readers see
// X-Vercel-Cache: HIT with a big Age. An API route runs per-request
// and honors runtime cache headers, so s-maxage=60 actually applies.
//
// GET /api/movers → contents of data/movers.json, verbatim.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export default async function handler(req, res) {
  try {
    const p = path.join(process.cwd(), 'data', 'movers.json');
    const txt = await fs.readFile(p, 'utf-8');
    const data = JSON.parse(txt);
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=30');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(data);
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: String((err && err.message) || err) });
  }
}
