#!/usr/bin/env python3
"""
Backtest the "buy Tuesday close, sell Friday close" weekly strategy on SPY and QQQ.

Rules (as requested 2026-10-07):
    * Every Tuesday, buy at the close.  Sell at Friday's close.
      The position is held over the Wednesday, Thursday and Friday sessions.
    * If Friday is a market holiday (Good Friday etc.), sell at Thursday's close.
    * If Thursday is a holiday, nothing changes (still sell Friday).
    * Assumption (not in the request): if Tuesday itself is a holiday
      (July 4, Christmas, 9/11 week, Hurricane Sandy...), no trade that week.

Two position-sizing methods, reported separately for each ETF:
    1. Fixed:      exactly $100,000 in every trade; gains/losses are set aside.
    2. Compounded: start with $100,000 and put the whole running balance in each week.

Data: Yahoo daily closes via yfinance, dividend- and split-adjusted, from each
ETF's launch (SPY 1993-01-29, QQQ 1999-03-10) through the most recent Friday.
Downloaded into scripts/_cache/ on first run (delete that folder to refresh).
No commissions or taxes.

Results on 2026-10-07 (through 2026-10-02):
    SPY  1993-2026, 1741 trades, win rate 57.6%
         fixed $100k:  total profit $180,187  (5.35%/yr of the $100k), losing years 10 of 34
         compounded:   $100k -> $444,322, CAGR 4.53%, max drawdown -48.4%
         buy & hold:   $100k -> $3,170,384, CAGR 10.81%, max drawdown -55.2%
    QQQ  1999-2026, 1423 trades, win rate 56.8%
         fixed $100k:  total profit $222,224  (8.07%/yr of the $100k), losing years 7 of 28
         compounded:   $100k -> $531,981, CAGR 6.26%, max drawdown -61.3%
         buy & hold:   $100k -> $1,714,548, CAGR 10.87%, max drawdown -83.0%
    The Friday-close -> Tuesday-close days the strategy sits out earned 6.0%/yr on SPY
    (more than the in-trade days) and 4.3%/yr on QQQ (less).  Mild midweek edge in
    QQQ only, concentrated in 1999 and 2009.  No crash protection: 2008 was -41.7% on SPY.

Usage:
    python scripts/backtest-tue-fri.py            # prints the report
    python scripts/backtest-tue-fri.py --csv      # also writes trades_<etf>.csv and yearly.csv
                                                  # into scripts/_cache/
"""
import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "_cache")
STAKE = 100_000


def load(ticker):
    """Adjusted daily closes, cut back to the last complete week (through a Friday)."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{ticker.lower()}_adj.csv")
    if not os.path.exists(path):
        import yfinance as yf
        df = yf.download(ticker, start="1990-01-01", auto_adjust=True, progress=False)[["Close"]]
        df.columns = ["Close"]
        df.index.name = "Date"
        df.to_csv(path)
    px = pd.read_csv(path, parse_dates=["Date"]).set_index("Date")["Close"].astype(float)
    last_fri = px.index[px.index.weekday == 4][-1]
    return px[px.index <= last_fri]


def trades(px):
    """One row per calendar week: buy (Tuesday), sell (Friday or Thursday), note."""
    rows = []
    for period, days in px.groupby(px.index.to_period("W-SUN")):
        d = days.index
        tue = d[d.weekday == 1]
        if len(tue) == 0:
            rows.append((period.start_time, None, None, "no Tuesday session"))
            continue
        tue = tue[0]
        after = d[d > tue]  # Wed/Thu/Fri sessions in the same week
        if len(after) == 0:
            rows.append((period.start_time, tue, None, "no session after Tuesday"))
            continue
        exit_day = after[-1]  # Friday, or Thursday if Friday was closed
        note = "" if exit_day.weekday() == 4 else f"sold {exit_day.day_name()} (Friday closed)"
        rows.append((period.start_time, tue, exit_day, note))
    out = pd.DataFrame(rows, columns=["week", "buy", "sell", "note"])
    ok = out.dropna(subset=["buy", "sell"]).copy()
    ok["ret"] = px.loc[ok["sell"]].values / px.loc[ok["buy"]].values - 1
    return out, ok


def max_dd(curve):
    peak = curve.cummax()
    return ((curve - peak) / peak).min()


def summarize(name, px, ok):
    r = ok["ret"].values
    years = (ok["sell"].iloc[-1] - ok["buy"].iloc[0]).days / 365.25
    pnl = STAKE * r
    cum_fixed = pd.Series(pnl.cumsum(), index=ok["sell"])
    comp_curve = pd.Series(STAKE * np.cumprod(1 + r), index=ok["sell"])
    comp_final = comp_curve.iloc[-1]
    bh = px.loc[ok["sell"].iloc[-1]] / px.loc[ok["buy"].iloc[0]]
    bh_curve = px.loc[ok["buy"].iloc[0]:ok["sell"].iloc[-1]]
    years_idx = ok["sell"].dt.year.values
    yearly_pnl = pd.Series(pnl, index=ok["sell"]).groupby(years_idx).sum()
    yearly_ret = pd.Series(r, index=ok["sell"]).groupby(years_idx).apply(lambda x: np.prod(1 + x) - 1)

    # the days the strategy sits out: each sell day -> the next week's buy day
    nxt = ok["buy"].shift(-1).dropna()
    out_r = px.loc[nxt].values / px.loc[ok["sell"].iloc[:-1]].values - 1

    print(f"\n===================  {name}  ===================")
    print(f"Span: {ok['buy'].iloc[0].date()} -> {ok['sell'].iloc[-1].date()}   ({years:.1f} years, {len(r)} trades)")
    print(f"Win rate: {np.mean(r > 0):.1%}   avg trade {np.mean(r):+.3%}   median {np.median(r):+.3%}")
    print(f"Best trade {r.max():+.2%} ({ok.loc[ok['ret'].idxmax(), 'sell'].date()})   "
          f"worst {r.min():+.2%} ({ok.loc[ok['ret'].idxmin(), 'sell'].date()})")
    print("\n-- Method 1: fixed $100,000 every week (gains set aside) --")
    print(f"Total profit:            ${pnl.sum():,.0f}")
    print(f"Per year:                ${pnl.sum() / years:,.0f}   ({pnl.sum() / years / STAKE:.2%} of the $100k per year)")
    print(f"Worst slide in banked P&L: ${(cum_fixed - cum_fixed.cummax()).min():,.0f}")
    print(f"Losing years: {(yearly_pnl < 0).sum()} of {len(yearly_pnl)}   "
          f"worst ${yearly_pnl.min():,.0f} ({yearly_pnl.idxmin()})   best ${yearly_pnl.max():,.0f} ({yearly_pnl.idxmax()})")
    print("\n-- Method 2: compounded (whole balance each week) --")
    print(f"$100,000 grew to:        ${comp_final:,.0f}   ({comp_final / STAKE:.2f}x)")
    print(f"CAGR:                    {(comp_final / STAKE) ** (1 / years) - 1:.2%}")
    print(f"Max drawdown:            {max_dd(comp_curve):.1%}")
    print("\n-- Buy & hold, same span --")
    print(f"$100,000 grew to:        ${STAKE * bh:,.0f}   ({bh:.2f}x)   CAGR {bh ** (1 / years) - 1:.2%}   "
          f"max drawdown {max_dd(bh_curve):.1%}")
    print(f"Strategy captured {np.log(1 + r).sum() / np.log(bh):.0%} of the market's total (log) gain")
    print(f"Days sat out (Fri close -> Tue close): {np.prod(1 + out_r):.2f}x, "
          f"CAGR {np.prod(1 + out_r) ** (1 / years) - 1:.2%}, win rate {np.mean(out_r > 0):.1%}")
    return yearly_ret, yearly_pnl


def main():
    write_csv = "--csv" in sys.argv
    yearly = {}
    for t in ["SPY", "QQQ"]:
        px = load(t)
        allw, ok = trades(px)
        skipped = allw[allw["sell"].isna()]
        early = ok[ok["note"] != ""]
        print(f"\n{t}: {len(allw)} weeks, {len(ok)} trades, {len(skipped)} skipped (Tuesday closed), "
              f"{len(early)} sold Thursday (Friday closed)")
        if len(skipped):
            print("  skipped weeks of:", ", ".join(str(w.date()) for w in skipped["week"]))
        yearly[f"{t} strat"], yearly[f"{t} fixed $"] = summarize(t, px, ok)
        yearly[f"{t} B&H"] = px.groupby(px.index.year).apply(lambda x: x.iloc[-1] / x.iloc[0] - 1)
        if write_csv:
            ok.to_csv(os.path.join(CACHE, f"trades_{t.lower()}.csv"), index=False)

    # QQQ only exists from 1999, so also show SPY over the same span
    px = load("SPY")
    px = px[px.index >= "1999-03-10"]
    summarize("SPY (same span as QQQ, from Mar 1999)", px, trades(px)[1])

    yr = pd.DataFrame(yearly)[["SPY strat", "SPY B&H", "SPY fixed $", "QQQ strat", "QQQ B&H", "QQQ fixed $"]]
    print("\n\n========== Year by year: strategy (compounded) vs buy & hold, and fixed-$100k profit ==========")
    fmt = {c: (lambda v: f"{v:+.1%}" if pd.notna(v) else "") for c in yr.columns if "$" not in c}
    fmt.update({c: (lambda v: f"${v:,.0f}" if pd.notna(v) else "") for c in yr.columns if "$" in c})
    pd.set_option("display.width", 200)
    print(yr.to_string(formatters=fmt))
    if write_csv:
        yr.to_csv(os.path.join(CACHE, "yearly.csv"))


if __name__ == "__main__":
    main()
