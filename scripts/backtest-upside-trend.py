#!/usr/bin/env python3
"""
Backtest the Upside Trend sub-gauge composite (see computeUpsideTrend in
app.js).

Upside Trend is the "is the current uptrend broad and healthy?" sub-gauge
on the home page — a weighted average of 11 trend/participation/momentum
signals.

  Weight  Signal
  ------  ------
     10   SPX vs 200-day MA
      8   SPX vs 50-day MA
     15   % of stocks above 200 MA
      8   % of stocks above 50 MA
     10   Sector Regime spread
      7   Junk Bond Demand (HYG-LQD 20d spread)
      7   Sector Oscillator (day-to-day participation)
      8   SPX 5-day ROC
      7   SPX 10-day ROC
     10   MACD histogram (as % of price)
     10   Bollinger %B (20-day, 2sd)

Question this backtest answers: does a HIGH Upside Trend reading precede
STRONGER-than-baseline forward returns? Does a LOW reading precede
weaker returns? If yes, the sub-gauge is doing its job.

Read-only. Prints a report with baseline vs per-bucket returns + a list
of every day where the score hit its all-time highest values.
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
    n = len(closes)
    out: list[float | None] = [None] * n
    for i in range(period - 1, n):
        window = closes[i - period + 1: i + 1]
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


def compute_macd_hist_pct(closes: list[float], fast: int = 12, slow: int = 26, signal: int = 9) -> list[float | None]:
    """MACD histogram as % of current price."""
    n = len(closes)
    if n < slow + signal:
        return [None] * n

    def ema(vals: list[float], period: int) -> list[float]:
        k = 2 / (period + 1)
        out = [vals[0]]
        for v in vals[1:]:
            out.append(v * k + out[-1] * (1 - k))
        return out

    ema_fast = ema(closes, fast)
    ema_slow = ema(closes, slow)
    macd_line = [f - s for f, s in zip(ema_fast, ema_slow)]
    sig_line = ema(macd_line, signal)
    out: list[float | None] = [None] * n
    for i in range(slow + signal - 1, n):
        hist = macd_line[i] - sig_line[i]
        if closes[i] > 0:
            out[i] = hist / closes[i] * 100
    return out


# --------------------------- score functions ------------------------------
# Faithful ports of the functions in app.js. Keep in sync.
def _clamp(x, lo, hi):
    return max(lo, min(hi, x))


def score_ma200(d):
    if d is None: return None
    if d <= -15: s = 5
    elif d <= -5: s = 5 + (d + 15) * (30 - 5) / 10
    elif d <=  5: s = 30 + (d + 5) * (50 - 30) / 10
    elif d <= 10: s = 50 + (d - 5) * (70 - 50) / 5
    elif d <= 15: s = 70 + (d - 10) * (90 - 70) / 5
    else: s = 95
    return _clamp(s, 2, 98)


def score_ma50(d):
    if d is None: return None
    if d <= -8: s = 5
    elif d <= -3: s = 5 + (d + 8) * (30 - 5) / 5
    elif d <=  0: s = 30 + (d + 3) * (50 - 30) / 3
    elif d <=  3: s = 50 + d * (70 - 50) / 3
    elif d <=  6: s = 70 + (d - 3) * (88 - 70) / 3
    else: s = 90
    return _clamp(s, 2, 98)


def score_pct_above_ma(pct):
    if pct is None: return None
    if pct <= 15: s = 5
    elif pct <= 30: s = 5 + (pct - 15) * (25 - 5) / 15
    elif pct <= 45: s = 25 + (pct - 30) * (45 - 25) / 15
    elif pct <= 65: s = 45 + (pct - 45) * (65 - 45) / 20
    elif pct <= 85: s = 65 + (pct - 65) * (80 - 65) / 20
    else: s = 80 + (pct - 85) * (90 - 80) / 15
    return _clamp(s, 2, 98)


def score_bollinger_b(pctb):
    if pctb is None: return None
    if pctb <= 0: s = 5
    elif pctb <= 0.3: s = 5 + pctb * (25 - 5) / 0.3
    elif pctb <= 0.5: s = 25 + (pctb - 0.3) * (50 - 25) / 0.2
    elif pctb <= 0.7: s = 50 + (pctb - 0.5) * (70 - 50) / 0.2
    elif pctb <= 1.0: s = 70 + (pctb - 0.7) * (90 - 70) / 0.3
    else: s = 95
    return _clamp(s, 2, 98)


def score_macd_hist(hist):
    if hist is None: return None
    if hist <= -0.3: s = 5
    elif hist <=  0: s = 5 + (hist + 0.3) * (50 - 5) / 0.3
    elif hist <=  0.3: s = 50 + hist * (90 - 50) / 0.3
    else: s = 95
    return _clamp(s, 2, 98)


def score_roc5(roc):
    if roc is None: return None
    CLAMP = 6.0
    c = _clamp(roc, -CLAMP, CLAMP)
    return _clamp(50 + (c / CLAMP) * 50, 2, 98)


def score_roc10(roc):
    if roc is None: return None
    CLAMP = 8.0
    c = _clamp(roc, -CLAMP, CLAMP)
    return _clamp(50 + (c / CLAMP) * 45, 5, 95)


def score_junk_demand(spread):
    if spread is None: return None
    return _clamp(50 + spread * 10, 5, 95)


def score_sector_regime(s):
    if s is None: return None
    if s <= -8: score = max(0, 15 + (s + 8) * (15 / 4))
    elif s <= -5: score = 15 + (s + 8) * (15 / 3)
    elif s <= -1: score = 30 + (s + 5) * (15 / 4)
    elif s <=  1: score = 45 + (s + 1) * (10 / 2)
    elif s <=  5: score = 55 + (s - 1) * (15 / 4)
    elif s <=  8: score = 70 + (s - 5) * (15 / 3)
    else: score = min(100, 85 + (s - 8) * (15 / 4))
    return _clamp(score, 2, 98)


def score_sector_osc(o):
    if o is None: return None
    CLAMP = 25
    c = _clamp(o, -CLAMP, CLAMP)
    return _clamp(50 + (c / CLAMP) * 50, 2, 98)


# --------------------------- Upside Trend composite -----------------------
UT_WEIGHTS = [
    ("ma200",     10),
    ("ma50",       8),
    ("pct200",    15),
    ("pct50",      8),
    ("sec_regime",10),
    ("junk",       7),
    ("sec_osc",    7),
    ("roc5",       8),
    ("roc10",      7),
    ("macd",      10),
    ("bb",        10),
]


def compute_upside_trend(scores: dict[str, float | None]) -> float | None:
    total, wsum = 0.0, 0
    for key, w in UT_WEIGHTS:
        s = scores.get(key)
        if s is None:
            continue
        total += s * w
        wsum += w
    return total / wsum if wsum else None


# --------------------------- main -----------------------------------------
def main() -> int:
    spx = load_date_close(os.path.join(DATA_DIR, "spx.csv"))
    pct200 = to_map(load_date_close(os.path.join(DATA_DIR, "pct_above_200ma.csv")))
    pct50 = to_map(load_date_close(os.path.join(DATA_DIR, "pct_above_50ma.csv")))
    hyg_rows = load_date_close(os.path.join(DATA_DIR, "hyg.csv"))
    lqd_rows = load_date_close(os.path.join(DATA_DIR, "lqd.csv"))
    hyg = to_map(hyg_rows); lqd = to_map(lqd_rows)
    # Sector regime CSV: Date,Spread,Score — col=1 is spread
    sec_regime = to_map(load_date_close(os.path.join(DATA_DIR, "sector_regime.csv"), col=1))
    # Sector oscillator CSV: date,advances,declines,ra_net,ema5,ema10,oscillator — col=6
    try:
        sec_osc = to_map(load_date_close(os.path.join(DATA_DIR, "sector_osc.csv"), col=6))
    except FileNotFoundError:
        sec_osc = {}

    spx_dates = [d for d, _ in spx]
    spx_close = [c for _, c in spx]
    spx_idx = {d: i for i, d in enumerate(spx_dates)}
    sma200_series = compute_sma(spx_close, 200)
    sma50_series = compute_sma(spx_close, 50)
    bb_series = compute_bollinger_pctb(spx_close, 20, 2)
    macd_series = compute_macd_hist_pct(spx_close, 12, 26, 9)

    # 20-day HYG-LQD spread (junk demand)
    hyg_dates = sorted(hyg)
    hyg_arr = [hyg[d] for d in hyg_dates]
    lqd_arr = [lqd.get(d) for d in hyg_dates]
    hyg_idx = {d: i for i, d in enumerate(hyg_dates)}

    def junk_at(d: str) -> float | None:
        i = hyg_idx.get(d)
        if i is None or i < 20: return None
        l0, l20 = lqd_arr[i], lqd_arr[i - 20]
        if l0 is None or l20 is None or l20 == 0: return None
        hy = (hyg_arr[i] / hyg_arr[i - 20] - 1) * 100
        lq = (l0 / l20 - 1) * 100
        return hy - lq

    scores: list[tuple[str, float]] = []
    for i, d in enumerate(spx_dates):
        if sma200_series[i] is None or sma50_series[i] is None: continue
        if bb_series[i] is None or macd_series[i] is None: continue
        ma200_dist = (spx_close[i] / sma200_series[i] - 1) * 100
        ma50_dist = (spx_close[i] / sma50_series[i] - 1) * 100
        roc5 = (spx_close[i] / spx_close[i-5] - 1) * 100 if i >= 5 else None
        roc10 = (spx_close[i] / spx_close[i-10] - 1) * 100 if i >= 10 else None
        p200 = pct200.get(d); p50 = pct50.get(d)
        sr = sec_regime.get(d); so = sec_osc.get(d)
        junk = junk_at(d)
        # Skip any day where a required input is missing so bucketed
        # stats are apples-to-apples.
        raw = {
            "ma200":      score_ma200(ma200_dist),
            "ma50":       score_ma50(ma50_dist),
            "pct200":     score_pct_above_ma(p200),
            "pct50":      score_pct_above_ma(p50),
            "sec_regime": score_sector_regime(sr),
            "junk":       score_junk_demand(junk),
            "sec_osc":    score_sector_osc(so),
            "roc5":       score_roc5(roc5),
            "roc10":      score_roc10(roc10),
            "macd":       score_macd_hist(macd_series[i]),
            "bb":         score_bollinger_b(bb_series[i]),
        }
        if any(v is None for v in raw.values()):
            continue
        score = compute_upside_trend(raw)
        if score is not None:
            scores.append((d, score))

    if not scores:
        print("No backtestable days"); return 1
    print(f"\nBacktest window: {scores[0][0]} to {scores[-1][0]}  --  {len(scores):,} trading days\n")

    HORIZONS = [5, 20, 60, 250]
    def fwd_return(d, days):
        i = spx_idx.get(d)
        if i is None: return None
        j = i + days
        return (spx_close[j] / spx_close[i] - 1) * 100 if j < len(spx_close) else None

    # --------- baseline ---------
    print("BASELINE (all backtested days):")
    print(f"  {'horizon':>8}  {'mean':>7}  {'hit%':>6}   n")
    for h in HORIZONS:
        rs = [r for r in (fwd_return(d, h) for d, _ in scores) if r is not None]
        if rs:
            hit = sum(1 for r in rs if r > 0) / len(rs) * 100
            print(f"  {h:>4}d    {mean(rs):>+6.1f}%  {hit:>5.1f}%   {len(rs):>4}")

    # --------- buckets ---------
    BUCKETS = [
        ("  0-20", 0, 20),
        (" 20-40", 20, 40),
        (" 40-60", 40, 60),
        (" 60-80", 60, 80),
        (" 80-100", 80, 101),
    ]
    print("\nBY UPSIDE TREND SCORE BUCKET:")
    for h in HORIZONS:
        print(f"\n  Forward horizon: {h}d")
        print(f"  {'bucket':>8}  {'mean':>7}  {'hit%':>6}   n")
        for tag, lo, hi in BUCKETS:
            rs = []
            for d, s in scores:
                if lo <= s < hi:
                    r = fwd_return(d, h)
                    if r is not None: rs.append(r)
            if not rs:
                print(f"  {tag}    {'--':>7}   {'--':>6}   0"); continue
            hit = sum(1 for r in rs if r > 0) / len(rs) * 100
            print(f"  {tag}   {mean(rs):>+6.1f}%  {hit:>5.1f}%   {len(rs):>4}")

    # --------- high fires ---------
    print("\n\nHIGH-CONVICTION (score >= 75):")
    high = [(d, s) for d, s in scores if s >= 75]
    print(f"  Total: {len(high):,} days ({len(high) / len(scores) * 100:.2f}% of history)")
    for h in HORIZONS:
        rs = [r for r in (fwd_return(d, h) for d, _ in high) if r is not None]
        if rs:
            hit = sum(1 for r in rs if r > 0) / len(rs) * 100
            print(f"    {h:>4}d forward:  mean {mean(rs):+.1f}%   hit {hit:.1f}%   n={len(rs)}")

    print("\n\nLOW-CONVICTION (score <= 30) — trend-broken days:")
    low = [(d, s) for d, s in scores if s <= 30]
    print(f"  Total: {len(low):,} days ({len(low) / len(scores) * 100:.2f}% of history)")
    for h in HORIZONS:
        rs = [r for r in (fwd_return(d, h) for d, _ in low) if r is not None]
        if rs:
            hit = sum(1 for r in rs if r > 0) / len(rs) * 100
            print(f"    {h:>4}d forward:  mean {mean(rs):+.1f}%   hit {hit:.1f}%   n={len(rs)}")

    # --------- top 10 highest ---------
    print("\n\nTOP 10 ALL-TIME HIGHEST SCORES:")
    print(f"  {'date':>12}  {'score':>6}   fwd 20d   fwd 60d   fwd 250d")
    for d, s in sorted(scores, key=lambda x: -x[1])[:10]:
        def fmt(v): return f"{v:+.1f}%" if v is not None else "   --"
        print(f"  {d:>12}  {s:>5.1f}   {fmt(fwd_return(d, 20)):>7}   {fmt(fwd_return(d, 60)):>7}   {fmt(fwd_return(d, 250)):>8}")

    # --------- bottom 10 lowest ---------
    print("\n\nBOTTOM 10 ALL-TIME LOWEST SCORES:")
    print(f"  {'date':>12}  {'score':>6}   fwd 20d   fwd 60d   fwd 250d")
    for d, s in sorted(scores, key=lambda x: x[1])[:10]:
        def fmt(v): return f"{v:+.1f}%" if v is not None else "   --"
        print(f"  {d:>12}  {s:>5.1f}   {fmt(fwd_return(d, 20)):>7}   {fmt(fwd_return(d, 60)):>7}   {fmt(fwd_return(d, 250)):>8}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
