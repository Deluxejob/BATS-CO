#!/usr/bin/env python3
"""
Fetch today's top gainers, losers, and most-active tickers from Yahoo
Finance's screener endpoints. Publishes data/movers.json which the
Quotes page reads to render three scrollable ranking boxes.

Runs as part of the intraday workflow (every 5-10 min during US market
hours). If the fetch fails, the existing JSON is left untouched.

NOTE on the day_gainers / day_losers contamination:
  Yahoo's predefined screener endpoints are unreliable — the day_gainers
  list often contains 15+ actual losers, and day_losers occasionally
  includes gainers. We don't know why (rate limit? A/B experiment?
  unrelated ranking?), but the effect is real and consistent.

  Workaround: fetch BOTH day_gainers and day_losers, merge into one
  candidate pool (~50 unique tickers), then partition locally by the
  sign of regularMarketChangePercent and sort. Whatever direction the
  ticker actually moved, that's the bucket it belongs in. Ties are
  broken by absolute % change so the biggest movers surface first.

  most_actives sorts by volume regardless of direction and comes back
  clean, so we still use it as-is.
"""

from __future__ import annotations
import json
import os
import sys
import time
import urllib.request
import urllib.error

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH = os.path.join(REPO_ROOT, "data", "movers.json")

BASE_URL = (
    "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved"
    "?count=50&scrIds={scr}"
)

# How many rows to keep per list in the final JSON.
LIST_SIZE = 25


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def fetch_screener(scr_id: str):
    url = BASE_URL.format(scr=scr_id)
    req = urllib.request.Request(url, headers={
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://finance.yahoo.com/",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError) as e:
        warn(f"Yahoo screener {scr_id} fetch failed: {e}")
        return None

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        warn(f"Yahoo screener {scr_id} JSON decode failed: {e}")
        return None

    result = payload.get("finance", {}).get("result", [])
    if not result:
        warn(f"Yahoo screener {scr_id} returned no result[]")
        return None
    return result[0].get("quotes", [])


def normalize(quote):
    """Pick just the fields the frontend actually needs, keep JSON tiny."""
    return {
        "symbol":    quote.get("symbol"),
        "shortName": quote.get("shortName") or quote.get("longName") or "",
        "price":     quote.get("regularMarketPrice"),
        "changePct": quote.get("regularMarketChangePercent"),
        "change":    quote.get("regularMarketChange"),
        "volume":    quote.get("regularMarketVolume"),
        "marketCap": quote.get("marketCap"),
    }


def merge_unique(pools):
    """Union multiple screener results, keyed by symbol (first-seen wins)."""
    seen = {}
    for pool in pools:
        if not pool:
            continue
        for q in pool:
            sym = q.get("symbol")
            if not sym or sym in seen:
                continue
            seen[sym] = q
    return list(seen.values())


def partition_by_direction(candidates):
    """From a mixed pool, return (real_gainers, real_losers) sorted by
    absolute % change desc. Tickers with pct == None or 0 are dropped
    from the direction buckets (nothing interesting to show)."""
    gainers, losers = [], []
    for q in candidates:
        pct = q.get("regularMarketChangePercent")
        if pct is None:
            continue
        if pct > 0:
            gainers.append(q)
        elif pct < 0:
            losers.append(q)
    gainers.sort(key=lambda q: q["regularMarketChangePercent"], reverse=True)
    losers.sort(key=lambda q: q["regularMarketChangePercent"])
    return gainers, losers


def main() -> int:
    # Yahoo mis-classifies rows across day_gainers / day_losers, so pull
    # both and re-partition locally by direction.
    gainers_raw = fetch_screener("day_gainers")
    losers_raw  = fetch_screener("day_losers")
    actives_raw = fetch_screener("most_actives")

    if gainers_raw is None and losers_raw is None and actives_raw is None:
        warn("All three screener fetches failed; leaving movers.json unchanged.")
        return 0

    candidates = merge_unique([gainers_raw, losers_raw])
    gainers, losers = partition_by_direction(candidates)

    actives = actives_raw or []
    actives.sort(
        key=lambda q: q.get("regularMarketVolume") or 0,
        reverse=True,
    )

    payload = {
        "generatedAt": int(time.time()),
        "gainers": [normalize(q) for q in gainers[:LIST_SIZE] if q.get("symbol")],
        "losers":  [normalize(q) for q in losers[:LIST_SIZE]  if q.get("symbol")],
        "actives": [normalize(q) for q in actives[:LIST_SIZE] if q.get("symbol")],
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    print(
        f"Wrote {OUT_PATH}: {len(payload['gainers'])} gainers, "
        f"{len(payload['losers'])} losers, {len(payload['actives'])} actives "
        f"(from {len(candidates)} unique candidates in gainers+losers pools)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
