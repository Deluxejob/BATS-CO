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
import datetime as _dt
import json
import os
import sys
import time
import urllib.parse
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
    """Return {price, prevClose, marketTime} for the ETF, or None on failure.

    Yahoo's meta fields `previousClose` and `regularMarketPreviousClose` come
    back null for many ETFs, and `chartPreviousClose` is the close *before* the
    chart's range starts — not the true previous session close. So we ignore
    the meta prevClose values entirely and instead pull the previous session's
    close from the chart daily-candle series.

    We identify "previous session" by DATE, not by array position: look up the
    session date of the current live quote (regularMarketTime), and take the
    most recent chart bar whose date is strictly earlier than that. Positional
    picks like usable[-2] are fragile because Yahoo occasionally drops one of
    the recent daily bars from a range=5d response (missing yesterday, or
    duplicating today), which would silently make the % change compare today
    against TWO days ago. Date-based lookup survives those hiccups.

    Also request range=10d instead of 5d so we always have enough completed
    bars to find yesterday even if a couple are missing.
    """
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
        "?interval=1d&range=10d&includePrePost=false"
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
        stamps = result["timestamp"]
        closes = result["indicators"]["quote"][0]["close"]
    except (KeyError, IndexError, TypeError):
        warn(f"{symbol}: unexpected response shape")
        return None

    price = meta.get("regularMarketPrice")
    ts = meta.get("regularMarketTime")

    # Determine which session date belongs to the current live quote.
    # Prefer the market_time; fall back to "today in UTC" if it's missing.
    if ts is not None:
        today_date = _dt.datetime.fromtimestamp(int(ts), _dt.timezone.utc).date()
    else:
        today_date = _dt.datetime.now(_dt.timezone.utc).date()

    # Walk chart bars; keep those from completed prior sessions.
    completed = []
    for bar_ts, close in zip(stamps or [], closes or []):
        if close is None or bar_ts is None:
            continue
        bar_date = _dt.datetime.fromtimestamp(int(bar_ts), _dt.timezone.utc).date()
        if bar_date < today_date:
            completed.append(float(close))

    prev = completed[-1] if completed else None
    # Final fallback: meta's chartPreviousClose (may be stale but better than nothing)
    if prev is None:
        cpc = meta.get("chartPreviousClose")
        if cpc is not None:
            prev = float(cpc)

    if price is None or prev is None:
        warn(f"{symbol}: missing price fields")
        return None
    return {
        "price": float(price),
        "prevClose": prev,
        "marketTime": int(ts) if ts is not None else None,
    }


YAHOO_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def get_crumb():
    """Prime cookies then fetch a valid crumb from v1/test/getcrumb —
    required for Yahoo's v7 quote endpoint since mid-2024. Tries a few
    primer URLs since fc.yahoo.com is unreliable from some IPs (returns
    404) while finance.yahoo.com works everywhere. Returns
    (crumb, cookie_header) or (None, None) on failure."""
    # Cookie jar so redirects can accumulate Set-Cookie headers.
    import http.cookiejar
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    primers = [
        "https://finance.yahoo.com/",
        "https://fc.yahoo.com/",
        "https://www.yahoo.com/",
    ]
    for url in primers:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": YAHOO_UA})
            with opener.open(req, timeout=15) as _r:
                _r.read(1024)  # touch response
            if any(c.name in ("A1", "A3") for c in jar):
                break  # got the cookies we need
        except Exception:
            continue
    cookie_hdr = "; ".join(f"{c.name}={c.value}" for c in jar)
    try:
        req = urllib.request.Request(
            "https://query1.finance.yahoo.com/v1/test/getcrumb",
            headers={"User-Agent": YAHOO_UA, "Cookie": cookie_hdr},
        )
        with opener.open(req, timeout=15) as r:
            crumb = r.read().decode("utf-8", errors="ignore").strip()
        if not crumb or crumb.startswith("{"):
            return None, None
        return crumb, cookie_hdr
    except Exception as exc:
        warn(f"crumb fetch failed: {exc}")
        return None, None


def fetch_pre_post_batch(symbols, crumb, cookie_hdr):
    """One v7 quote call for all sectors — returns per-symbol dict of
    {marketState, preMarketPrice, preMarketChangePercent, preMarketTime}.
    Returns {} on failure so the caller falls back gracefully to the
    regular-price-only sector data."""
    if not crumb or not symbols:
        return {}
    url = (
        "https://query1.finance.yahoo.com/v7/finance/quote"
        f"?symbols={urllib.parse.quote(','.join(symbols))}"
        f"&crumb={urllib.parse.quote(crumb)}"
    )
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": YAHOO_UA, "Cookie": cookie_hdr})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8", errors="ignore"))
    except Exception as exc:
        warn(f"v7 quote fetch failed: {exc}")
        return {}
    out = {}
    for q in (data.get("quoteResponse", {}).get("result") or []):
        s = q.get("symbol")
        if not s:
            continue
        out[s] = {
            "marketState":            q.get("marketState"),
            "preMarketPrice":         q.get("preMarketPrice"),
            "preMarketChangePercent": q.get("preMarketChangePercent"),
            "preMarketTime":          q.get("preMarketTime"),
        }
    return out


def main() -> int:
    now_ts = int(time.time())
    sectors: dict[str, dict] = {}

    # Fetch pre-market + marketState for every sector in ONE v7 call
    # (uses the standard Yahoo crumb dance — same as api/quote.js does
    # server-side for the browser). Best-effort: on failure we still
    # write the file with regular-price-only sector data.
    crumb, cookie_hdr = get_crumb()
    extras = fetch_pre_post_batch(SECTORS, crumb, cookie_hdr)

    for sym in SECTORS:
        q = fetch_quote(sym)
        if not q:
            continue
        change_pct = (q["price"] / q["prevClose"] - 1) * 100 if q["prevClose"] else 0.0
        extra = extras.get(sym, {})
        sectors[sym.lower()] = {
            "symbol": sym,
            "price": round(q["price"], 4),
            "prevClose": round(q["prevClose"], 4),
            "changePct": round(change_pct, 4),
            "marketTime": q["marketTime"],
            # Pre-market fields let the sector heatmap frontend show
            # pre-market movement during 4-9:30am ET instead of
            # yesterday's regular close. Null when the market state is
            # REGULAR / POST / CLOSED (no pre-market data to report).
            "marketState":       extra.get("marketState"),
            "preMarketPrice":    extra.get("preMarketPrice"),
            "preMarketChangePct": extra.get("preMarketChangePercent"),
            "preMarketTime":     extra.get("preMarketTime"),
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
