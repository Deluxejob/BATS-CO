#!/usr/bin/env python3
"""
Compute the Buffett Indicator (US total market cap / GDP) from FRED data
and write data/buffett_indicator.csv.

Formula: NCBEILQ027S (Fed Z.1: Nonfinancial Corporate Business, Corporate
Equities as a Liability, in millions of USD) / GDP (nominal, seasonally
adjusted, annual rate, in billions of USD), expressed as a percentage.

The classic Buffett Indicator used Wilshire 5000 Total Market Full Cap
(WILL5000INDFC on FRED) as the numerator, but that series was retired
when Nasdaq took over the Wilshire index. NCBEILQ027S is the modern
standard replacement — the Z.1 flow-of-funds figure for aggregate US
nonfinancial corporate equity — and is what current Buffett Indicator
dashboards (longtermtrends, gurufocus post-2023, etc.) use. Slightly
narrower scope than Wilshire (excludes financials), but the SHAPE of
the series and its interpretation are the same.

Warren Buffett called this "probably the best single measure of where
valuations stand at any given moment" in a 2001 Fortune essay.
Historical bands he referenced:
  <  70%   very cheap
  70-90%   fair value / attractive
  90-115%  reasonable
  115-135% expensive
  > 135%   danger zone

Recent decade has seen readings persistently above the old danger zone
(150-250%+). Different era, different interpretation, but the *shape*
of the series still shows valuation extremes clearly.

Both series are quarterly. Output is a quarterly ratio series, not daily.

Safe on failure: if either fetch or the compute breaks, the existing CSV
is left alone and a warning is logged.
"""

from __future__ import annotations
import csv
import os
import sys
import urllib.request

# NCBEILQ027S = Nonfinancial Corporate Business; Corporate Equities;
# Liability, Level. Reported in millions of dollars.
FRED_MKTCAP = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=NCBEILQ027S"
FRED_GDP    = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=GDP"
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH  = os.path.join(REPO_ROOT, "data", "buffett_indicator.csv")


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def fetch_fred_series(url: str, label: str) -> list[tuple[str, float]]:
    """Return [(YYYY-MM-DD, value)] sorted by date. Empty on failure."""
    # FRED's fredgraph.csv endpoint silently rejects generic browser-style
    # user-agents (Mozilla/5.0 etc.) — the connection hangs until it times out.
    # A curl-style UA passes their bot filter cleanly.
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
        with urllib.request.urlopen(req, timeout=45) as r:
            text = r.read().decode("utf-8", errors="ignore")
    except Exception as exc:
        warn(f"FRED {label} fetch failed: {exc}")
        return []

    rows: list[tuple[str, float]] = []
    lines = text.strip().splitlines()
    if not lines:
        warn(f"FRED {label}: empty response")
        return []
    # Header is "observation_date,SERIES_ID" or "DATE,SERIES_ID"; skip it.
    for line in lines[1:]:
        parts = line.split(",")
        if len(parts) < 2:
            continue
        date, val = parts[0].strip(), parts[1].strip()
        if val in ("", ".", "NA"):   # FRED uses '.' for missing values
            continue
        try:
            rows.append((date, float(val)))
        except ValueError:
            continue
    rows.sort(key=lambda x: x[0])
    return rows


def gdp_at_or_before(gdp_rows: list[tuple[str, float]], date: str) -> float | None:
    """Binary-search the latest GDP value on or before `date`. GDP is quarterly."""
    lo, hi = 0, len(gdp_rows) - 1
    best: float | None = None
    while lo <= hi:
        mid = (lo + hi) // 2
        if gdp_rows[mid][0] <= date:
            best = gdp_rows[mid][1]
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def main() -> int:
    mktcap = fetch_fred_series(FRED_MKTCAP, "NCBEILQ027S (nonfin corp equity)")
    gdp    = fetch_fred_series(FRED_GDP,    "GDP")
    if not mktcap or not gdp:
        return 0

    # Compute ratio for every market-cap date, aligning to the most recent
    # GDP observation. Both series are quarterly on identical release dates,
    # so this is a straight per-quarter divide in practice, but the
    # at-or-before lookup keeps the script robust to any drift.
    # NCBEILQ027S is in millions; GDP is in billions. Convert market cap to
    # billions before dividing: (millions / 1000) / billions * 100.
    out_rows: list[tuple[str, float]] = []
    for date, mcap_millions in mktcap:
        g = gdp_at_or_before(gdp, date)
        if g is None or g <= 0:
            continue
        ratio_pct = ((mcap_millions / 1000.0) / g) * 100.0
        out_rows.append((date, ratio_pct))

    if not out_rows:
        warn("Buffett Indicator: no overlapping Wilshire/GDP rows to compute")
        return 0

    with open(OUT_PATH, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date", "Ratio"])
        for date, r in out_rows:
            w.writerow([date, f"{r:.4f}"])

    latest_date, latest_val = out_rows[-1]
    print(
        f"Buffett Indicator updated: {len(out_rows)} quarterly rows, "
        f"latest {latest_date} = {latest_val:.2f}%"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
