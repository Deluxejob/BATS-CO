#!/usr/bin/env python3
"""
Fetch today's top gainers, losers, and most-active tickers from Yahoo
Finance's screener endpoints. Publishes data/movers.json which the
Quotes page reads to render three scrollable ranking boxes.

Runs as part of the intraday workflow (every 5-10 min during US market
hours). If the fetch fails, the existing JSON is left untouched.
"""

from __future__ import annotations
import json
import os
import sys
import urllib.request
import urllib.error

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH = os.path.join(REPO_ROOT, "data", "movers.json")

# Yahoo's public predefined screeners (no auth required)
SCREENERS = {
    "gainers":  "day_gainers",
    "losers":   "day_losers",
    "actives":  "most_actives",
}

BASE_URL = (
    "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved"
    "?count=25&scrIds={scr}"
)


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def fetch_screener(scr_id: str):
    url = BASE_URL.format(scr=scr_id)
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (BATS.CO daily update bot)",
        "Accept": "application/json",
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


def main() -> int:
    out = {}
    ok = 0
    for key, scr_id in SCREENERS.items():
        quotes = fetch_screener(scr_id)
        if quotes is None:
            continue
        out[key] = [normalize(q) for q in quotes if q.get("symbol")]
        ok += 1

    if ok == 0:
        warn("All three screener fetches failed; leaving movers.json unchanged.")
        return 0

    import time
    payload = {
        "generatedAt": int(time.time()),
        "gainers": out.get("gainers", []),
        "losers":  out.get("losers",  []),
        "actives": out.get("actives", []),
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    print(
        f"Wrote {OUT_PATH}: {len(payload['gainers'])} gainers, "
        f"{len(payload['losers'])} losers, {len(payload['actives'])} actives"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
