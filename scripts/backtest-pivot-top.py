#!/usr/bin/env python3
"""
Backtest the Pivot Top sub-gauge composite (see computePivotTop in app.js).

Pivot Top is the "top warning" sub-gauge on the home page — a weighted
average of five overheating signals:

  Weight  Signal
  ------  ------
     40   SPY RSI overbought (piecewise: 0 at RSI 60, 50 at 70, 100 at 75+)
     20   NAAIM extreme leverage (0 at 75, 100 at 100)
     25   SPX overextended vs 50-day MA (0 at +2%, 100 at +7%)
     15   VIX complacency (0 at 15, 100 at 10)
     25   Bollinger %B (piecewise, 0 at <0.5, 75 at %B=1.0, 98 at >1.1)

Then a piecewise stretch: raw <=30 passes through; raw >30 gets scaled
by 1.2 (so a historical raw max of 85.7 lands near 100).

Question this backtest answers: does a HIGH Pivot Top reading actually
precede WEAKER-than-baseline SPX forward returns? If yes, the sub-gauge
is doing its job. If not, it's decorative.

Read-only. Prints a report with baseline vs bucket returns + a list of
every day the score exceeded 70 so we can eyeball against real tops.
"""
from __future__ import annotations
import csv
import os
import sys
from statistics import mean

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR  = os.path.join(REPO_ROOT, "data")


# --------------------------- data loading ---------------------------------
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


def to_map(rows: list[tuple[str, float]]) -> dict[str, float]:
    return {d: v for d, v in rows}


# --------------------------- indicators -----------------------------------
def compute_rsi_wilder(closes: list[float], period: int = 14) -> list[float | None]:
    n = len(closes)
    rsi: list[float | None] = [None] * n
    if n <= period:
        return rsi
    gains, losses = [], []
    for i in range(1, period + 1):
        chg = closes[i] - closes[i - 1]
        gains.append(max(chg, 0))
        losses.append(max(-chg, 0))
    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period
    rsi[period] = 100 - (100 / (1 + avg_gain / avg_loss)) if avg_loss > 0 else 100.0
    for i in range(period + 1, n):
        chg = closes[i] - closes[i - 1]
        g = max(chg, 0)
        l = max(-chg, 0)
        avg_gain = (avg_gain * (period - 1) + g) / period
        avg_loss = (avg_loss * (period - 1) + l) / period
        rsi[i] = 100 - (100 / (1 + avg_gain / avg_loss)) if avg_loss > 0 else 100.0
    return rsi


def compute_sma(closes: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(closes)
    running = 0.0
    for i, c in enumerate(closes):
        running += c
        if i >= period:
            running -= closes[i - period]
        if i >= period - 1:
            out[i] = running / period
    return out


def compute_bollinger_pctb(closes: list[float], period: int = 20, k: float = 2.0) -> list[float | None]:
    """Bollinger %B — same math as app.js computeBollingerBSeries."""
    n = len(closes)
    out: list[float | None] = [None] * n
    if n < period:
        return out
    for i in range(period - 1, n):
        window = closes[i - period + 1 : i + 1]
        m = sum(window) / period
        var = sum((c - m) ** 2 for c in window) / period
        sd = var ** 0.5
        if sd <= 0:
            continue
        upper = m + k * sd
        lower = m - k * sd
        rng = upper - lower
        if rng <= 0:
            continue
        out[i] = (closes[i] - lower) / rng
    return out


# --------------------------- Pivot Top score ------------------------------
# Mirrors computePivotTop() in app.js. Keep in sync when weights or ramps
# change over there.
def pt_rsi(rsi: float | None) -> float | None:
    if rsi is None:
        return None
    if rsi <= 60:
        return 0.0
    if rsi <= 70:
        return (rsi - 60) * 5                # 60->0, 70->50
    return min(100.0, 50 + (rsi - 70) * 10)  # 70->50, 75->100


def pt_naaim(v: float | None) -> float | None:
    if v is None:
        return None
    return max(0.0, min(100.0, (v - 75) * 4))       # 75->0, 100->100


def pt_ma50(dist_pct: float | None) -> float | None:
    if dist_pct is None:
        return None
    return max(0.0, min(100.0, (dist_pct - 2) * 20))   # +2%->0, +7%->100


def pt_vix(v: float | None) -> float | None:
    if v is None:
        return None
    return max(0.0, min(100.0, (15 - v) * 20))       # 15->0, 10->100


def pt_bbval(b: float | None) -> float | None:
    if b is None:
        return None
    if b < 0.5:
        return 0.0
    if b < 0.7:
        s = (b - 0.5) * (15 / 0.2)
    elif b < 0.9:
        s = 15 + (b - 0.7) * ((45 - 15) / 0.2)
    elif b < 1.0:
        s = 45 + (b - 0.9) * ((75 - 45) / 0.1)
    elif b < 1.1:
        s = 75 + (b - 1.0) * ((95 - 75) / 0.1)
    else:
        s = 98.0
    return max(0.0, min(100.0, s))


PT_WEIGHTS: list[tuple[str, int, callable]] = [
    ("rsi",   40, pt_rsi),
    ("naaim", 20, pt_naaim),
    ("ma50",  25, pt_ma50),
    ("vix",   15, pt_vix),
    ("bb",    25, pt_bbval),
]


def compute_pivot_top(inputs: dict) -> float | None:
    total, wsum = 0.0, 0
    for key, w, fn in PT_WEIGHTS:
        s = fn(inputs.get(key))
        if s is None:
            continue
        total += s * w
        wsum += w
    if not wsum:
        return None
    raw = total / wsum
    # Scaling stretch: matches computePivotTop in app.js.
    return raw if raw <= 30 else min(100.0, 30 + (raw - 30) * 1.2)


# --------------------------- main -----------------------------------------
def main() -> int:
    vix    = to_map(load_date_close(os.path.join(DATA_DIR, "vix.csv"), col=4))  # DATE,OPEN,HIGH,LOW,CLOSE
    # vix.csv might be Date,Close only — try col=1 too, use whichever succeeds
    if not vix:
        vix = to_map(load_date_close(os.path.join(DATA_DIR, "vix.csv"), col=1))
    spx    = load_date_close(os.path.join(DATA_DIR, "spx.csv"))
    spy    = load_date_close(os.path.join(DATA_DIR, "spy.csv"))
    naaim  = load_date_close(os.path.join(DATA_DIR, "naaim.csv"))

    spx_dates = [d for d, _ in spx]
    spx_close = [c for _, c in spx]
    spx_idx   = {d: i for i, d in enumerate(spx_dates)}
    sma50 = compute_sma(spx_close, 50)
    bb    = compute_bollinger_pctb(spx_close, 20, 2)

    spy_dates = [d for d, _ in spy]
    spy_close = [c for _, c in spy]
    rsi_series = compute_rsi_wilder(spy_close, 14)
    spy_idx   = {d: i for i, d in enumerate(spy_dates)}

    # NAAIM is weekly — do most-recent-on-or-before lookup.
    naaim_sorted = sorted(naaim, key=lambda x: x[0])
    def naaim_at(target: str) -> float | None:
        best = None
        for d, v in naaim_sorted:
            if d <= target:
                best = v
            else:
                break
        return best

    # Walk history — compute Pivot Top on every day where all inputs exist.
    scores: list[tuple[str, float]] = []
    for i, d in enumerate(spx_dates):
        s50 = sma50[i]
        b   = bb[i]
        if s50 is None or b is None:
            continue
        v = vix.get(d)
        r = rsi_series[spy_idx[d]] if d in spy_idx else None
        n = naaim_at(d)
        if v is None or r is None or n is None:
            continue
        ma50_dist = (spx_close[i] / s50 - 1) * 100
        score = compute_pivot_top({
            "rsi": r, "naaim": n, "ma50": ma50_dist, "vix": v, "bb": b,
        })
        if score is not None:
            scores.append((d, score))

    if not scores:
        print("No backtestable days")
        return 1

    print(f"\nBacktest window: {scores[0][0]} to {scores[-1][0]}  --  {len(scores):,} trading days\n")

    HORIZONS = [5, 20, 60, 250]

    def fwd_return(from_date: str, days: int) -> float | None:
        i = spx_idx.get(from_date)
        if i is None:
            return None
        j = i + days
        return (spx_close[j] / spx_close[i] - 1) * 100 if j < len(spx_close) else None

    # -------------- baseline --------------
    print("BASELINE (all backtested days):")
    print(f"  {'horizon':>8}  {'mean':>7}  {'hit%':>6}   n")
    for h in HORIZONS:
        rs = [r for r in (fwd_return(d, h) for d, _ in scores) if r is not None]
        if rs:
            hit = sum(1 for r in rs if r > 0) / len(rs) * 100
            print(f"  {h:>4}d    {mean(rs):>+6.1f}%  {hit:>5.1f}%   {len(rs):>4}")

    # -------------- by bucket --------------
    BUCKETS = [
        ("  0-20", 0, 20),
        (" 20-40", 20, 40),
        (" 40-60", 40, 60),
        (" 60-80", 60, 80),
        (" 80-100", 80, 101),
    ]
    print("\nBY PIVOT TOP SCORE BUCKET:")
    for h in HORIZONS:
        print(f"\n  Forward horizon: {h}d")
        print(f"  {'bucket':>8}  {'mean':>7}  {'hit%':>6}   n")
        for tag, lo, hi in BUCKETS:
            rs = []
            for d, s in scores:
                if lo <= s < hi:
                    r = fwd_return(d, h)
                    if r is not None:
                        rs.append(r)
            if not rs:
                print(f"  {tag}    {'--':>7}   {'--':>6}   0")
                continue
            hit = sum(1 for r in rs if r > 0) / len(rs) * 100
            print(f"  {tag}   {mean(rs):>+6.1f}%  {hit:>5.1f}%   {len(rs):>4}")

    # -------------- high-conviction fires --------------
    print("\n\nHIGH-CONVICTION FIRES (score >= 70):")
    high = [(d, s) for d, s in scores if s >= 70]
    print(f"  Total: {len(high):,} days ({len(high) / len(scores) * 100:.2f}% of history)")
    for h in HORIZONS:
        rs = [r for r in (fwd_return(d, h) for d, _ in high) if r is not None]
        if rs:
            hit = sum(1 for r in rs if r > 0) / len(rs) * 100
            print(f"    {h:>4}d forward:  mean {mean(rs):+.1f}%   hit {hit:.1f}%   n={len(rs)}")

    print("\n\nTOP 10 ALL-TIME HIGHEST SCORES:")
    print(f"  {'date':>12}  {'score':>6}   fwd 20d   fwd 60d   fwd 250d")
    for d, s in sorted(scores, key=lambda x: -x[1])[:10]:
        def fmt(v):
            return f"{v:+.1f}%" if v is not None else "   --"
        print(f"  {d:>12}  {s:>5.1f}   {fmt(fwd_return(d, 20)):>7}   {fmt(fwd_return(d, 60)):>7}   {fmt(fwd_return(d, 250)):>8}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
