#!/usr/bin/env python3
"""
Backtest the momentum-divergence and MACD-crossover readings shown on
divergences.html, to answer one question before any of it goes into a
gauge: when a bearish divergence is in force, does a top actually follow?

Rules are copied from divergences.html so the test matches the page:
  * swing highs/lows on closes (5 bars each side daily, 3 weekly)
  * bearish divergence = higher high in price (highest close since the
    earlier peak) with a lower high in RSI(14) or the MACD line; bullish
    is the mirror. Indicator extreme taken within +/-2 bars of the peak.
  * a divergence is "in force" from the bar its second peak is confirmed
    (peak + pivot bars) until price closes beyond that peak (cancelled),
    closes through the low/high between the peaks (played out), or maxGap
    bars pass (expired). No look-ahead: the state on day i only uses bars
    up to i.
  * MACD crossover signal = MACD(12,26,9) line crosses its signal after
    >= 10 closed bars on the other side; the signal is in place from the
    close of the cross bar.

For each condition we report, on the days it was true: the number of
days, mean forward return at 1m/3m/6m/12m with the % positive, the mean
worst drawdown over the next 3 and 6 months, and how often a >= 10%
drawdown arrived within 6 months. Everything is compared against the
same numbers for every trading day (baseline).

Read-only. Prints a report and writes data/divergence_backtest.json.
"""

from __future__ import annotations

import csv
import json
import os
import sys
from datetime import date, datetime

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR  = os.path.join(REPO_ROOT, "data")
OUT_PATH  = os.path.join(DATA_DIR, "divergence_backtest.json")

# Same parameters as TF in divergences.html
TF = {
    "1d":  {"pivot": 5, "minGap": 5, "maxGap": 60, "recent": 10},
    "1wk": {"pivot": 3, "minGap": 3, "maxGap": 52, "recent": 6},
}
MACD_MIN_RUN = 10
HORIZONS = [("1m", 21), ("3m", 63), ("6m", 126), ("12m", 252)]


# ---------------------------------------------------------------- data
def load_close(name: str) -> tuple[list[date], list[float]]:
    dates, closes = [], []
    with open(os.path.join(DATA_DIR, name + ".csv"), newline="", encoding="utf-8") as f:
        r = csv.reader(f)
        next(r, None)
        for row in r:
            try:
                d = datetime.strptime(row[0], "%Y-%m-%d").date()
                v = float(row[1])
            except (ValueError, IndexError):
                continue
            dates.append(d)
            closes.append(v)
    return dates, closes


# ---------------------------------------------------------- indicators
def ema(v, n):
    out = [None] * len(v)
    if len(v) < n:
        return out
    e = sum(v[:n]) / n
    out[n - 1] = e
    k = 2.0 / (n + 1)
    for i in range(n, len(v)):
        e = v[i] * k + e * (1 - k)
        out[i] = e
    return out


def rsi(v, period=14):
    out = [None] * len(v)
    if len(v) <= period:
        return out
    gain = loss = 0.0
    for i in range(1, period + 1):
        d = v[i] - v[i - 1]
        if d >= 0: gain += d
        else:      loss -= d
    gain /= period; loss /= period
    out[period] = 100.0 if loss == 0 else 100 - 100 / (1 + gain / loss)
    for i in range(period + 1, len(v)):
        d = v[i] - v[i - 1]
        gain = (gain * (period - 1) + (d if d > 0 else 0)) / period
        loss = (loss * (period - 1) + (-d if d < 0 else 0)) / period
        out[i] = 100.0 if loss == 0 else 100 - 100 / (1 + gain / loss)
    return out


def macd(v, fast=12, slow=26, sig=9):
    ef, es = ema(v, fast), ema(v, slow)
    line = [None if (a is None or b is None) else a - b for a, b in zip(ef, es)]
    signal = [None] * len(v)
    first = next((i for i, x in enumerate(line) if x is not None), -1)
    if first >= 0 and len(v) - first >= sig:
        s = sum(line[first:first + sig]) / sig
        signal[first + sig - 1] = s
        k = 2.0 / (sig + 1)
        for i in range(first + sig, len(v)):
            s = line[i] * k + s * (1 - k)
            signal[i] = s
    return line, signal


# ------------------------------------------------- divergence detection
def find_pivots(c, n):
    highs, lows = [], []
    for i in range(n, len(c) - n):
        is_h = is_l = True
        for k in range(i - n, i + n + 1):
            if k == i:
                continue
            if c[k] >= c[i]: is_h = False
            if c[k] <= c[i]: is_l = False
            if not is_h and not is_l:
                break
        if is_h: highs.append(i)
        if is_l: lows.append(i)
    return highs, lows


def ind_extreme(ind, i, want_high, tol=2):
    best = None
    for k in range(max(0, i - tol), min(len(ind) - 1, i + tol) + 1):
        x = ind[k]
        if x is None:
            continue
        if best is None or (x > best if want_high else x < best):
            best = x
    return best


def prior_pivot(c, piv_set, b, want_high, t):
    a, best = -1, None
    k = b - 1
    while k >= 0 and b - k <= t["maxGap"]:
        if (c[k] >= c[b]) if want_high else (c[k] <= c[b]):
            break
        if b - k >= t["minGap"] and k in piv_set:
            if best is None or ((c[k] > best) if want_high else (c[k] < best)):
                best, a = c[k], k
        k -= 1
    return a


def detect(c, ind, pivots, t):
    """Return list of dicts: kind, a, b, level, confirmAt, endAt, endHow."""
    n = t["pivot"]
    out = []
    for lst, want_high, kind in ((pivots[0], True, "bearish"), (pivots[1], False, "bullish")):
        s = set(lst)
        for b in lst:
            a = prior_pivot(c, s, b, want_high, t)
            if a < 0:
                continue
            ea, eb = ind_extreme(ind, a, want_high), ind_extreme(ind, b, want_high)
            if ea is None or eb is None:
                continue
            if not ((eb < ea) if want_high else (eb > ea)):
                continue
            between = c[a:b + 1]
            level = min(between) if kind == "bearish" else max(between)
            end_at, how = None, None
            for i in range(b + 1, len(c)):
                if kind == "bearish":
                    if c[i] > c[b]:    end_at, how = i, "cancelled"; break
                    if c[i] < level:   end_at, how = i, "played out"; break
                else:
                    if c[i] < c[b]:    end_at, how = i, "cancelled"; break
                    if c[i] > level:   end_at, how = i, "played out"; break
            out.append({"kind": kind, "a": a, "b": b, "level": level,
                        "confirmAt": b + n, "endAt": end_at, "endHow": how,
                        "expireAt": b + t["maxGap"]})
    return out


def state_series(divs, n_bars, t):
    """Per bar: set of kinds in force, plus 'playing out' flags (fresh breaks)."""
    bear = [False] * n_bars
    bull = [False] * n_bars
    bear_play = [False] * n_bars   # played out within the last `recent` bars
    bull_play = [False] * n_bars
    for d in divs:
        start = d["confirmAt"]
        stop = min(d["expireAt"], d["endAt"] if d["endAt"] is not None else n_bars - 1)
        arr = bear if d["kind"] == "bearish" else bull
        for i in range(start, min(stop, n_bars - 1) + 1):
            if d["endAt"] is not None and i >= d["endAt"]:
                break
            arr[i] = True
        if d["endHow"] == "played out" and d["endAt"] is not None:
            parr = bear_play if d["kind"] == "bearish" else bull_play
            for i in range(d["endAt"], min(d["endAt"] + t["recent"], n_bars - 1) + 1):
                parr[i] = True
    return bear, bull, bear_play, bull_play


def macd_signal_state(line, signal):
    """Per bar: +1 after a confirmed buy, -1 after a sell, 0 before any signal."""
    n = len(line)
    state = [0] * n
    side, run, cur = None, 0, 0
    for i in range(n):
        if line[i] is None or signal[i] is None:
            state[i] = cur
            continue
        s = "above" if line[i] > signal[i] else "below" if line[i] < signal[i] else side
        if s is None:
            state[i] = cur
            continue
        if side is not None and s != side:
            if run >= MACD_MIN_RUN:
                cur = 1 if s == "above" else -1
            side, run = s, 1
        else:
            side, run = s, run + 1
        state[i] = cur
    return state


# ------------------------------------------------------------- engine
class Index:
    def __init__(self, name):
        self.name = name
        self.dates, self.c = load_close(name)
        n = len(self.c)
        # daily
        r, (ml, ms) = rsi(self.c), macd(self.c)
        piv = find_pivots(self.c, TF["1d"]["pivot"])
        divs = detect(self.c, r, piv, TF["1d"]) + detect(self.c, ml, piv, TF["1d"])
        self.d_bear, self.d_bull, self.d_bear_play, self.d_bull_play = state_series(divs, n, TF["1d"])
        self.d_divs = divs
        self.d_macd = macd_signal_state(ml, ms)
        # weekly: last trading day of each ISO week
        self.wk_end = [i for i in range(n) if i == n - 1 or self.dates[i + 1].isocalendar()[:2] != self.dates[i].isocalendar()[:2]]
        wc = [self.c[i] for i in self.wk_end]
        wr, (wml, wms) = rsi(wc), macd(wc)
        wpiv = find_pivots(wc, TF["1wk"]["pivot"])
        wdivs = detect(wc, wr, wpiv, TF["1wk"]) + detect(wc, wml, wpiv, TF["1wk"])
        wb, wbu, wbp, wbup = state_series(wdivs, len(wc), TF["1wk"])
        wm = macd_signal_state(wml, wms)
        # map to daily: state of the last COMPLETED week as of day i
        self.w_bear = [False] * n; self.w_bull = [False] * n
        self.w_bear_play = [False] * n; self.w_macd = [0] * n
        k = -1
        wk_set = {i: pos for pos, i in enumerate(self.wk_end)}
        for i in range(n):
            if i in wk_set:
                k = wk_set[i]
            if k >= 0:
                self.w_bear[i], self.w_bull[i] = wb[k], wbu[k]
                self.w_bear_play[i] = wbp[k]
                self.w_macd[i] = wm[k]
        self.w_divs = wdivs


def fwd_stats(c, idxs):
    n = len(c)
    # episodes = contiguous runs of qualifying days, so a 300-day sample
    # that is really five stretches reads as five, not three hundred.
    episodes = sum(1 for k, i in enumerate(idxs) if k == 0 or i != idxs[k - 1] + 1)
    row = {"days": len(idxs), "episodes": episodes}
    for label, h in HORIZONS:
        rets = [c[i + h] / c[i] - 1 for i in idxs if i + h < n]
        row[label] = round(sum(rets) / len(rets), 4) if rets else None
        row[label + "_hit"] = round(sum(1 for r in rets if r > 0) / len(rets), 3) if rets else None
    for label, h in (("dd3m", 63), ("dd6m", 126)):
        dds = []
        for i in idxs:
            if i + h >= n:
                continue
            lo = min(c[i + 1:i + h + 1])
            dds.append(lo / c[i] - 1)
        row[label] = round(sum(dds) / len(dds), 4) if dds else None
        if label == "dd6m":
            row["p_dd10_6m"] = round(sum(1 for d in dds if d <= -0.10) / len(dds), 3) if dds else None
    return row


def fmt_row(label, r):
    def p(v): return "   —  " if v is None else f"{v*100:6.1f}%"
    def h(v): return "  —" if v is None else f"{int(round(v*100)):3d}"
    return (f"  {label:42s} {r['days']:6d} {r['episodes']:4d}  "
            f"{p(r['1m'])} {h(r['1m_hit'])} | {p(r['3m'])} {h(r['3m_hit'])} | "
            f"{p(r['6m'])} {h(r['6m_hit'])} | {p(r['12m'])} {h(r['12m_hit'])} | "
            f"{p(r['dd3m'])} {p(r['dd6m'])} {h(r['p_dd10_6m'])}")


def main() -> int:
    spx, ndx = Index("spx"), Index("ndx")
    assert spx.dates == ndx.dates, "spx.csv and ndx.csv must share the same trading days"
    n = len(spx.c)
    # skip the warm-up year so weekly MACD/RSI exist
    days = list(range(300, n))

    def count_bear(i):
        return sum([spx.d_bear[i], spx.w_bear[i], ndx.d_bear[i], ndx.w_bear[i]])

    conds = [
        ("Baseline (any day)",                        lambda i: True),
        ("SPX daily bearish in force",                lambda i: spx.d_bear[i]),
        ("SPX weekly bearish in force",               lambda i: spx.w_bear[i]),
        ("SPX daily AND weekly bearish",              lambda i: spx.d_bear[i] and spx.w_bear[i]),
        ("NDX baseline (any day)",                    lambda i: True),
        ("NDX daily bearish in force",                lambda i: ndx.d_bear[i]),
        ("NDX weekly bearish in force",               lambda i: ndx.w_bear[i]),
        ("NDX daily AND weekly bearish",              lambda i: ndx.d_bear[i] and ndx.w_bear[i]),
        ("SPX AND NDX weekly bearish",                lambda i: spx.w_bear[i] and ndx.w_bear[i]),
        ("Bearish readings = 0 of 4",                 lambda i: count_bear(i) == 0),
        ("Bearish readings = 1 of 4",                 lambda i: count_bear(i) == 1),
        ("Bearish readings = 2 of 4",                 lambda i: count_bear(i) == 2),
        ("Bearish readings >= 3 of 4",                lambda i: count_bear(i) >= 3),
        ("SPX d+w bearish + daily MACD sell",         lambda i: spx.d_bear[i] and spx.w_bear[i] and spx.d_macd[i] == -1),
        ("SPX weekly bearish + weekly MACD sell",     lambda i: spx.w_bear[i] and spx.w_macd[i] == -1),
        ("SPX daily bearish PLAYING OUT (fresh break)", lambda i: spx.d_bear_play[i]),
        ("SPX weekly bearish PLAYING OUT",            lambda i: spx.w_bear_play[i]),
        ("Weekly MACD sell in place (no divergence needed)", lambda i: spx.w_macd[i] == -1),
        ("Weekly MACD buy in place",                  lambda i: spx.w_macd[i] == 1),
        ("SPX daily bullish in force",                lambda i: spx.d_bull[i]),
        ("SPX weekly bullish in force",               lambda i: spx.w_bull[i]),
        ("SPX daily AND weekly bullish",              lambda i: spx.d_bull[i] and spx.w_bull[i]),
    ]

    print(f"Window {spx.dates[days[0]]} to {spx.dates[-1]}  ({len(days)} trading days)")
    print(f"SPX daily divergences found: {len(spx.d_divs)}  weekly: {len(spx.w_divs)}   "
          f"NDX daily: {len(ndx.d_divs)}  weekly: {len(ndx.w_divs)}")
    print()
    print("Forward returns are on the S&P 500 (NDX rows on the Nasdaq 100). Columns: mean return and % positive at")
    print("1m / 3m / 6m / 12m, then mean worst drawdown over the next 3m and 6m, and % of cases with a >=10% drawdown within 6m.")
    print()
    print(f"  {'condition':42s} {'days':>6s} {'eps':>4s}  {'1m':>6s} {'hit':>3s} | {'3m':>6s} {'hit':>3s} | {'6m':>6s} {'hit':>3s} | {'12m':>6s} {'hit':>3s} | {'dd3m':>6s} {'dd6m':>6s} {'>10%':>3s}")
    results = []
    for label, fn in conds:
        series = ndx.c if label.startswith("NDX") else spx.c
        idxs = [i for i in days if fn(i)]
        r = fwd_stats(series, idxs)
        r["condition"] = label
        results.append(r)
        print(fmt_row(label, r))

    # Every weekly S&P bearish divergence, so the reader can eyeball the big tops.
    print("\nS&P weekly bearish divergences (confirmed, one line per peak), with how they ended:")
    seen = set()
    n_play = n_cancel = 0
    for d in sorted(spx.w_divs, key=lambda x: x["b"]):
        if d["kind"] != "bearish" or d["b"] in seen:
            continue
        seen.add(d["b"])
        b_date = spx.dates[spx.wk_end[d["b"]]]
        end = spx.dates[spx.wk_end[d["endAt"]]] if d["endAt"] is not None and d["endAt"] < len(spx.wk_end) else None
        if d["endHow"] == "played out": n_play += 1
        elif d["endHow"] == "cancelled": n_cancel += 1
        print(f"  peak {b_date}  {d['endHow'] or 'open':10s} {end or ''}")
    print(f"  -> {len(seen)} peaks: {n_play} played out, {n_cancel} cancelled, {len(seen) - n_play - n_cancel} open/expired")

    payload = {
        "generatedAt": int(datetime.now().timestamp()),
        "windowStart": spx.dates[days[0]].isoformat(),
        "windowEnd": spx.dates[-1].isoformat(),
        "tradingDays": len(days),
        "results": results,
    }
    with open(OUT_PATH, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"\nWrote {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
