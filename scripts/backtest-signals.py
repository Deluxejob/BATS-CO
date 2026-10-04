#!/usr/bin/env python3
"""
Signal-testing backtest engine.

Takes the CNN Fear & Greed history (data/fear_greed.csv), the BATS
composite history (data/bats_history.json), and S&P 500 daily closes
(data/spx.csv) — merges them on trading days from 2011 onward — and
runs a batch of clearly-defined strategies to see whether either
indicator (alone or combined) improves on plain buy-and-hold.

Everything the backtest produces lands in data/signal_backtest.json
for the Signal Testing page to render. Reports honest metrics: CAGR,
max drawdown, Sharpe, hit rate, forward-return distributions by
bucket, entry/exit whipsaw counts, and time-in-market. Losing
strategies are kept in the output so the page can show them too.

Assumptions we make explicit here:
  * A strategy that is "invested" earns SPX total return that day.
  * A strategy that is "not invested" earns 0% (no cash yield). This
    makes the timing-vs-buy-and-hold comparison the honest one — we
    are not padding the timing strategy with T-bill returns.
  * Trades happen at close on the signal day (no execution lag).
  * No transaction costs. Frequent-flip strategies may look better
    here than they would after real costs; whipsaw count surfaces
    that in the output.
"""

from __future__ import annotations

import csv
import json
import math
import os
import sys
import time
from datetime import date, datetime

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FNG_PATH  = os.path.join(REPO_ROOT, "data", "fear_greed.csv")
BATS_PATH = os.path.join(REPO_ROOT, "data", "bats_history.json")
SPX_PATH  = os.path.join(REPO_ROOT, "data", "spx.csv")
OUT_PATH  = os.path.join(REPO_ROOT, "data", "signal_backtest.json")

START_DATE = date(2011, 1, 3)   # first day CNN F&G data exists

TRADING_DAYS = 252


# ---------- Data loading ----------

def parse_date(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def load_spx() -> dict[date, float]:
    out: dict[date, float] = {}
    with open(SPX_PATH, newline="") as f:
        r = csv.DictReader(f)
        for row in r:
            try:
                out[parse_date(row["Date"])] = float(row["Close"])
            except (KeyError, ValueError):
                continue
    return out


def load_fng() -> dict[date, float]:
    out: dict[date, float] = {}
    with open(FNG_PATH, newline="") as f:
        r = csv.DictReader(f)
        for row in r:
            try:
                out[parse_date(row["Date"])] = float(row["FearGreed"])
            except (KeyError, ValueError):
                continue
    return out


def load_bats() -> dict[date, float]:
    with open(BATS_PATH) as f:
        j = json.load(f)
    out: dict[date, float] = {}
    for entry in j.get("history", []):
        try:
            d, v = entry[0], entry[1]
            out[parse_date(d)] = float(v)
        except (KeyError, ValueError, TypeError):
            continue
    return out


# ---------- Series prep ----------

class Series:
    """Aligned daily series over the shared trading days from START_DATE."""

    def __init__(self, dates: list[date], spx: list[float], fng: list[float],
                 bats: list[float]):
        self.dates = dates
        self.spx = spx
        self.fng = fng
        self.bats = bats
        n = len(dates)
        # Daily SPX return, index i = return from close[i-1] to close[i].
        # Position 0 is 0 by construction.
        self.ret = [0.0] * n
        for i in range(1, n):
            prev = spx[i - 1]
            cur  = spx[i]
            self.ret[i] = (cur / prev) - 1.0 if prev > 0 else 0.0
        # SPX 200-day and 50-day SMAs for trend-filter strategies.
        self.ma200 = _rolling_mean(spx, 200)
        self.ma50  = _rolling_mean(spx, 50)
        # Daily MACD (12, 26, 9) on SPX closes — same maths as divergences.html.
        self.macd_line, self.macd_signal = _macd(spx)
        # Weekly closes = last trading day of each ISO week. Weekly MACD is
        # computed on those and mapped back to the daily index so the
        # daily runner can evaluate a weekly rule at each Friday close.
        self.week_end_idx: list[int] = []
        for i in range(n):
            last_of_week = (i == n - 1) or (dates[i + 1].isocalendar()[:2] != dates[i].isocalendar()[:2])
            if last_of_week:
                self.week_end_idx.append(i)
        wk_closes = [spx[i] for i in self.week_end_idx]
        self.wk_macd_line, self.wk_macd_signal = _macd(wk_closes)
        # daily index -> position in the weekly arrays (only for week-end days)
        self.week_pos: dict[int, int] = {i: k for k, i in enumerate(self.week_end_idx)}


def _ema(xs: list[float], n: int) -> list[float | None]:
    out: list[float | None] = [None] * len(xs)
    if len(xs) < n:
        return out
    e = sum(xs[:n]) / n
    out[n - 1] = e
    k = 2.0 / (n + 1)
    for i in range(n, len(xs)):
        e = xs[i] * k + e * (1 - k)
        out[i] = e
    return out


def _macd(xs: list[float], fast: int = 12, slow: int = 26, sig: int = 9):
    """Standard MACD: line = EMA(fast) - EMA(slow); signal = EMA(sig) of line."""
    ef, es = _ema(xs, fast), _ema(xs, slow)
    line: list[float | None] = [None] * len(xs)
    for i in range(len(xs)):
        if ef[i] is not None and es[i] is not None:
            line[i] = ef[i] - es[i]
    signal: list[float | None] = [None] * len(xs)
    first = next((i for i, v in enumerate(line) if v is not None), -1)
    if first >= 0 and len(xs) - first >= sig:
        s = sum(line[first:first + sig]) / sig
        signal[first + sig - 1] = s
        k = 2.0 / (sig + 1)
        for i in range(first + sig, len(xs)):
            s = line[i] * k + s * (1 - k)
            signal[i] = s
    return line, signal


def _rolling_mean(xs: list[float], n: int) -> list[float | None]:
    out: list[float | None] = [None] * len(xs)
    if len(xs) < n:
        return out
    s = sum(xs[:n])
    out[n - 1] = s / n
    for i in range(n, len(xs)):
        s += xs[i] - xs[i - n]
        out[i] = s / n
    return out


def build_series() -> Series:
    spx  = load_spx()
    fng  = load_fng()
    bats = load_bats()

    common = sorted(set(spx) & set(fng) & set(bats) & {d for d in spx if d >= START_DATE})
    dates: list[date] = []
    xspx:  list[float] = []
    xfng:  list[float] = []
    xbats: list[float] = []
    for d in common:
        dates.append(d)
        xspx.append(spx[d])
        xfng.append(fng[d])
        xbats.append(bats[d])
    print(f"Aligned {len(dates)} trading days from {dates[0]} to {dates[-1]}")
    print(f"  SPX-only days   : {len(spx) - len(common)}")
    print(f"  FNG-only days   : {len(fng) - len(common)}")
    print(f"  BATS-only days  : {len(bats) - len(common)}")
    return Series(dates, xspx, xfng, xbats)


# ---------- Strategy rules ----------
# Each strategy is a function `invested(series, i) -> bool` computing
# whether the strategy is invested at the CLOSE of day i, using only
# info available at that close. Rules with hysteresis carry state via
# a stateful closure.

def make_hysteresis(low: float, high: float, feed_ix: str):
    """Buy when signal drops to `low`, sell when signal rises past `high`.

    feed_ix: 'fng' or 'bats' — which series drives the rule.

    Returns a closure with internal `invested` state. Fresh instance
    per backtest run.
    """
    state = {"invested": False}

    def rule(s: Series, i: int) -> bool:
        feed = s.fng[i] if feed_ix == "fng" else s.bats[i]
        if not state["invested"] and feed <= low:
            state["invested"] = True
        elif state["invested"] and feed >= high:
            state["invested"] = False
        return state["invested"]

    return rule


def make_hysteresis_with_trend(low: float, high: float, feed_ix: str,
                               require_above_ma: bool = True):
    """Same as hysteresis but only enters when SPX > 200-day MA (trend filter)."""
    state = {"invested": False}

    def rule(s: Series, i: int) -> bool:
        feed = s.fng[i] if feed_ix == "fng" else s.bats[i]
        ma = s.ma200[i]
        trend_ok = (ma is not None) and (s.spx[i] > ma) if require_above_ma else True
        if not state["invested"] and feed <= low and trend_ok:
            state["invested"] = True
        elif state["invested"] and (feed >= high or not trend_ok):
            state["invested"] = False
        return state["invested"]

    return rule


def make_combined_and(low_fng: float, low_bats: float,
                      high_fng: float, high_bats: float):
    """Invested only when BOTH CNN <= low_fng AND BATS <= low_bats;
    exits when either rises above its high threshold."""
    state = {"invested": False}

    def rule(s: Series, i: int) -> bool:
        f, b = s.fng[i], s.bats[i]
        if not state["invested"] and f <= low_fng and b <= low_bats:
            state["invested"] = True
        elif state["invested"] and (f >= high_fng or b >= high_bats):
            state["invested"] = False
        return state["invested"]

    return rule


def make_combined_or(low_fng: float, low_bats: float,
                     high_fng: float, high_bats: float):
    """Invested when EITHER CNN <= low_fng OR BATS <= low_bats;
    exits only when BOTH rise above their high thresholds."""
    state = {"invested": False}

    def rule(s: Series, i: int) -> bool:
        f, b = s.fng[i], s.bats[i]
        if not state["invested"] and (f <= low_fng or b <= low_bats):
            state["invested"] = True
        elif state["invested"] and f >= high_fng and b >= high_bats:
            state["invested"] = False
        return state["invested"]

    return rule


def make_macd_cross(min_run: int, weekly: bool = False, require_trend: bool = False):
    """MACD crossover rule, matching the signals on divergences.html.

    Buy when the MACD line crosses above its signal line after at least
    `min_run` closed bars below it; sell on the mirror-image cross after
    at least `min_run` bars above. Crosses that come sooner are ignored
    (the side counter still resets). The cross is known at the close of
    the bar it happens on, so the position changes at that close and
    earns from the next bar — the same information as acting at the
    next bar's open, which is how the page stamps the signal.

    weekly=True runs the rule on weekly closes; the decision is taken at
    the last trading day of each week and held through the next week.
    require_trend=True only allows a buy when SPX > 200-day MA and also
    exits on a trend break.
    """
    state = {"invested": False, "side": None, "run": 0}

    def rule(s: Series, i: int) -> bool:
        if weekly:
            k = s.week_pos.get(i)
            if k is None:
                return state["invested"]          # mid-week: hold whatever we had
            line, sig = s.wk_macd_line[k], s.wk_macd_signal[k]
        else:
            line, sig = s.macd_line[i], s.macd_signal[i]
        if line is None or sig is None:
            return state["invested"]
        side = "above" if line > sig else "below" if line < sig else state["side"]
        if side is None:
            return state["invested"]
        crossed = state["side"] is not None and side != state["side"]
        if crossed:
            if state["run"] >= min_run:
                if side == "above":
                    if not require_trend or (s.ma200[i] is not None and s.spx[i] > s.ma200[i]):
                        state["invested"] = True
                else:
                    state["invested"] = False
            state["side"], state["run"] = side, 1
        else:
            state["side"], state["run"] = side, state["run"] + 1
        if require_trend and state["invested"] and s.ma200[i] is not None and s.spx[i] < s.ma200[i]:
            state["invested"] = False
        return state["invested"]

    return rule


def make_avoid_hot(high: float, back: float, feed_ix: str):
    """The sell-side test: stay invested by default, step aside when the
    gauge runs hot (>= high), and buy back once it has cooled (<= back)."""
    state = {"invested": True}

    def rule(s: Series, i: int) -> bool:
        feed = s.fng[i] if feed_ix == "fng" else s.bats[i]
        if state["invested"] and feed >= high:
            state["invested"] = False
        elif not state["invested"] and feed <= back:
            state["invested"] = True
        return state["invested"]

    return rule


def bull_market_only(s: Series, i: int) -> bool:
    """Simple regime filter: invested when SPX > 200-day MA, else out."""
    ma = s.ma200[i]
    return (ma is not None) and (s.spx[i] > ma)


def always_invested(s: Series, i: int) -> bool:
    return True


# ---------- Backtest runner ----------

def run_strategy(name: str, description: str, rule, s: Series) -> dict:
    """Apply `rule` day by day, walk equity, compute all metrics."""
    n = len(s.dates)
    equity = [1.0] * n
    invested_flags = [False] * n
    entries = 0     # count of "flat -> invested" transitions
    prev_invested = False

    for i in range(n):
        invested = rule(s, i)
        invested_flags[i] = invested
        # Daily equity update: if we HELD from close i-1 to close i,
        # we earn ret[i]. Position taken at close of the trigger day
        # earns starting the NEXT day, matching how a real trade works.
        if i == 0:
            equity[i] = 1.0
        else:
            step = 1.0 + (s.ret[i] if invested_flags[i - 1] else 0.0)
            equity[i] = equity[i - 1] * step
        if invested and not prev_invested:
            entries += 1
        prev_invested = invested

    days_in_market = sum(1 for f in invested_flags if f)
    pct_in_market  = days_in_market / n if n else 0.0

    # Round-trip trade log: entry at the close of the day the rule turns
    # on, exit at the close of the day it turns off. A position still
    # open at the end is closed at the final bar and flagged.
    trades: list[dict] = []
    entry_i = None
    for i in range(n):
        if invested_flags[i] and entry_i is None:
            entry_i = i
        elif not invested_flags[i] and entry_i is not None:
            trades.append(_trade(s, entry_i, i, False))
            entry_i = None
    if entry_i is not None:
        trades.append(_trade(s, entry_i, n - 1, True))
    closed = [t for t in trades if not t["open"]]
    rets = [t["ret"] for t in trades]
    trade_stats = {
        "trades": len(trades),
        "winRate": round(sum(1 for r in rets if r > 0) / len(rets), 3) if rets else None,
        "avgTrade": round(sum(rets) / len(rets), 4) if rets else None,
        "medianTrade": round(sorted(rets)[len(rets) // 2], 4) if rets else None,
        "bestTrade": round(max(rets), 4) if rets else None,
        "worstTrade": round(min(rets), 4) if rets else None,
        "avgHoldDays": round(sum(t["days"] for t in closed) / len(closed), 1) if closed else None,
        "tradeLog": trades[-12:],
    }

    total_return = equity[-1] - 1.0
    years = (s.dates[-1] - s.dates[0]).days / 365.25
    cagr = (equity[-1] ** (1.0 / years)) - 1.0 if years > 0 else 0.0
    # The same growth, but counted only over the time the rule was actually
    # in stocks. This is the fair way to compare two rules that spend very
    # different amounts of time in cash. Needs at least half a year invested
    # to mean anything.
    invested_years = years * pct_in_market
    invested_cagr = (equity[-1] ** (1.0 / invested_years)) - 1.0 if invested_years >= 0.5 and equity[-1] > 0 else None

    # Max drawdown on the equity curve
    peak = equity[0]
    max_dd = 0.0
    for v in equity:
        if v > peak:
            peak = v
        dd = (v / peak) - 1.0
        if dd < max_dd:
            max_dd = dd

    # Daily returns from the strategy (0 on flat days)
    strat_ret = [0.0] * n
    for i in range(1, n):
        strat_ret[i] = s.ret[i] if invested_flags[i - 1] else 0.0
    mean_daily = sum(strat_ret) / n if n else 0.0
    var_daily  = sum((r - mean_daily) ** 2 for r in strat_ret) / n if n else 0.0
    sd_daily   = math.sqrt(var_daily)
    sharpe = (mean_daily * TRADING_DAYS) / (sd_daily * math.sqrt(TRADING_DAYS)) if sd_daily > 0 else 0.0

    # Sample equity curve for the chart — one point per week is plenty.
    sampled = [{"d": s.dates[i].isoformat(), "e": round(equity[i], 5)}
               for i in range(0, n, 5)]
    # Always include the final point.
    if sampled and sampled[-1]["d"] != s.dates[-1].isoformat():
        sampled.append({"d": s.dates[-1].isoformat(), "e": round(equity[-1], 5)})

    return {
        "name": name,
        "description": description,
        "totalReturn": round(total_return, 4),
        "cagr": round(cagr, 5),
        "investedCagr": round(invested_cagr, 5) if invested_cagr is not None else None,
        "maxDrawdown": round(max_dd, 4),
        "sharpe": round(sharpe, 3),
        "pctInMarket": round(pct_in_market, 4),
        "entries": entries,
        "equityFinal": round(equity[-1], 4),
        "equityCurve": sampled,
        **trade_stats,
    }


def _trade(s: Series, a: int, b: int, still_open: bool) -> dict:
    return {
        "entry": s.dates[a].isoformat(),
        "exit":  s.dates[b].isoformat(),
        "entryPx": round(s.spx[a], 2),
        "exitPx":  round(s.spx[b], 2),
        "ret": round(s.spx[b] / s.spx[a] - 1.0, 4),
        "days": b - a,
        "open": still_open,
    }


# ---------- Forward-returns tables ----------

def forward_returns_by_bucket(s: Series, feed_key: str) -> list[dict]:
    """For each bucket of the given signal (fng or bats), compute mean
    forward return at 1w / 1m / 3m / 6m / 12m.

    Bucket labels + boundaries differ by series because they measure
    different things: CNN F&G is a 5-bucket emotion gauge (Fear/Greed),
    BATS is the site's own 8-bucket condition gauge (Oversold/Bullish)
    with boundaries at 15/18/32/45/57/65/72 — the exact structure used
    by BUCKETS in app.js and the on-page bucket table on backtest.js.
    """
    if feed_key == "fng":
        # CNN's own zone names and cutoffs, so "Extreme Fear" means the same
        # thing here as in the buy-zone tests above (25 or lower).
        buckets = [
            ("Extreme Fear (under 25)", 0,   25),
            ("Fear (25-45)",            25,  45),
            ("Neutral (45-55)",         45,  55),
            ("Greed (55-75)",           55,  75),
            ("Extreme Greed (75+)",     75, 101),
        ]
    else:  # bats — real 8-bucket taxonomy from app.js BUCKETS
        buckets = [
            ("Extremely Oversold",   0,   15),
            ("Very Oversold",       15,   18),
            ("Oversold",            18,   32),
            ("Slightly Bearish",    32,   45),
            ("Neutral",             45,   57),
            ("Slightly Bullish",    57,   65),
            ("Bullish",             65,   72),
            ("Extended",            72,  101),
        ]
    horizons = [("1w", 5), ("1m", 21), ("3m", 63), ("6m", 126), ("12m", 252)]
    feed = s.fng if feed_key == "fng" else s.bats
    n = len(s.dates)
    out = []
    for label, lo, hi in buckets:
        idxs = [i for i in range(n) if lo <= feed[i] < hi]
        row = {"bucket": label, "days": len(idxs)}
        for hlabel, hn in horizons:
            fwd = []
            for i in idxs:
                j = i + hn
                if j >= n:
                    continue
                fwd.append((s.spx[j] / s.spx[i]) - 1.0)
            if fwd:
                row[hlabel] = round(sum(fwd) / len(fwd), 4)
                # Positive rate at this horizon
                row[hlabel + "_hit"] = round(sum(1 for r in fwd if r > 0) / len(fwd), 3)
            else:
                row[hlabel] = None
                row[hlabel + "_hit"] = None
        out.append(row)

    # Append a "Baseline (any day)" row — the average forward return across
    # every trading day in the shared window, ignoring bucket. Gives the
    # reader a fixed reference for judging whether a bucket's numbers are
    # genuinely above average. Same treatment backtest.js uses on the home
    # page's bucket table.
    baseline = {"bucket": "Baseline (any day)", "days": n, "isBaseline": True}
    for hlabel, hn in horizons:
        fwd = []
        for i in range(n):
            j = i + hn
            if j >= n:
                continue
            fwd.append((s.spx[j] / s.spx[i]) - 1.0)
        if fwd:
            baseline[hlabel] = round(sum(fwd) / len(fwd), 4)
            baseline[hlabel + "_hit"] = round(sum(1 for r in fwd if r > 0) / len(fwd), 3)
        else:
            baseline[hlabel] = None
            baseline[hlabel + "_hit"] = None
    out.append(baseline)
    return out


HORIZONS = [("1w", 5), ("1m", 21), ("3m", 63), ("6m", 126), ("12m", 252)]


def fwd_stats(s: Series, idxs: list[int]) -> dict:
    """Average S&P 500 change after the given days, and how often it was up.

    Also reports how many separate "spells" those days fall into (runs of
    days less than 20 trading days apart), because 100 oversold days in a
    row are really one event, not 100.
    """
    n = len(s.dates)
    spells, last = 0, -10 ** 9
    for i in idxs:
        if i - last > 20:
            spells += 1
        last = i
    row = {"days": len(idxs), "share": round(len(idxs) / n, 4) if n else 0.0, "spells": spells}
    for hlabel, hn in HORIZONS:
        fwd = [(s.spx[i + hn] / s.spx[i]) - 1.0 for i in idxs if i + hn < n]
        if fwd:
            row[hlabel] = round(sum(fwd) / len(fwd), 4)
            row[hlabel + "_hit"] = round(sum(1 for r in fwd if r > 0) / len(fwd), 3)
        else:
            row[hlabel] = None
            row[hlabel + "_hit"] = None
    return row


def _percentile(xs: list[float], p: float) -> float:
    q = sorted(xs)
    return q[int(p * (len(q) - 1))]


def combined_low_forward_returns(s: Series, low_fng: float, low_bats: float) -> dict:
    """Extra table: what happens after days where BOTH gauges were in their
    buy zone? Compared to CNN-only-low and BATS-only-low."""
    n = len(s.dates)
    idx_both = [i for i in range(n) if s.fng[i] < low_fng and s.bats[i] < low_bats]
    idx_cnn  = [i for i in range(n) if s.fng[i] < low_fng and s.bats[i] >= low_bats]
    idx_bats = [i for i in range(n) if s.bats[i] < low_bats and s.fng[i] >= low_fng]
    return {
        "both_low":      fwd_stats(s, idx_both),
        "cnn_low_only":  fwd_stats(s, idx_cnn),
        "bats_low_only": fwd_stats(s, idx_bats),
    }


# ---------- BATS vs CNN, on equal terms ----------
# Each gauge's own published zones. These are the natural way to compare
# them: "when CNN says Extreme Fear" against "when BATS says Oversold".
# A buy zone means a reading UNDER the number (CNN under 25, BATS under 32),
# exactly as each gauge labels its own days; exits and hot zones mean the
# reading has REACHED the number.
EPS = 1e-9          # "under 25" is written as "<= 25 - EPS" for the rule helpers
ZONES = {
    "cnn":  {"name": "CNN Fear & Greed", "buy": 25, "buyLabel": "Extreme Fear",
             "exit": 55, "exitLabel": "Greed", "hot": 75, "hotLabel": "Extreme Greed"},
    "bats": {"name": "BATS", "buy": 32, "buyLabel": "Oversold",
             "exit": 57, "exitLabel": "Slightly Bullish", "hot": 72, "hotLabel": "Extended"},
}


def head_to_head_forward(s: Series) -> dict:
    """The same question asked of both gauges: what did the S&P 500 do after
    a low (or high) reading?

    Two kinds of row:
      * "zone"  each gauge's own buy zone / hot zone. CNN's fires about
        three times as often as BATS's, so this alone is not a fair fight.
      * "pNN"   equal pickiness: the lowest (or highest) N% of each gauge's
        readings over the test window, so both fire equally often. The
        cutoffs come from the whole window, so they are a fairness device
        for comparing the gauges, not a rule anyone could have traded.
    """
    n = len(s.dates)

    def low_row(key, label, c_cut, b_cut):
        return {"key": key, "label": label,
                "cnn":  {"cut": round(c_cut, 1), **fwd_stats(s, [i for i in range(n) if s.fng[i] <= c_cut])},
                "bats": {"cut": round(b_cut, 1), **fwd_stats(s, [i for i in range(n) if s.bats[i] <= b_cut])}}

    def high_row(key, label, c_cut, b_cut):
        return {"key": key, "label": label,
                "cnn":  {"cut": round(c_cut, 1), **fwd_stats(s, [i for i in range(n) if s.fng[i] >= c_cut])},
                "bats": {"cut": round(b_cut, 1), **fwd_stats(s, [i for i in range(n) if s.bats[i] >= b_cut])}}

    low = [{"key": "zone", "label": "Each gauge's own buy zone",
            "cnn":  {"cut": ZONES["cnn"]["buy"],  **fwd_stats(s, [i for i in range(n) if s.fng[i]  < ZONES["cnn"]["buy"]])},
            "bats": {"cut": ZONES["bats"]["buy"], **fwd_stats(s, [i for i in range(n) if s.bats[i] < ZONES["bats"]["buy"]])}}]
    for p, label in ((0.05, "Lowest 5% of readings"), (0.10, "Lowest 10% of readings"), (0.20, "Lowest 20% of readings")):
        low.append(low_row(f"p{int(p * 100)}", label, _percentile(s.fng, p), _percentile(s.bats, p)))
    high = [high_row("zone", "Each gauge's own hot zone", ZONES["cnn"]["hot"], ZONES["bats"]["hot"])]
    for p, label in ((0.10, "Highest 10% of readings"), (0.05, "Highest 5% of readings")):
        high.append(high_row(f"p{int(p * 100)}", label, _percentile(s.fng, 1 - p), _percentile(s.bats, 1 - p)))
    return {"low": low, "high": high, "anyDay": fwd_stats(s, list(range(n)))}


# ---------- Main ----------

def main() -> int:
    s = build_series()
    zc, zb = ZONES["cnn"], ZONES["bats"]
    c_buy, b_buy = zc["buy"] - EPS, zb["buy"] - EPS     # "under 25" / "under 32"

    # Equal-pickiness cutoffs: the lowest 10% of each gauge's readings over
    # the window, and each gauge's middle reading as the exit. Used only to
    # compare the two gauges fairly (see head_to_head_forward).
    c10, c50 = _percentile(s.fng, 0.10), _percentile(s.fng, 0.50)
    b10, b50 = _percentile(s.bats, 0.10), _percentile(s.bats, 0.50)

    # A rule that is NOT here on purpose: "BATS low AND S&P above its
    # 200-day average". It can never fire. BATS already measures the trend,
    # so it does not fall into its buy zone while the index is above that
    # average. The page reports the lowest BATS reading seen in an uptrend
    # (batsLowestInUptrend below) instead of a row of zeros.
    #
    # (name, short label for the page, description, rule)
    strategies = [
        ("Buy_and_Hold", "Buy and hold",
         "Baseline. Always invested in the S&P 500. Sets the bar every other rule has to clear.",
         always_invested),
        ("Trend_Only", "Trend only (200-day average)",
         "Invested when the S&P 500 is above its 200-day average, out otherwise. Uses neither gauge.",
         bull_market_only),

        # --- the three matched pairs shown side by side on the page ---
        # Pair 1 is "buy the fear, sell the greed": each gauge's lowest zone
        # in, each gauge's highest zone out. Same idea on both gauges.
        ("CNN_Fear_to_Greed", "CNN: buy Extreme Fear, sell Extreme Greed",
         f"Buy when CNN is under {zc['buy']} (Extreme Fear), hold until it reaches {zc['hot']} (Extreme Greed).",
         make_hysteresis(c_buy, zc["hot"], "fng")),
        ("BATS_Oversold_to_Extended", "BATS: buy Oversold, sell Extended",
         f"Buy when BATS is under {zb['buy']} (Oversold), hold until it reaches {zb['hot']} (Extended).",
         make_hysteresis(b_buy, zb["hot"], "bats")),
        ("CNN_Lowest10pct", "CNN: buy its lowest 10% of readings",
         f"Equal pickiness: buy when CNN is {c10:.1f} or lower (its lowest 10% of readings), sell at its middle reading ({c50:.1f}).",
         make_hysteresis(c10, c50, "fng")),
        ("BATS_Lowest10pct", "BATS: buy its lowest 10% of readings",
         f"Equal pickiness: buy when BATS is {b10:.1f} or lower (its lowest 10% of readings), sell at its middle reading ({b50:.1f}).",
         make_hysteresis(b10, b50, "bats")),
        ("CNN_Avoid_ExtremeGreed", "CNN: step aside at Extreme Greed",
         f"Stay invested, sell when CNN reaches {zc['hot']} (Extreme Greed), buy back when it cools to {zc['exit']}.",
         make_avoid_hot(zc["hot"], zc["exit"], "fng")),
        ("BATS_Avoid_Extended", "BATS: step aside at Extended",
         f"Stay invested, sell when BATS reaches {zb['hot']} (Extended), buy back when it cools to {zb['exit']}.",
         make_avoid_hot(zb["hot"], zb["exit"], "bats")),

        # --- other variants we ran ---
        ("CNN_ExtremeFear_25_55", "CNN: buy Extreme Fear, sell at Greed",
         f"Earlier exit: buy when CNN is under {zc['buy']}, sell as soon as it reaches {zc['exit']} (Greed).",
         make_hysteresis(c_buy, zc["exit"], "fng")),
        ("BATS_Oversold_32_57", "BATS: buy Oversold, sell at Slightly Bullish",
         f"Earlier exit: buy when BATS is under {zb['buy']}, sell as soon as it reaches {zb['exit']} (Slightly Bullish).",
         make_hysteresis(b_buy, zb["exit"], "bats")),
        ("BATS_Oversold_32_65", "BATS: buy Oversold, sell at Bullish",
         f"Middle exit: buy when BATS is under {zb['buy']}, sell when it reaches 65 (Bullish).",
         make_hysteresis(b_buy, 65, "bats")),
        ("CNN_ExtremeFear_20_50", "CNN: buy at 20, sell at 50",
         "Tighter fear entry: buy when CNN is 20 or lower, sell when it reaches 50.",
         make_hysteresis(20, 50, "fng")),
        ("CNN_Fear_plus_Trend", "CNN Extreme Fear, uptrends only",
         f"Buy when CNN is under {zc['buy']} AND the S&P 500 is above its 200-day average. Sell at {zc['exit']} or when the trend breaks.",
         make_hysteresis_with_trend(c_buy, zc["exit"], "fng", require_above_ma=True)),
        ("BATS_Low_25_55", "BATS: buy at 25, sell at 55",
         "Stricter BATS entry: buy when BATS is 25 or lower, sell when it reaches 55.",
         make_hysteresis(25, 55, "bats")),
        ("BATS_Low_30_60", "BATS: buy at 30, sell at 60",
         "Buy when BATS is 30 or lower, sell when it reaches 60.",
         make_hysteresis(30, 60, "bats")),
        ("CNN_AND_BATS_Both_Low", "Both gauges in their buy zone",
         f"Buy only when CNN is under {zc['buy']} AND BATS is under {zb['buy']}. Sell when either reaches its exit ({zc['exit']} / {zb['exit']}).",
         make_combined_and(c_buy, b_buy, zc["exit"], zb["exit"])),
        ("CNN_OR_BATS_Either_Low", "Either gauge in its buy zone",
         f"Buy when CNN is under {zc['buy']} OR BATS is under {zb['buy']}. Sell only when both have reached their exits.",
         make_combined_or(c_buy, b_buy, zc["exit"], zb["exit"])),

        # --- MACD crossovers from the Divergences page ---
        ("MACD_Cross_10bar", "MACD cross, 10-bar minimum",
         "The Divergences-page rule on daily bars: buy when the MACD line crosses above its signal after >= 10 closed bars below; sell on the mirror cross after >= 10 bars above. Earlier crosses ignored.",
         make_macd_cross(10)),
        ("MACD_Cross_NoFilter", "MACD cross, every cross",
         "Same crossover with no 10-bar minimum: every MACD/signal cross trades. Shows what the filter is worth.",
         make_macd_cross(0)),
        ("MACD_Cross_10bar_plus_Trend", "MACD cross, uptrends only",
         "MACD 10-bar crossover, but buys only when SPX > 200-day MA and also exits on a trend break.",
         make_macd_cross(10, require_trend=True)),
        ("MACD_Weekly_Cross_10bar", "MACD cross, weekly bars",
         "The same 10-bar crossover on weekly bars: decided at each Friday close, held through the following week.",
         make_macd_cross(10, weekly=True)),
    ]

    results = []
    for name, label, desc, rule in strategies:
        r = run_strategy(name, desc, rule, s)
        r["label"] = label
        results.append(r)
        print(f"  {name:32s} CAGR={r['cagr']*100:6.2f}%  MaxDD={r['maxDrawdown']*100:7.2f}%  "
              f"Sharpe={r['sharpe']:.2f}  InMkt={r['pctInMarket']*100:5.1f}%  Entries={r['entries']}")

    head = head_to_head_forward(s)
    head["pairs"] = [
        {"key": "zone",
         "title": "Buy the fear, sell the greed",
         "blurb": "Each gauge's lowest zone in, each gauge's highest zone out. The same idea on both.",
         "cnn": "CNN_Fear_to_Greed", "bats": "BATS_Oversold_to_Extended"},
        {"key": "p10",
         "title": "Equal pickiness",
         "blurb": "Both gauges fire equally often: buy at the lowest 10% of each one's readings, sell at its middle reading.",
         "cnn": "CNN_Lowest10pct", "bats": "BATS_Lowest10pct"},
        {"key": "hot",
         "title": "Stay invested, step aside when it runs hot",
         "blurb": "The sell-side test: hold stocks, sell when the gauge hits its hot zone, buy back when it cools.",
         "cnn": "CNN_Avoid_ExtremeGreed", "bats": "BATS_Avoid_Extended"},
    ]

    n = len(s.dates)
    uptrend_bats = [s.bats[i] for i in range(n) if s.ma200[i] is not None and s.spx[i] > s.ma200[i]]

    payload = {
        "generatedAt": int(time.time()),
        "windowStart": s.dates[0].isoformat(),
        "windowEnd":   s.dates[-1].isoformat(),
        "tradingDays": len(s.dates),
        "assumptions": [
            "Every test uses the same trading days and S&P 500 closing prices. Dividends are not counted.",
            "A rule that is out of the market earns nothing while it waits. No interest on cash.",
            "Trades happen at the close on the day the signal appears; the gain or loss starts the next day.",
            "No trading costs or taxes. Rules that trade often look better here than they would in real life.",
            "BATS was designed and tuned by us on this same history, so it has a home-field advantage. CNN's index was not tuned by us.",
        ],
        "zones": ZONES,
        "strategies": results,
        "headToHead": head,
        "batsLowestInUptrend": round(min(uptrend_bats), 1) if uptrend_bats else None,
        "forwardReturnsCNN":     forward_returns_by_bucket(s, "fng"),
        "forwardReturnsBATS":    forward_returns_by_bucket(s, "bats"),
        "combinedLowForward":    combined_low_forward_returns(s, zc["buy"], zb["buy"]),
    }

    with open(OUT_PATH, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"\nWrote {OUT_PATH}")
    return 0


if __name__ == "__main__":
    # This runs mid-pipeline in the nightly data job. A crash here must not
    # stop that job from committing the night's other data, so on any error
    # we warn, leave the existing signal_backtest.json in place, and exit 0.
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        print(f"::warning::backtest-signals.py failed ({e}); keeping the existing signal_backtest.json")
        sys.exit(0)
