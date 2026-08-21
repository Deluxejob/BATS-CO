// Vercel serverless function — thin wrapper around data/eps_scan.json
// so browsers always see the freshest scan pushed by the daily workflow.
//
// Why the wrapper: Vercel builds the site once per code push. Static
// files in data/ get baked into that build. When the nightly workflow
// commits a new data/eps_scan.json, Vercel does NOT redeploy (we
// exclude data-only commits to save build minutes). Result: the static
// file at /data/eps_scan.json is stale.
//
// This function fetches the file from GitHub raw at request time, then
// caches for 5 min at Vercel's edge. Same pattern used by api/sectors,
// api/analyst, etc.

const RAW_URL = 'https://raw.githubusercontent.com/Deluxejob/BATS-CO/main/data/eps_scan.json';

export default async function handler(req, res) {
  try {
    const r = await fetch(RAW_URL, { cache: 'no-store' });
    if (!r.ok) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(502).json({ error: 'github raw http ' + r.status });
    }
    const body = await r.text();

    // Edge cache for 5 min — the scan runs once a day, so freshness is
    // not urgent, but a small TTL keeps the proxy load low.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=1800');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(body);
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: String((err && err.message) || err) });
  }
}
