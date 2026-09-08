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
import urllib.parse
from http.cookiejar import CookieJar

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH = os.path.join(REPO_ROOT, "data", "movers.json")

BASE_URL = (
    "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved"
    "?count=50&scrIds={scr}"
)

# How many rows to keep per list in the final JSON.
LIST_SIZE = 25

# Extra candidate pool — a curated list of US large-caps + top international
# ADRs that we always want to check for pre/post-market moves. Yahoo's
# predefined day_gainers / day_losers / most_actives screeners skew toward
# smaller / faster-moving names during regular session, so a household
# large-cap (AMGN, NVS, LLY, ...) that gets hit on news at 4 am often
# never enters the pool and never surfaces on the pre-market movers board.
# This list guarantees we ask Yahoo about them every cycle. Duplicates
# with the screener rows are removed by merge_unique().
LARGE_CAP_WATCHLIST = [
    # S&P 100 core — the US mega/large-caps that could move any morning
    "AAPL","MSFT","NVDA","AMZN","GOOGL","GOOG","META","TSLA","BRK-B","LLY",
    "JPM","WMT","XOM","V","MA","UNH","JNJ","PG","HD","AVGO",
    "ORCL","ABBV","BAC","CVX","KO","PEP","TMO","COST","MRK","ADBE",
    "CRM","CSCO","AMD","NFLX","LIN","ACN","MCD","ABT","IBM","TXN",
    "PM","WFC","DIS","AXP","INTU","GS","BKNG","T","NOW","RTX",
    "UBER","QCOM","BLK","AMGN","CAT","ISRG","PGR","PFE","C","NEE",
    "SPGI","LOW","ANET","HON","BX","GILD","DHR","TJX","LMT","DE",
    "ADP","SYK","VRTX","REGN","BSX","MDLZ","ADI","TMUS","MMC","PLD",
    "PANW","KLAC","AMT","SBUX","INTC","CB","MU","ELV","MO","DUK",
    "SO","CI","CMCSA","ABNB","KKR","ICE","USB","MDT","BMY","EOG",
    "APD","GE","EMR","BA",
    # US large-caps outside S&P 100 that make news often
    "SNPS","CDNS","MRVL","SMCI","ARM","CRWD","SNOW","PLTR","DDOG","FTNT",
    "ON","MPWR","LULU","F","GM","COIN","HOOD","PYPL","MDB",
    # Top international ADRs (NVS was the miss that prompted this list)
    "NVS","NVO","TSM","BABA","ASML","SAP","TM","SONY","AZN","SNY",
    "GSK","SHEL","BP","UL","BUD","BTI","HSBC","RY","BHP","RIO",
    "TD","VALE","PBR","STLA","TEVA",
]
QUOTE_BATCH_SIZE = 50  # Yahoo v7 quote is happy with 50 syms in one URL


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


YAHOO_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://finance.yahoo.com/",
}


# Cookie-primer URLs, tried in order until one yields cookies. fc.yahoo.com
# is the classic entry point but some ISPs intercept it with a proxy that
# returns 404; guce.yahoo.com/consent works when that fails (GDPR gate
# always sets A1/A3/GUC on a plain GET).
CRUMB_PRIMER_URLS = (
    "https://fc.yahoo.com/",
    "https://guce.yahoo.com/consent",
)


def get_yahoo_crumb():
    """Prime Yahoo cookies at one of CRUMB_PRIMER_URLS, then hit getcrumb.
    Returns (crumb, cookie_header) or (None, None) on failure — in which
    case the watchlist fetch is skipped and the script degrades to the
    original screener-only behavior."""
    jar = CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    for primer_url in CRUMB_PRIMER_URLS:
        try:
            req = urllib.request.Request(primer_url, headers=YAHOO_HEADERS)
            with opener.open(req, timeout=15) as r:
                r.read()
        except (urllib.error.URLError, TimeoutError) as e:
            warn(f"crumb primer {primer_url} failed: {e}")
            continue
        if len(list(jar)):
            break
    cookie_header = "; ".join(f"{c.name}={c.value}" for c in jar)
    if not cookie_header:
        warn("no crumb primer succeeded; skipping watchlist fetch")
        return None, None

    crumb_req = urllib.request.Request(
        "https://query1.finance.yahoo.com/v1/test/getcrumb",
        headers={**YAHOO_HEADERS, "Cookie": cookie_header},
    )
    try:
        with urllib.request.urlopen(crumb_req, timeout=15) as r:
            crumb = r.read().decode("utf-8", errors="replace").strip()
    except (urllib.error.URLError, TimeoutError) as e:
        warn(f"getcrumb failed: {e}")
        return None, None
    if not crumb:
        warn("getcrumb returned empty")
        return None, None
    return crumb, cookie_header


def fetch_watchlist_quotes():
    """Batch-fetch quote rows for LARGE_CAP_WATCHLIST via Yahoo v7 quote.
    Returns a list of raw quote dicts in the same shape screener rows use,
    so merge_unique() can fold them straight into the candidate pool.
    Empty list on any failure — the script degrades to screener-only."""
    crumb, cookies = get_yahoo_crumb()
    if not crumb:
        return []
    quotes = []
    for i in range(0, len(LARGE_CAP_WATCHLIST), QUOTE_BATCH_SIZE):
        batch = LARGE_CAP_WATCHLIST[i:i+QUOTE_BATCH_SIZE]
        url = (
            "https://query1.finance.yahoo.com/v7/finance/quote"
            f"?symbols={','.join(batch)}"
            f"&crumb={urllib.parse.quote(crumb, safe='')}"
        )
        req = urllib.request.Request(url, headers={**YAHOO_HEADERS, "Cookie": cookies})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.loads(r.read().decode("utf-8", errors="replace"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            warn(f"watchlist quote batch {i//QUOTE_BATCH_SIZE} failed: {e}")
            continue
        result = data.get("quoteResponse", {}).get("result") or []
        quotes.extend(result)
    return quotes


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
    # LARGE_CAP_WATCHLIST — always-on set of ~160 US large-caps + top ADRs.
    # See the constant's block comment for why this exists (short version:
    # Yahoo screeners drop household names like AMGN/NVS/LLY out of the
    # candidate pool, so pre-market moves on those never surface).
    watchlist_raw = fetch_watchlist_quotes()

    if gainers_raw is None and losers_raw is None and actives_raw is None and not watchlist_raw:
        warn("All fetches failed; leaving movers.json unchanged.")
        return 0

    # Merge all sources so we have a broader candidate pool for pre/post
    # sorting — biggest overnight movers often live in most_actives even
    # if day_gainers hasn't caught up yet, and named large-caps only exist
    # in the watchlist source.
    candidates = merge_unique([gainers_raw, losers_raw, actives_raw, watchlist_raw])

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
        f"(from {len(candidates)} unique candidates; watchlist contributed {len(watchlist_raw)})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
