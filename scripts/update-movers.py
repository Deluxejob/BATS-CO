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


def normalize(quote, session):
    """Pick just the fields the frontend needs, using the price/change
    fields for the given session ("regular"/"pre"/"post"). Keeps the JSON
    payload identical in shape across sessions — the client renders the
    same way regardless of which flavor it picked, and the numbers
    already reflect the right session.
    """
    if session == "pre":
        price = quote.get("preMarketPrice")
        pct   = quote.get("preMarketChangePercent")
        chg   = quote.get("preMarketChange")
    elif session == "post":
        price = quote.get("postMarketPrice")
        pct   = quote.get("postMarketChangePercent")
        chg   = quote.get("postMarketChange")
    else:
        price = quote.get("regularMarketPrice")
        pct   = quote.get("regularMarketChangePercent")
        chg   = quote.get("regularMarketChange")
    return {
        "symbol":    quote.get("symbol"),
        "shortName": quote.get("shortName") or quote.get("longName") or "",
        "price":     price,
        "changePct": pct,
        "change":    chg,
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


def partition_by_pct(candidates, pct_key):
    """From a mixed pool, partition by the sign of pct_key. Returns
    (gainers, losers) sorted by pct desc / asc so the biggest movers
    surface first. Tickers where pct_key is None/0 drop out entirely
    (nothing interesting to show)."""
    gainers, losers = [], []
    for q in candidates:
        pct = q.get(pct_key)
        if pct is None:
            continue
        if pct > 0:
            gainers.append(q)
        elif pct < 0:
            losers.append(q)
    gainers.sort(key=lambda q: q[pct_key], reverse=True)
    losers.sort(key=lambda q: q[pct_key])
    return gainers, losers


def main() -> int:
    # Yahoo mis-classifies rows across day_gainers / day_losers, so pull
    # both and re-partition locally. most_actives is included in the pool
    # too — during pre-market / after-hours the pre/post fields on those
    # rows are populated and give us pre-market movers "for free" without
    # needing a separate (nonexistent) pre_market_gainers screener.
    gainers_raw = fetch_screener("day_gainers")
    losers_raw  = fetch_screener("day_losers")
    actives_raw = fetch_screener("most_actives")

    if gainers_raw is None and losers_raw is None and actives_raw is None:
        warn("All three screener fetches failed; leaving movers.json unchanged.")
        return 0

    # Merge all three so we have a broader candidate pool for pre/post
    # sorting — biggest overnight movers often live in most_actives even
    # if day_gainers hasn't caught up yet.
    candidates = merge_unique([gainers_raw, losers_raw, actives_raw])

    # ---- Regular-session partition (existing behavior) --------------
    reg_gainers, reg_losers = partition_by_pct(candidates, "regularMarketChangePercent")
    reg_actives = sorted(
        [q for q in candidates if q.get("regularMarketVolume") is not None],
        key=lambda q: q.get("regularMarketVolume") or 0,
        reverse=True,
    )

    # ---- Pre-market partition --------------------------------------
    # Only tickers where Yahoo populated a preMarket price/pct qualify.
    # "actives" for pre/post = whatever moved the most in absolute terms
    # (Yahoo doesn't expose pre-market volume in the screener payload).
    pre_gainers, pre_losers = partition_by_pct(candidates, "preMarketChangePercent")
    pre_actives = sorted(
        [q for q in candidates if q.get("preMarketChangePercent") is not None],
        key=lambda q: abs(q.get("preMarketChangePercent") or 0),
        reverse=True,
    )

    # ---- After-hours partition -------------------------------------
    post_gainers, post_losers = partition_by_pct(candidates, "postMarketChangePercent")
    post_actives = sorted(
        [q for q in candidates if q.get("postMarketChangePercent") is not None],
        key=lambda q: abs(q.get("postMarketChangePercent") or 0),
        reverse=True,
    )

    def pack(rows, session):
        return [normalize(q, session) for q in rows[:LIST_SIZE] if q.get("symbol")]

    payload = {
        "generatedAt": int(time.time()),
        # Regular session — kept at the top level for backward compat.
        "gainers": pack(reg_gainers, "regular"),
        "losers":  pack(reg_losers,  "regular"),
        "actives": pack(reg_actives, "regular"),
        # Pre-market (04:00-09:30 ET) — populated when Yahoo has preMarket
        # fields on the screener rows. Empty overnight / on weekends.
        "preGainers": pack(pre_gainers, "pre"),
        "preLosers":  pack(pre_losers,  "pre"),
        "preActives": pack(pre_actives, "pre"),
        # After-hours (16:00-20:00 ET) — same idea for postMarket fields.
        "postGainers": pack(post_gainers, "post"),
        "postLosers":  pack(post_losers,  "post"),
        "postActives": pack(post_actives, "post"),
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    print(
        f"Wrote {OUT_PATH}: "
        f"regular {len(payload['gainers'])}/{len(payload['losers'])}/{len(payload['actives'])}, "
        f"pre {len(payload['preGainers'])}/{len(payload['preLosers'])}/{len(payload['preActives'])}, "
        f"post {len(payload['postGainers'])}/{len(payload['postLosers'])}/{len(payload['postActives'])} "
        f"(from {len(candidates)} unique candidates)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
