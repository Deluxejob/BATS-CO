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

    total_return = equity[-1] - 1.0
    years = (s.dates[-1] - s.dates[0]).days / 365.25
    cagr = (equity[-1] ** (1.0 / years)) - 1.0 if years > 0 else 0.0

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
        "maxDrawdown": round(max_dd, 4),
        "sharpe": round(sharpe, 3),
        "pctInMarket": round(pct_in_market, 4),
        "entries": entries,
        "equityFinal": round(equity[-1], 4),
        "equityCurve": sampled,
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
        buckets = [
            ("Extreme Fear (0-20)",   0,   20),
            ("Fear (20-40)",          20,  40),
            ("Neutral (40-60)",       40,  60),
            ("Greed (60-80)",         60,  80),
            ("Extreme Greed (80+)",   80, 101),
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
    return out


def combined_low_forward_returns(s: Series) -> dict:
    """Extra table: what happens after days where BOTH signals were low
    (CNN <= 25 AND BATS <= 30)? Compared to CNN-only-low and BATS-only-low."""
    horizons = [("1w", 5), ("1m", 21), ("3m", 63), ("6m", 126), ("12m", 252)]
    n = len(s.dates)
    def _agg(idxs: list[int]) -> dict:
        row = {"days": len(idxs)}
        for hlabel, hn in horizons:
            fwd = []
            for i in idxs:
                j = i + hn
                if j >= n:
                    continue
                fwd.append((s.spx[j] / s.spx[i]) - 1.0)
            if fwd:
                row[hlabel] = round(sum(fwd) / len(fwd), 4)
                row[hlabel + "_hit"] = round(sum(1 for r in fwd if r > 0) / len(fwd), 3)
            else:
                row[hlabel] = None
                row[hlabel + "_hit"] = None
        return row
    idx_both = [i for i in range(n) if s.fng[i] <= 25 and s.bats[i] <= 30]
    idx_cnn  = [i for i in range(n) if s.fng[i] <= 25 and s.bats[i] > 30]
    idx_bats = [i for i in range(n) if s.bats[i] <= 30 and s.fng[i] > 25]
    return {
        "both_low":      _agg(idx_both),
        "cnn_low_only":  _agg(idx_cnn),
        "bats_low_only": _agg(idx_bats),
    }


# ---------- Main ----------

def main() -> int:
    s = build_series()

    strategies = [
        ("Buy_and_Hold",
         "Baseline. Always invested in S&P 500. Sets the bar every other strategy has to clear.",
         always_invested),
        ("Trend_Only",
         "Regime filter: invested when SPX is above its 200-day moving average, out otherwise. No sentiment input.",
         bull_market_only),
        ("CNN_ExtremeFear_25_55",
         "Buy when CNN <= 25, sell when CNN >= 55. Pure fear-buying with a neutral exit.",
         make_hysteresis(25, 55, "fng")),
        ("CNN_ExtremeFear_20_50",
         "Tighter fear entry: buy when CNN <= 20, sell when CNN >= 50.",
         make_hysteresis(20, 50, "fng")),
        ("CNN_Fear_plus_Trend",
         "Buy when CNN <= 25 AND SPX > 200MA (trend filter). Exit on CNN >= 55 OR trend break.",
         make_hysteresis_with_trend(25, 55, "fng", require_above_ma=True)),
        ("BATS_Low_25_55",
         "Buy when BATS <= 25, sell when BATS >= 55. Pure BATS-buying.",
         make_hysteresis(25, 55, "bats")),
        ("BATS_Low_30_60",
         "Looser BATS entry: buy when BATS <= 30, sell when BATS >= 60.",
         make_hysteresis(30, 60, "bats")),
        ("BATS_Low_plus_Trend",
         "Buy when BATS <= 30 AND SPX > 200MA. Exit on BATS >= 60 OR trend break.",
         make_hysteresis_with_trend(30, 60, "bats", require_above_ma=True)),
        ("CNN_AND_BATS_Both_Low",
         "Strict combined: buy only when CNN <= 25 AND BATS <= 30. Exit when either rises above its threshold (55 / 60).",
         make_combined_and(25, 30, 55, 60)),
        ("CNN_OR_BATS_Either_Low",
         "Loose combined: buy when CNN <= 25 OR BATS <= 30. Exit only when BOTH have risen above thresholds.",
         make_combined_or(25, 30, 55, 60)),
    ]

    results = []
    for name, desc, rule in strategies:
        r = run_strategy(name, desc, rule, s)
        results.append(r)
        print(f"  {name:32s} CAGR={r['cagr']*100:6.2f}%  MaxDD={r['maxDrawdown']*100:7.2f}%  "
              f"Sharpe={r['sharpe']:.2f}  InMkt={r['pctInMarket']*100:5.1f}%  Entries={r['entries']}")

    payload = {
        "generatedAt": int(datetime.utcnow().timestamp()),
        "windowStart": s.dates[0].isoformat(),
        "windowEnd":   s.dates[-1].isoformat(),
        "tradingDays": len(s.dates),
        "assumptions": [
            "Invested days earn full SPX daily return; flat days earn 0% (no cash yield credit).",
            "Trades execute at the close of the signal day; the invested return begins the next trading day.",
            "No transaction costs, taxes, or slippage. Whipsaw count surfaces flip frequency.",
            "SPX daily closes are index level (Yahoo ^GSPC), so no reinvested dividends.",
        ],
        "strategies": results,
        "forwardReturnsCNN":     forward_returns_by_bucket(s, "fng"),
        "forwardReturnsBATS":    forward_returns_by_bucket(s, "bats"),
        "combinedLowForward":    combined_low_forward_returns(s),
    }

    with open(OUT_PATH, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"\nWrote {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
