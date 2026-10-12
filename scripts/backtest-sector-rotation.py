#!/usr/bin/env python3
"""
Sector Rotation (Smoother Ride) card on market-signals.html: the backtest,
today's holdings and the next rebalance, written to
data/sector_rotation.json every night.

The rule (chosen on 2026-10-12 from a grid of 259 sector-rotation rules as
the one with the shallowest worst drop for about the S&P 500's return):

  * On the first trading day of each month, rank the SPDR sector funds by
    their total return over the previous 12 months (252 trading days,
    measured at the previous close).
  * Hold the top four, equal weight. Drop any of the four whose 12-month
    return is negative and spread the money over the rest. If none is
    positive, hold short-term Treasuries (SHY).
  * Trades happen at the close of the rebalance day; each dollar traded
    costs 0.10%.

Funds: XLK XLF XLV XLY XLP XLE XLI XLB XLU from 1999, XLRE from Oct 2015,
XLC from Jun 2018 (a fund is eligible once it has 12 months of history).
Prices are Yahoo dividend-adjusted closes, so dividends count for the
funds and for SPY alike.

Fail-safe: the file is rewritten only when every fund downloaded and the
result passes sanity checks. Always exits 0 so the nightly job's commit
step runs.
"""

from __future__ import annotations
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH = os.path.join(REPO_ROOT, "data", "sector_rotation.json")

SECTORS = {
    "XLK": "Technology", "XLF": "Financials", "XLV": "Health Care", "XLY": "Consumer Discretionary",
    "XLP": "Consumer Staples", "XLE": "Energy", "XLI": "Industrials", "XLB": "Materials",
    "XLU": "Utilities", "XLRE": "Real Estate", "XLC": "Communication Services",
}
BENCH, CASH = "SPY", "SHY"
LOOK, TOP_N, COST = 252, 4, 0.001
START = "1999-01-04"
UA = {"User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                     "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")}


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def fetch_adjusted(sym: str) -> dict:
    """{YYYY-MM-DD: dividend-adjusted close} from Yahoo, or {} on failure."""
    url = (f"https://query2.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}"
           f"?period1=880000000&period2={int(time.time())}&interval=1d&events=div,split")
    for attempt in (1, 2, 3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                res = json.load(r)["chart"]["result"][0]
            ts = res["timestamp"]
            ind = res["indicators"]
            adj = (ind.get("adjclose") or [{}])[0].get("adjclose")
            closes = ind["quote"][0]["close"]
            series = adj if adj and len(adj) == len(ts) else closes
            out = {}
            for t, v in zip(ts, series):
                if isinstance(v, (int, float)) and v > 0:
                    out[(datetime(1970, 1, 1) + timedelta(seconds=t)).strftime("%Y-%m-%d")] = float(v)
            return out
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                warn(f"{sym}: fetch failed ({e})")
                return {}
            time.sleep(3 * attempt)
    return {}


def main() -> int:
    raw = {s: fetch_adjusted(s) for s in list(SECTORS) + [BENCH, CASH]}
    missing = [s for s, v in raw.items() if not v]
    if missing:
        warn(f"sector rotation: no data for {missing}; leaving the file unchanged")
        return 0
    dates = [d for d in sorted(raw[BENCH]) if d >= START]
    N = len(dates)
    px = {s: [raw[s].get(d) for d in dates] for s in raw}

    def ret(s, i, back):
        a = px[s][i]
        b = px[s][i - back] if i - back >= 0 else None
        return (a / b - 1) if (a and b) else None

    month_first = [i for i in range(1, N) if dates[i][:7] != dates[i - 1][:7]]

    # ---- walk the rule forward, one day at a time ----
    hold: dict[str, float] = {}
    equity = [1.0] * N
    start = None
    rebalances = []            # [{date, picks:[{sym, ret12, weight}], cash}]
    turnover = 0.0
    trades = 0
    for i in range(1, N):
        total = 0.0
        for s in list(hold):
            if px[s][i] and px[s][i - 1]:
                hold[s] *= px[s][i] / px[s][i - 1]
            total += hold[s]
        equity[i] = total if hold else equity[i - 1]
        if i not in month_first:
            continue
        sig = i - 1
        ranked = sorted(((ret(s, sig, LOOK), s) for s in SECTORS if ret(s, sig, LOOK) is not None), reverse=True)
        if len(ranked) < 5:
            continue
        if start is None:
            start = i
        picks = [(r, s) for r, s in ranked[:TOP_N] if r > 0]
        value = equity[i]
        target = {s: value / len(picks) for _, s in picks} if picks else {CASH: value}
        moved = sum(abs(target.get(s, 0.0) - hold.get(s, 0.0)) for s in set(target) | set(hold)) / 2
        turnover += moved / value
        if moved > 1e-9:
            trades += 1
        value -= moved * COST
        scale = value / sum(target.values())
        hold = {s: v * scale for s, v in target.items()}
        equity[i] = value
        rebalances.append({"date": dates[i], "picks": [{"sym": s, "ret12": round(r, 4), "weight": round(1 / len(picks), 4)} for r, s in picks],
                           "cash": 0.0 if picks else 1.0, "dropped": [s for r, s in ranked[:TOP_N] if r <= 0]})
    if start is None:
        warn("sector rotation: not enough history to start; leaving the file unchanged")
        return 0

    spy = px[BENCH]
    years_total = (date.fromisoformat(dates[-1]) - date.fromisoformat(dates[start])).days / 365.25

    def cagr(series, a, b):
        yrs = (date.fromisoformat(dates[b]) - date.fromisoformat(dates[a])).days / 365.25
        return (series[b] / series[a]) ** (1 / yrs) - 1 if yrs > 0 else 0.0

    def maxdd(series, a, b):
        peak, dd = series[a], 0.0
        for v in series[a:b + 1]:
            peak = max(peak, v)
            dd = min(dd, v / peak - 1)
        return dd

    def vol_sharpe(series, a, b):
        dr = [series[k] / series[k - 1] - 1 for k in range(a + 1, b + 1)]
        m = sum(dr) / len(dr)
        sd = math.sqrt(sum((x - m) ** 2 for x in dr) / len(dr)) * math.sqrt(252)
        return sd, (cagr(series, a, b) - 0.02) / sd if sd else 0.0

    def first_on_or_after(d):
        return next(k for k in range(N) if dates[k] >= d)

    def last_on_or_before(d):
        return max(k for k in range(N) if dates[k] <= d)

    last = N - 1
    r_vol, r_sh = vol_sharpe(equity, start, last)
    b_vol, b_sh = vol_sharpe(spy, start, last)
    wins3 = tot3 = wins5 = tot5 = 0
    worst_rel3 = 0.0
    for k in range(start, N - 756, 21):
        tot3 += 1
        rel = (equity[k + 756] / equity[k]) / (spy[k + 756] / spy[k]) - 1
        wins3 += rel > 0
        worst_rel3 = min(worst_rel3, rel)
    for k in range(start, N - 1260, 21):
        tot5 += 1
        wins5 += equity[k + 1260] / equity[k] > spy[k + 1260] / spy[k]

    years = []
    for y in sorted({d[:4] for d in dates[start:]}):
        a = max(start, first_on_or_after(y + "-01-01"))
        b = last_on_or_before(y + "-12-31")
        base_i = a - 1 if a > start else a
        years.append({"year": y, "rule": round(equity[b] / equity[base_i] - 1, 4), "spy": round(spy[b] / spy[base_i] - 1, 4),
                      "partial": y == dates[start][:4] or y == dates[-1][:4]})

    crashes = []
    for label, a, b in (("Tech bust, 2000 to 2002", "2000-03-01", "2002-10-31"), ("Financial crisis, 2007 to 2009", "2007-10-01", "2009-03-31"),
                        ("COVID, 2020", "2020-02-01", "2020-04-30"), ("Rate shock, 2022", "2022-01-01", "2022-12-31")):
        ia, ib = max(start, first_on_or_after(a)), last_on_or_before(b)
        crashes.append({"label": label, "from": dates[ia], "to": dates[ib], "rule": round(maxdd(equity, ia, ib), 4), "spy": round(maxdd(spy, ia, ib), 4)})

    periods = []
    for label, a, b in (("to 2008", dates[start], "2008-12-31"), ("2009 to 2016", "2009-01-02", "2016-12-30"), ("2017 to today", "2017-01-03", dates[-1])):
        ia, ib = max(start, first_on_or_after(a)), last_on_or_before(b)
        periods.append({"label": label, "from": dates[ia], "to": dates[ib], "rule": round(cagr(equity, ia, ib), 4), "spy": round(cagr(spy, ia, ib), 4)})

    # daily curves (parallel arrays, both start at 1) so the chart's drawdown
    # readouts match the stats exactly; sampling every few days understated them
    curves = {"d": dates[start:], "e": [round(equity[k] / equity[start], 4) for k in range(start, N)],
              "b": [round(spy[k] / spy[start], 4) for k in range(start, N)]}

    # what the picks would be if the month ended today
    ranked_now = sorted(((ret(s, last, LOOK), s) for s in SECTORS if ret(s, last, LOOK) is not None), reverse=True)
    preview = [{"sym": s, "name": SECTORS[s], "ret12": round(r, 4), "pick": k < TOP_N and r > 0} for k, (r, s) in enumerate(ranked_now)]
    nxt = date.fromisoformat(dates[-1]).replace(day=1)
    nxt = (nxt.replace(year=nxt.year + 1, month=1) if nxt.month == 12 else nxt.replace(month=nxt.month + 1))
    while nxt.weekday() >= 5:
        nxt += timedelta(days=1)

    final_ratio = equity[-1] / equity[start]
    r_cagr, b_cagr = cagr(equity, start, last), cagr(spy, start, last)
    if not (0.5 < final_ratio < 500) or abs(r_cagr) > 0.6:
        warn(f"sector rotation: result looks wrong (x{final_ratio:.1f}); leaving the file unchanged")
        return 0

    cur = rebalances[-1]
    payload = {
        "generatedAt": int(time.time()),
        "rule": {"lookbackDays": LOOK, "topN": TOP_N, "rebalance": "monthly", "costPct": COST * 100, "cash": CASH, "benchmark": BENCH},
        "window": {"start": dates[start], "end": dates[-1], "years": round(years_total, 2)},
        "names": SECTORS,
        "stats": {
            "ruleCagr": round(r_cagr, 5), "spyCagr": round(b_cagr, 5),
            "ruleMaxDd": round(maxdd(equity, start, last), 4), "spyMaxDd": round(maxdd(spy, start, last), 4),
            "ruleVol": round(r_vol, 4), "spyVol": round(b_vol, 4), "ruleSharpe": round(r_sh, 3), "spySharpe": round(b_sh, 3),
            "ruleFinal": round(final_ratio, 3), "spyFinal": round(spy[-1] / spy[start], 3),
            "win3y": round(wins3 / tot3, 3) if tot3 else None, "win5y": round(wins5 / tot5, 3) if tot5 else None,
            "worstRel3y": round(worst_rel3, 4),
            "yearsBeat": sum(1 for y in years if y["rule"] > y["spy"]), "yearsTotal": len(years),
            "tradesPerYear": round(trades / years_total, 1), "turnoverPerYear": round(turnover / years_total, 3),
            "monthsAllCash": sum(1 for r in rebalances if r["cash"] >= 1), "monthsTotal": len(rebalances),
            "monthsShortOfFour": sum(1 for r in rebalances if 0 < len(r["picks"]) < TOP_N),
        },
        "periods": periods, "crashes": crashes, "years": years, "equity": curves,
        "holdings": {"since": cur["date"], "picks": [{**p, "name": SECTORS[p["sym"]]} for p in cur["picks"]], "cash": cur["cash"],
                     "dropped": [{"sym": s, "name": SECTORS[s]} for s in cur["dropped"]]},
        "preview": {"asOf": dates[-1], "ranking": preview, "nextRebalance": nxt.isoformat()},
        # every rebalance, compact: d = date, p = the funds held until the next one (empty = cash)
        "rebalances": [{"d": r["date"], "p": [p["sym"] for p in r["picks"]]} for r in rebalances],
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"Updated sector_rotation.json: {dates[start]} to {dates[-1]}, rule {r_cagr*100:.1f}%/yr vs SPY {b_cagr*100:.1f}%, "
          f"worst drop {payload['stats']['ruleMaxDd']*100:.0f}% vs {payload['stats']['spyMaxDd']*100:.0f}%; holding "
          f"{[p['sym'] for p in cur['picks']] or 'cash'} since {cur['date']}; next rebalance {nxt}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 — never fail the nightly workflow
        warn(f"backtest-sector-rotation.py failed ({e}); keeping the existing file")
        sys.exit(0)
