#!/usr/bin/env python3
"""
Backtest the "breadth washout" signal — fires when the % of S&P 500
large-caps above their 50-day MA collapses to an absolute extreme (<10%).

The idea: the Breadth Ratio (50/200) signal misses shock crashes where
BOTH breadth measures crater together (e.g. Apr 2025 Liberation Day —
pct50 hit 7.8%, ratio only touched 0.40, never crossed 0.35). A raw
"pct50 in the tank" trigger catches those bottoms directly.

Tests four variants:
  A -- pct50 <= 10 (any day in that state)
  B -- pct50 <= 10 recently AND today ticks up (early bounce)
  C -- fresh cross up through 10% (yesterday <=10, today >10)
  D -- deeper: pct50 <= 5 recently AND today ticks up (real capitulation)

Prints baseline + per-signal forward return stats + a list of fire
dates so we can eyeball against real bottoms.
"""
from __future__ import annotations
import csv
import os
import sys
from statistics import mean

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR  = os.path.join(REPO_ROOT, "data")


def load_date_close(path: str, col: int = 1) -> list[tuple[str, float]]:
    rows: list[tuple[str, float]] = []
    with open(path, encoding="utf-8") as f:
        r = csv.reader(f)
        next(r, None)
        for parts in r:
            if len(parts) <= col:
                continue
            try:
                v = float(parts[col])
            except ValueError:
                continue
            if parts[0]:
                rows.append((parts[0], v))
    return rows


def main() -> int:
    pct50 = load_date_close(os.path.join(DATA_DIR, "pct_above_50ma.csv"))
    spx   = load_date_close(os.path.join(DATA_DIR, "spx.csv"))

    m50 = {d: v for d, v in pct50}
    spx_dates = [d for d, _ in spx]
    spx_close = [c for _, c in spx]
    spx_idx   = {d: i for i, d in enumerate(spx_dates)}

    # Aligned series where BOTH the breadth read and an SPX close exist.
    aligned = []
    for d in sorted(m50):
        if d in spx_idx:
            aligned.append((d, m50[d]))
    if len(aligned) < 300:
        print("Not enough overlapping data")
        return 1

    print(f"\nBreadth series: {aligned[0][0]} to {aligned[-1][0]}  --  {len(aligned):,} daily points")

    def fwd_return(from_date: str, days: int) -> float | None:
        i = spx_idx.get(from_date)
        if i is None:
            return None
        j = i + days
        return (spx_close[j] / spx_close[i] - 1) * 100 if j < len(spx_close) else None

    HORIZONS = [5, 20, 60, 250]

    def report(name: str, events: list[tuple[str, float]]) -> None:
        print(f"\n{name}")
        print(f"  fires: {len(events):,}  (~{len(events) / (len(aligned) / 252):.2f}/year)")
        for h in HORIZONS:
            rs = [r for r in (fwd_return(d, h) for d, _ in events) if r is not None]
            if rs:
                hit = sum(1 for r in rs if r > 0) / len(rs) * 100
                print(f"    {h:>4}d forward: mean {mean(rs):+.1f}%   hit {hit:.1f}%   n={len(rs)}")

    # -------------- baseline --------------
    print("\nBASELINE (all trading days):")
    print(f"  {'horizon':>8}  {'mean':>7}  {'hit%':>6}   n")
    for h in HORIZONS:
        rs = [r for r in (fwd_return(d, h) for d, _ in aligned) if r is not None]
        if rs:
            hit = sum(1 for r in rs if r > 0) / len(rs) * 100
            print(f"  {h:>4}d    {mean(rs):>+6.1f}%  {hit:>5.1f}%   {len(rs):>4}")

    # -------------- Signal A: any pct50 <= 10 day --------------
    events_a = [(d, v) for d, v in aligned if v <= 10]
    report("SIGNAL A -- any day with pct50 <= 10:", events_a)

    # -------------- Signal B: recent-low + turn-up --------------
    LOOKBACK, MIN_GAP, THR = 20, 20, 10
    events_b, last = [], -MIN_GAP - 1
    for i in range(LOOKBACK, len(aligned)):
        recent_low = min(aligned[i - k][1] for k in range(1, LOOKBACK + 1))
        today, yest = aligned[i][1], aligned[i - 1][1]
        if recent_low <= THR and today > yest and (i - last) >= MIN_GAP:
            events_b.append(aligned[i])
            last = i
    report("SIGNAL B -- pct50 hit <=10 in last 20d AND today ticks up:", events_b)

    # -------------- Signal C: fresh cross up through 10 --------------
    events_c = []
    for i in range(1, len(aligned)):
        if aligned[i - 1][1] <= 10 and aligned[i][1] > 10:
            events_c.append(aligned[i])
    report("SIGNAL C -- fresh cross above 10% (yesterday <=10, today >10):", events_c)

    # -------------- Signal D: deeper washout (<=5) + turn-up --------------
    THR_D = 5
    events_d, last = [], -MIN_GAP - 1
    for i in range(LOOKBACK, len(aligned)):
        recent_low = min(aligned[i - k][1] for k in range(1, LOOKBACK + 1))
        today, yest = aligned[i][1], aligned[i - 1][1]
        if recent_low <= THR_D and today > yest and (i - last) >= MIN_GAP:
            events_d.append(aligned[i])
            last = i
    report("SIGNAL D -- deeper washout (<=5) recent AND today ticks up:", events_d)

    print("\n\nSIGNAL B event dates:")
    print(f"  {'date':>12}  {'pct50':>6}   fwd 20d   fwd 60d   fwd 250d")
    for d, v in events_b:
        def fmt(x): return f"{x:+.1f}%" if x is not None else "   --"
        print(f"  {d:>12}  {v:>5.1f}   {fmt(fwd_return(d, 20)):>7}   {fmt(fwd_return(d, 60)):>7}   {fmt(fwd_return(d, 250)):>8}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
