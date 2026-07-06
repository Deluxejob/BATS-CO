#!/usr/bin/env python3
"""
Fetch current-session price + previous-session close for all 11 SPDR sector
ETFs, write data/sectors_live.json. Runs every 10 minutes during US market
hours via .github/workflows/update-sectors-intraday.yml.

The markets page reads this file for the "1 day" bucket on the sector heatmap
so tiles show today's live percentage change instead of yesterday's close.
Longer periods (1W/1M/YTD/1Y) still read from the daily CSVs.

Safe on failure: if any individual ticker fetch fails, that ticker is skipped
but the rest still write. If all fail, the existing JSON is left alone.
"""

from __future__ import annotations
import json
import os
import sys
import time
import urllib.request
import urllib.error

SECTORS = [
    "XLK", "XLF", "XLE", "XLV", "XLI",
    "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC",
]

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH = os.path.join(REPO_ROOT, "data", "sectors_live.json")


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def fetch_quote(symbol: str) -> dict | None:
    """Return {price, prevClose, marketTime} for the ETF, or None on failure."""
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
        "?interval=1d&range=5d&includePrePost=false"
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            payload = json.loads(r.read().decode("utf-8", errors="ignore"))
    except Exception as exc:
        warn(f"{symbol}: fetch failed — {exc}")
        return None

    try:
        result = payload["chart"]["result"][0]
        meta = result["meta"]
    except (KeyError, IndexError, TypeError):
        warn(f"{symbol}: unexpected response shape")
        return None

    price = meta.get("regularMarketPrice")
    prev = meta.get("chartPreviousClose") or meta.get("previousClose")
    ts = meta.get("regularMarketTime")
    if price is None or prev is None:
        warn(f"{symbol}: missing price fields")
        return None
    return {
        "price": float(price),
        "prevClose": float(prev),
        "marketTime": int(ts) if ts is not None else None,
    }


def main() -> int:
    now_ts = int(time.time())
    sectors: dict[str, dict] = {}

    for sym in SECTORS:
        q = fetch_quote(sym)
        if not q:
            continue
        change_pct = (q["price"] / q["prevClose"] - 1) * 100 if q["prevClose"] else 0.0
        sectors[sym.lower()] = {
            "symbol": sym,
            "price": round(q["price"], 4),
            "prevClose": round(q["prevClose"], 4),
            "changePct": round(change_pct, 4),
            "marketTime": q["marketTime"],
        }
        # Tiny stagger so we don't hammer Yahoo in one burst
        time.sleep(0.15)

    if not sectors:
        warn("No sector quotes could be fetched; leaving sectors_live.json unchanged")
        return 0

    payload = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_ts)),
        "generatedAtTs": now_ts,
        "sectorCount": len(sectors),
        "sectors": sectors,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    print(f"sectors_live.json updated: {len(sectors)}/{len(SECTORS)} sectors at {payload['generatedAt']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
