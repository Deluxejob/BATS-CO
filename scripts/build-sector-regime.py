#!/usr/bin/env python3
"""
Compute the daily Sector Rotation Regime Spread and write data/sector_regime.csv.

Formula (matches sector-rotation.html):
  spread_3m = avg(cyclical 3M returns) - avg(defensive 3M returns)
  Cyclicals: XLK, XLF, XLI, XLY, XLC   (5 ETFs; XLC only from 2018-06)
  Defensives: XLV, XLP, XLU, XLRE      (4 ETFs; XLRE only from 2015-10)
  3M = 63 trading days lookback

Regime score is a piecewise-linear 0-100 mapping of the spread — same
mapping the sector-rotation page uses (high score = risk-on, low = defensive).

Runs as part of the daily update workflow. Reads data/sectors/*.csv which
are already fetched daily. Safe on failure: if fewer than 3 cyclicals or
3 defensives have valid data on any given day, that day is skipped.
"""

from __future__ import annotations
import csv
import os
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SECTOR_DIR = os.path.join(REPO_ROOT, "data", "sectors")
OUT_PATH = os.path.join(REPO_ROOT, "data", "sector_regime.csv")

CYCLICALS = ["XLK", "XLF", "XLI", "XLY", "XLC"]
DEFENSIVES = ["XLV", "XLP", "XLU", "XLRE"]
LOOKBACK = 63
MIN_PER_GROUP = 3


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def load_close(fname: str) -> dict[str, float] | None:
    path = os.path.join(SECTOR_DIR, fname)
    if not os.path.exists(path):
        return None
    out = {}
    with open(path, newline="", encoding="utf-8") as f:
        rdr = csv.reader(f)
        next(rdr, None)
        for row in rdr:
            if len(row) < 2:
                continue
            try:
                out[row[0]] = float(row[1])
            except ValueError:
                pass
    return out


def regime_score(spread: float) -> float:
    """Piecewise-linear 0-100 map — verbatim from sector-rotation.html."""
    s = spread
    if s <= -8: return max(0.0, 15.0 + (s + 8) * (15.0 / 4))
    if s <= -5: return 15.0 + (s + 8) * (15.0 / 3)
    if s <= -1: return 30.0 + (s + 5) * (15.0 / 4)
    if s <=  1: return 45.0 + (s + 1) * (10.0 / 2)
    if s <=  5: return 55.0 + (s - 1) * (15.0 / 4)
    if s <=  8: return 70.0 + (s - 5) * (15.0 / 3)
    return min(100.0, 85.0 + (s - 8) * (15.0 / 4))


def main() -> int:
    print(f"Loading sector data from {SECTOR_DIR}...")
    data = {}
    for sym in CYCLICALS + DEFENSIVES:
        d = load_close(f"{sym.lower()}.csv")
        if d is None:
            warn(f"Missing data/sectors/{sym.lower()}.csv — sector will be skipped")
            data[sym] = {}
        else:
            data[sym] = d
        print(f"  {sym}: {len(data[sym])} rows")

    # Build per-symbol sorted dates + index-map so 3M lookup is O(1).
    dates = {sym: sorted(data[sym].keys()) for sym in data}
    idx   = {sym: {d: i for i, d in enumerate(dates[sym])} for sym in data}

    def ret_3m(sym: str, d: str):
        i = idx[sym].get(d)
        if i is None or i < LOOKBACK:
            return None
        base = data[sym][dates[sym][i - LOOKBACK]]
        now = data[sym][d]
        if not base:
            return None
        return (now / base - 1.0) * 100.0

    # Iterate the union of all sector dates. For each day, require the
    # minimum group coverage.
    all_dates = set()
    for sym in data:
        all_dates.update(dates[sym])
    all_dates_sorted = sorted(all_dates)

    rows = []
    for d in all_dates_sorted:
        cyc = [ret_3m(s, d) for s in CYCLICALS]
        dfn = [ret_3m(s, d) for s in DEFENSIVES]
        cyc = [r for r in cyc if r is not None]
        dfn = [r for r in dfn if r is not None]
        if len(cyc) < MIN_PER_GROUP or len(dfn) < MIN_PER_GROUP:
            continue
        spread = (sum(cyc) / len(cyc)) - (sum(dfn) / len(dfn))
        score = regime_score(spread)
        rows.append((d, f"{spread:.4f}", f"{score:.2f}"))

    if len(rows) < 500:
        warn(f"Only {len(rows)} rows computed (need >= 500). Leaving CSV unchanged.")
        return 0

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Date", "Spread", "Score"])
        w.writerows(rows)
    print(f"Wrote {OUT_PATH}: {len(rows)} rows, "
          f"latest {rows[-1][0]} spread={rows[-1][1]} score={rows[-1][2]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
