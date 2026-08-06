#!/usr/bin/env python3
"""
Fetch daily bars for ~100 large-cap S&P constituents from Yahoo, compute
each stock's 200-day SMA, and write data/pct_above_200ma.csv with one
row per trading day: Date,Pct,Coverage.

Runs as part of the daily update workflow. On each run this fetches full
history (~20 years) from Yahoo for every ticker in UNIVERSE and rewrites
the CSV from scratch. That's ~100 API calls but Yahoo tolerates it.

Universe is deliberately restricted to names that have been continuously
public since <= 2005 so the backtest window is stable. Later we may
expand to the full 500 constituents once we're confident in the signal.

Safe on failure: if fewer than 50 tickers fetch successfully OR the
computed series is shorter than the existing CSV, the existing file is
left untouched.
"""

from __future__ import annotations
import csv
import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH_200 = os.path.join(REPO_ROOT, "data", "pct_above_200ma.csv")
OUT_PATH_50  = os.path.join(REPO_ROOT, "data", "pct_above_50ma.csv")

# Same universe used in the backtest (backtest_pct_above_200ma.py in scratch).
# ~100 large-cap S&P constituents continuously public since <= 2005.
UNIVERSE = [
    "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "JPM", "JNJ", "V", "PG", "MA",
    "HD", "CVX", "MRK", "ABBV", "PEP", "KO", "AVGO", "COST", "WMT", "MCD",
    "CSCO", "TMO", "ACN", "ABT", "DHR", "ADBE", "CRM", "TXN", "NEE", "NKE",
    "PFE", "LIN", "WFC", "UNP", "PM", "BMY", "AMGN", "T", "LOW", "UPS",
    "HON", "IBM", "MDT", "QCOM", "ORCL", "CAT", "GS", "BA", "DE", "GE",
    "MMM", "AXP", "BLK", "SBUX", "INTC", "CVS", "SPGI", "PLD", "GILD",
    "MO", "AMT", "USB", "MDLZ", "TGT", "DUK", "CI", "SO", "BDX", "SYK",
    "ISRG", "CB", "MMC", "PNC", "BAC", "C", "COP", "SCHW", "TJX", "APD",
    "ICE", "EOG", "SLB", "ADI", "ADP", "PGR", "LMT", "MU", "AMAT", "F",
    "GM", "COF", "MET", "TROW", "AFL", "TRV", "BK", "STT", "STZ", "WMB",
    "HAL", "OXY", "NOC", "RTX", "GD",
]

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Referer": "https://finance.yahoo.com/",
}

# Fetch ~20 years so we have plenty of runway after the 200-day warmup.
START = int(datetime(2005, 1, 1, tzinfo=timezone.utc).timestamp())
MIN_COVERAGE = 50   # need at least 50 stocks with valid SMA to report a day


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def fetch_daily(symbol: str):
    """Return [(YYYY-MM-DD, close)] or None."""
    end = int(time.time())
    url = (
        f"https://query2.finance.yahoo.com/v8/finance/chart/{symbol}"
        f"?period1={START}&period2={end}&interval=1d&events=div,split"
    )
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError) as e:
        warn(f"{symbol}: fetch failed ({e})")
        return None
    try:
        payload = json.loads(raw)
        result = payload["chart"]["result"][0]
        timestamps = result["timestamp"]
        closes = result["indicators"]["adjclose"][0]["adjclose"]
    except (KeyError, IndexError, TypeError) as e:
        warn(f"{symbol}: parse failed ({e})")
        return None
    bars = []
    for ts, c in zip(timestamps, closes):
        if c is None:
            continue
        d = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
        bars.append((d, float(c)))
    return bars or None


def compute_sma_dates(bars, window=200):
    """Return {date -> SMA_close_ratio} — we don't need SMA value itself,
    just whether close > SMA. Emit True/False per date."""
    out = {}
    n = len(bars)
    if n < window:
        return out
    running = sum(c for _, c in bars[:window])
    out[bars[window - 1][0]] = bars[window - 1][1] > running / window
    for i in range(window, n):
        running += bars[i][1] - bars[i - window][1]
        out[bars[i][0]] = bars[i][1] > running / window
    return out


def _write_pct_csv(out_path: str, above_by_date: dict, ma_label: str) -> int:
    """Given {date -> {sym: True/False}} and an output path, compute the daily
    % above and write to CSV. Returns number of rows written (0 if skipped)."""
    rows = []
    for d in sorted(above_by_date.keys()):
        flags = above_by_date[d]
        if len(flags) < MIN_COVERAGE:
            continue
        above = sum(1 for v in flags.values() if v)
        pct = 100.0 * above / len(flags)
        rows.append((d, f"{pct:.2f}", len(flags)))

    if len(rows) < 500:
        warn(f"Only {len(rows)} rows for {ma_label} (need >= 500). Leaving {out_path} unchanged.")
        return 0

    # Refuse to overwrite a meaningfully longer existing file (Yahoo may be truncated).
    if os.path.exists(out_path):
        try:
            with open(out_path, "r", encoding="utf-8") as f:
                existing = sum(1 for _ in f) - 1
            if existing > len(rows) + 20:
                warn(f"Existing {out_path} has {existing} rows, new fetch only {len(rows)}. "
                     "Leaving unchanged.")
                return 0
        except Exception:
            pass

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Date", "Pct", "Coverage"])
        w.writerows(rows)
    print(f"Wrote {out_path}: {len(rows)} rows, "
          f"latest {rows[-1][0]} = {rows[-1][1]}% above {ma_label} "
          f"({rows[-1][2]} stocks)")
    return len(rows)


def main() -> int:
    print(f"Fetching {len(UNIVERSE)} tickers from Yahoo...")
    above_200_by_date = {}  # date -> {symbol: bool}   (close > 200-day SMA)
    above_50_by_date  = {}  # date -> {symbol: bool}   (close > 50-day SMA)
    fetched_ok = 0
    for sym in UNIVERSE:
        bars = fetch_daily(sym)
        if bars is None or len(bars) < 250:
            continue
        flags200 = compute_sma_dates(bars, 200)
        flags50  = compute_sma_dates(bars, 50)
        for d, above in flags200.items():
            above_200_by_date.setdefault(d, {})[sym] = above
        for d, above in flags50.items():
            above_50_by_date.setdefault(d, {})[sym] = above
        fetched_ok += 1
        # Be polite to Yahoo — small delay between tickers.
        time.sleep(0.15)

    print(f"Successfully fetched {fetched_ok}/{len(UNIVERSE)} tickers")

    if fetched_ok < 50:
        warn(f"Only {fetched_ok} tickers fetched (need >= 50). Leaving CSVs unchanged.")
        return 0

    _write_pct_csv(OUT_PATH_200, above_200_by_date, "200 MA")
    _write_pct_csv(OUT_PATH_50,  above_50_by_date,  "50 MA")
    return 0


if __name__ == "__main__":
    sys.exit(main())
