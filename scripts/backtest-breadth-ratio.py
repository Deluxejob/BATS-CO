#!/usr/bin/env python3
"""
Backtest the 50MA-breadth / 200MA-breadth ratio.

Ratio = pct(SPX stocks above 50 MA) / pct(SPX stocks above 200 MA)

Chart intuition: when the ratio dips into 0.25-0.50 territory and then
turns UP, that is (per the source chart the user shared) a "solid buy
signal." This script tests that claim on our own ~20-year dataset by:

  1. Computing the daily ratio from data/pct_above_50ma.csv +
     data/pct_above_200ma.csv.
  2. Firing an event on days where the ratio was <= 0.5 within the
     prior N days AND today the ratio ticks up.
  3. Measuring SPX 5d / 20d / 60d / 250d forward returns from each
     event date and comparing to the baseline distribution.
  4. Also tests a stricter cross-up trigger: ratio moves from below
     0.5 to above 0.5 in a single day (fresh cross above the line).

Read-only script — writes nothing. Prints a report with baseline vs
signal returns + a list of every signal firing so the dates can be
eyeballed against real bottoms (2011, 2015-16, 2018, 2020, 2022).
"""
from __future__ import annotations
import csv
import os
import sys
from collections import deque
from statistics import mean

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR  = os.path.join(REPO_ROOT, "data")


# --------------------------- data loading ---------------------------------
def load_date_close(path: str, close_col: int = 1) -> list[tuple[str, float]]:
    rows: list[tuple[str, float]] = []
    with open(path, encoding="utf-8") as f:
        r = csv.reader(f)
        next(r, None)
        for parts in r:
            if len(parts) <= close_col:
                continue
            try:
                v = float(parts[close_col])
            except ValueError:
                continue
            if parts[0]:
                rows.append((parts[0], v))
    return rows


def to_map(rows: list[tuple[str, float]]) -> dict[str, float]:
    return {d: v for d, v in rows}


# --------------------------- main -----------------------------------------
def main() -> int:
    pct50  = load_date_close(os.path.join(DATA_DIR, "pct_above_50ma.csv"))
    pct200 = load_date_close(os.path.join(DATA_DIR, "pct_above_200ma.csv"))
    spx    = load_date_close(os.path.join(DATA_DIR, "spx.csv"))

    m50  = to_map(pct50)
    m200 = to_map(pct200)
    spx_dates = [d for d, _ in spx]
    spx_close = [c for _, c in spx]
    spx_idx   = {d: i for i, d in enumerate(spx_dates)}

    # Build the daily ratio series aligned on every date that has BOTH
    # breadth readings AND an SPX close (so forward returns are computable).
    ratio: list[tuple[str, float]] = []
    for d in sorted(set(m50.keys()) & set(m200.keys())):
        if d not in spx_idx:
            continue
        p200 = m200[d]
        if p200 <= 0:
            continue
        ratio.append((d, m50[d] / p200))

    if len(ratio) < 300:
        print("Not enough overlapping data.")
        return 1

    print(f"\nRatio series: {ratio[0][0]} to {ratio[-1][0]}  --  {len(ratio):,} daily points")

    # -------------- forward-return helper --------------
    def fwd_return(from_date: str, days: int) -> float | None:
        i = spx_idx.get(from_date)
        if i is None:
            return None
        j = i + days
        return (spx_close[j] / spx_close[i] - 1) * 100 if j < len(spx_close) else None

    HORIZONS = [5, 20, 60, 250]

    # -------------- baseline --------------
    print("\nBASELINE (all trading days in the ratio series):")
    print(f"  {'horizon':>8}  {'mean':>7}  {'hit%':>6}   n")
    for h in HORIZONS:
        rs = [r for r in (fwd_return(d, h) for d, _ in ratio) if r is not None]
        if rs:
            hit = sum(1 for r in rs if r > 0) / len(rs) * 100
            print(f"  {h:>4}d    {mean(rs):>+6.1f}%  {hit:>5.1f}%   {len(rs):>4}")

    # -------------- Signal A: "recent low + today ticks up" -------------
    # Fire when:
    #   * min ratio over the last 20 trading days <= 0.5
    #   * today the ratio is HIGHER than yesterday
    #   * no other signal fired in the last 20 days (dedupe cluster)
    print("\n\nSIGNAL A -- recent-low turn-up:")
    print("  ratio <= 0.5 in last 20d AND today > yesterday AND no fire in last 20d")

    LOOKBACK = 20
    events_a: list[tuple[str, float]] = []
    last_fire_idx = -10_000
    for i in range(LOOKBACK + 1, len(ratio)):
        window = [ratio[i - k][1] for k in range(1, LOOKBACK + 1)]
        recent_low = min(window)
        today = ratio[i][1]
        yesterday = ratio[i - 1][1]
        if recent_low <= 0.5 and today > yesterday and (i - last_fire_idx) >= 20:
            events_a.append((ratio[i][0], today))
            last_fire_idx = i

    print(f"  fires: {len(events_a):,} events  (~{len(events_a) / (len(ratio) / 252):.1f}/year)")
    for h in HORIZONS:
        rs = [r for r in (fwd_return(d, h) for d, _ in events_a) if r is not None]
        if rs:
            hit = sum(1 for r in rs if r > 0) / len(rs) * 100
            print(f"    {h:>4}d forward: mean {mean(rs):+.1f}%   hit {hit:.1f}%   n={len(rs)}")

    # -------------- Signal B: "fresh cross above 0.5" -------------
    print("\n\nSIGNAL B -- fresh cross above 0.5:")
    print("  yesterday's ratio <= 0.5 AND today's ratio > 0.5")

    events_b: list[tuple[str, float]] = []
    for i in range(1, len(ratio)):
        if ratio[i - 1][1] <= 0.5 and ratio[i][1] > 0.5:
            events_b.append((ratio[i][0], ratio[i][1]))

    print(f"  fires: {len(events_b):,} events  (~{len(events_b) / (len(ratio) / 252):.1f}/year)")
    for h in HORIZONS:
        rs = [r for r in (fwd_return(d, h) for d, _ in events_b) if r is not None]
        if rs:
            hit = sum(1 for r in rs if r > 0) / len(rs) * 100
            print(f"    {h:>4}d forward: mean {mean(rs):+.1f}%   hit {hit:.1f}%   n={len(rs)}")

    # -------------- Signal C: "confirmed turn-up" -------------
    # Deeper filter than A — require the recent low to be <= 0.5 AND
    # today's ratio > yesterday's AND today's ratio > 5-day average.
    # Confirms momentum after the dip, filters out noise-bounces.
    print("\n\nSIGNAL C -- recent-low + confirmed turn-up (today > 5-day avg):")
    print("  min(ratio, last 20d) <= 0.5 AND today > yesterday AND today > MA(5)")

    events_c: list[tuple[str, float]] = []
    last_fire_idx = -10_000
    for i in range(LOOKBACK + 1, len(ratio)):
        window = [ratio[i - k][1] for k in range(1, LOOKBACK + 1)]
        recent_low = min(window)
        today = ratio[i][1]
        yesterday = ratio[i - 1][1]
        ma5 = mean([ratio[i - k][1] for k in range(0, 5)])
        if (recent_low <= 0.5
            and today > yesterday
            and today > ma5
            and (i - last_fire_idx) >= 20):
            events_c.append((ratio[i][0], today))
            last_fire_idx = i

    print(f"  fires: {len(events_c):,} events  (~{len(events_c) / (len(ratio) / 252):.1f}/year)")
    for h in HORIZONS:
        rs = [r for r in (fwd_return(d, h) for d, _ in events_c) if r is not None]
        if rs:
            hit = sum(1 for r in rs if r > 0) / len(rs) * 100
            print(f"    {h:>4}d forward: mean {mean(rs):+.1f}%   hit {hit:.1f}%   n={len(rs)}")

    # -------------- Signal D: deeper dip (<= 0.35) -------------
    print("\n\nSIGNAL D -- deep-dip variant (last 20d min <= 0.35):")
    print("  same as A but requires the recent low to be <= 0.35, not 0.5")

    events_d: list[tuple[str, float]] = []
    last_fire_idx = -10_000
    for i in range(LOOKBACK + 1, len(ratio)):
        window = [ratio[i - k][1] for k in range(1, LOOKBACK + 1)]
        recent_low = min(window)
        today = ratio[i][1]
        yesterday = ratio[i - 1][1]
        if recent_low <= 0.35 and today > yesterday and (i - last_fire_idx) >= 20:
            events_d.append((ratio[i][0], today))
            last_fire_idx = i

    print(f"  fires: {len(events_d):,} events  (~{len(events_d) / (len(ratio) / 252):.1f}/year)")
    for h in HORIZONS:
        rs = [r for r in (fwd_return(d, h) for d, _ in events_d) if r is not None]
        if rs:
            hit = sum(1 for r in rs if r > 0) / len(rs) * 100
            print(f"    {h:>4}d forward: mean {mean(rs):+.1f}%   hit {hit:.1f}%   n={len(rs)}")

    # -------------- print the deep-dip event dates so we can eyeball
    # them against real market bottoms ---------------------------------
    print("\n\nDEEP-DIP (Signal D) EVENT DATES:")
    print(f"  {'date':>12}  {'ratio':>6}   fwd 20d   fwd 60d   fwd 250d")
    for d, v in events_d:
        f20 = fwd_return(d, 20)
        f60 = fwd_return(d, 60)
        f250 = fwd_return(d, 250)
        def fmt(x):
            return f"{x:+.1f}%" if x is not None else "   --"
        print(f"  {d:>12}  {v:>5.2f}   {fmt(f20):>7}   {fmt(f60):>7}   {fmt(f250):>8}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
