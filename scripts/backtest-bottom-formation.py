#!/usr/bin/env python3
"""
Backtest the Bottom Formation composite (see computeBottomFormation in
app.js).

For each historical date where every input exists, compute the Bottom
Formation score (0-100), then measure SPX forward returns at 5d / 20d /
60d / 250d horizons. Bucket by score and tabulate mean return + hit-rate
+ count so we can see whether high scores actually preceded better
returns than baseline.

Also prints the top-10 highest historical readings with their forward
returns — sanity check that the signal fires at real bottoms (GFC,
March 2009, Aug 2011, COVID, Apr 2025) rather than at random times.

Data window is bounded by the shortest input series (HYG launched
2007-04-04), so the backtest covers ~2007-05 to today. That still
includes all the major bear-market bottoms since HYG existed.

Weights are pinned to the values in app.js:
  RSI  30   Pct>200MA  20   SPX-below-200  12
  VIX  18   ROC-5      12   HYG-LQD spread  8

Read-only script — writes nothing. Just prints a report.
"""
from __future__ import annotations
import csv
import os
from statistics import mean

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
DATA_DIR = os.path.join(REPO_ROOT, 'data')


# --------------------------- data loading ---------------------------------
def load_date_close(path: str, close_col: int = 1) -> list[tuple[str, float]]:
    """Parse Date,Close CSVs. Returns [(date, value), ...] in file order."""
    rows: list[tuple[str, float]] = []
    with open(path, encoding='utf-8') as f:
        r = csv.reader(f)
        next(r, None)  # header
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


# --------------------------- indicators -----------------------------------
def compute_rsi_wilder(closes: list[float], period: int = 14) -> list[float | None]:
    """Standard Wilder RSI series aligned with closes."""
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


# --------------------------- Bottom Formation score -----------------------
# Ramps mirror computeBottomFormation() in app.js — keep in sync when weights
# or thresholds change over there.
def clamp01_100(x: float) -> float:
    return max(0.0, min(100.0, x))


def bf_rsi(rsi: float | None) -> float | None:
    if rsi is None:
        return None
    if rsi >= 50:
        return 0.0
    if rsi >= 40:
        return (50 - rsi) * 2                          # 50->0, 40->20
    if rsi >= 20:
        return 20 + (40 - rsi) * 4                     # 40->20, 20->100
    return 100.0


def bf_pct_above_200(pct: float | None) -> float | None:
    if pct is None:
        return None
    return clamp01_100((30 - pct) * 4)                 # 30->0, 5->100


def bf_ma200_dist(dist: float | None) -> float | None:
    if dist is None:
        return None
    return clamp01_100(-dist * 10)                     # 0->0, -10%->100


def bf_vix(vix: float | None) -> float | None:
    if vix is None:
        return None
    return clamp01_100((vix - 20) * 5)                 # 20->0, 40->100


def bf_roc5(roc5: float | None) -> float | None:
    if roc5 is None:
        return None
    return clamp01_100((-roc5 - 3) * (100 / 7))        # -3%->0, -10%->100


def bf_junk(spread: float | None) -> float | None:
    if spread is None:
        return None
    return clamp01_100((-spread - 1) * 25)             # -1%->0, -5%->100


BF_WEIGHTS: list[tuple[str, int, callable]] = [
    ('rsi',    30, bf_rsi),
    ('pct200', 20, bf_pct_above_200),
    ('spx200', 12, bf_ma200_dist),
    ('vix',    18, bf_vix),
    ('roc5',   12, bf_roc5),
    ('junk',    8, bf_junk),
]


def compute_bottom_formation(inputs: dict) -> float | None:
    total, wsum = 0.0, 0
    for key, w, fn in BF_WEIGHTS:
        s = fn(inputs.get(key))
        if s is None:
            continue
        total += s * w
        wsum += w
    return total / wsum if wsum else None


# --------------------------- backtest driver ------------------------------
def main() -> int:
    vix = to_map(load_date_close(os.path.join(DATA_DIR, 'vix.csv')))
    spx_rows = load_date_close(os.path.join(DATA_DIR, 'spx.csv'))
    spy_rows = load_date_close(os.path.join(DATA_DIR, 'spy.csv'))
    hyg = to_map(load_date_close(os.path.join(DATA_DIR, 'hyg.csv')))
    lqd = to_map(load_date_close(os.path.join(DATA_DIR, 'lqd.csv')))
    pct_above = to_map(load_date_close(os.path.join(DATA_DIR, 'pct_above_200ma.csv')))

    spx_dates = [d for d, _ in spx_rows]
    spx_close = [c for _, c in spx_rows]
    spx_idx = {d: i for i, d in enumerate(spx_dates)}
    sma200 = compute_sma(spx_close, 200)

    spy_dates = [d for d, _ in spy_rows]
    spy_close = [c for _, c in spy_rows]
    rsi_series = compute_rsi_wilder(spy_close, 14)
    spy_idx = {d: i for i, d in enumerate(spy_dates)}

    hyg_dates = sorted(hyg.keys())
    hyg_idx = {d: i for i, d in enumerate(hyg_dates)}
    hyg_arr = [hyg[d] for d in hyg_dates]
    lqd_arr = [lqd.get(d) for d in hyg_dates]

    def spx_roc5(i: int) -> float | None:
        return (spx_close[i] / spx_close[i - 5] - 1) * 100 if i >= 5 else None

    def junk_spread(d: str) -> float | None:
        i = hyg_idx.get(d)
        if i is None or i < 20:
            return None
        l0, l20 = lqd_arr[i], lqd_arr[i - 20]
        if l0 is None or l20 is None or l20 == 0:
            return None
        return (hyg_arr[i] / hyg_arr[i - 20] - 1) * 100 - (l0 / l20 - 1) * 100

    scores: list[tuple[str, float]] = []
    for i, d in enumerate(spx_dates):
        s200 = sma200[i]
        if s200 is None:
            continue
        ma_dist = (spx_close[i] / s200 - 1) * 100
        rsi_v = rsi_series[spy_idx[d]] if d in spy_idx else None
        vix_v = vix.get(d)
        pct_v = pct_above.get(d)
        junk_v = junk_spread(d)
        # Strict: skip if ANY input missing so buckets are apples-to-apples.
        if vix_v is None or rsi_v is None or pct_v is None or junk_v is None:
            continue
        score = compute_bottom_formation({
            'rsi': rsi_v, 'pct200': pct_v, 'spx200': ma_dist,
            'vix': vix_v, 'roc5': spx_roc5(i), 'junk': junk_v,
        })
        if score is not None:
            scores.append((d, score))

    if not scores:
        print('No backtestable days — data files may be truncated.')
        return 1

    print(f'\nBacktest window: {scores[0][0]} to {scores[-1][0]}  --  {len(scores):,} trading days\n')

    HORIZONS = [5, 20, 60, 250]

    def fwd_return(from_date: str, days: int) -> float | None:
        i = spx_idx.get(from_date)
        if i is None:
            return None
        j = i + days
        return (spx_close[j] / spx_close[i] - 1) * 100 if j < len(spx_close) else None

    # -------------- baseline (all days) --------------
    print('BASELINE (all backtested days):')
    print(f'  {"horizon":>8}  {"mean":>7}  {"hit%":>6}   n')
    for h in HORIZONS:
        rs = [r for r in (fwd_return(d, h) for d, _ in scores) if r is not None]
        if rs:
            hit = sum(1 for r in rs if r > 0) / len(rs) * 100
            print(f'  {h:>4}d    {mean(rs):>+6.1f}%  {hit:>5.1f}%   {len(rs):>4}')

    BUCKETS = [
        ('  0-20',   0, 20),
        (' 20-40',  20, 40),
        (' 40-60',  40, 60),
        (' 60-80',  60, 80),
        (' 80-100', 80, 101),
    ]

    print('\nBY BOTTOM FORMATION SCORE BUCKET:')
    for h in HORIZONS:
        print(f'\n  Forward horizon: {h}d')
        print(f'  {"bucket":>8}  {"mean":>7}  {"hit%":>6}   n')
        for tag, lo, hi in BUCKETS:
            rs: list[float] = []
            for d, s in scores:
                if lo <= s < hi:
                    r = fwd_return(d, h)
                    if r is not None:
                        rs.append(r)
            if not rs:
                print(f'  {tag}    {"--":>7}   {"--":>6}   0')
                continue
            hit = sum(1 for r in rs if r > 0) / len(rs) * 100
            print(f'  {tag}   {mean(rs):>+6.1f}%  {hit:>5.1f}%   {len(rs):>4}')

    print('\n\nHIGH-CONVICTION FIRES (score >= 70):')
    high = [(d, s) for d, s in scores if s >= 70]
    print(f'  Total: {len(high):,} days ({len(high) / len(scores) * 100:.2f}% of history)')
    for h in HORIZONS:
        rs = [r for r in (fwd_return(d, h) for d, _ in high) if r is not None]
        if rs:
            hit = sum(1 for r in rs if r > 0) / len(rs) * 100
            print(f'    {h:>4}d forward:  mean {mean(rs):+.1f}%   hit {hit:.1f}%   n={len(rs)}')

    print('\n\nTOP 10 ALL-TIME HIGHEST SCORES:')
    print(f'  {"date":>12}  {"score":>6}   fwd 20d   fwd 60d   fwd 250d')
    for d, s in sorted(scores, key=lambda x: -x[1])[:10]:
        def fmt(v):
            return f'{v:+.1f}%' if v is not None else '   --'
        print(f'  {d:>12}  {s:>5.1f}   {fmt(fwd_return(d, 20)):>7}   {fmt(fwd_return(d, 60)):>7}   {fmt(fwd_return(d, 250)):>8}')

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
