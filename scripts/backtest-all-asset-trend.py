#!/usr/bin/env python3
"""
All-Asset Trend Rotation card on market-signals.html: the backtest, today's
holdings and the next rebalance, written to data/all_asset_trend.json
every night.

The rule (chosen 2026-10-13 from seven generic "risk-on / risk-off"
variants over a 23-fund all-asset universe; it was the one with the best
return for about half the S&P 500's worst drop):

  * On the first trading day of each month, using the previous close, score
    every fund by its 6-month return (126 trading days).
  * A fund is "risk on" when that return is positive AND its price is above
    its 10-month average (210 trading days).
  * Hold the 7 strongest risk-on funds in equal parts (1/7 each). Any slot
    that cannot be filled sits in short-term Treasuries (SHY).
  * Trades fill at the close of the rebalance day; each dollar traded costs
    0.10%.

Universe: 23 ETFs across international stocks, US stocks, Treasuries,
corporate bonds, international bonds, commodities, a bitcoin trust and
currencies. A fund joins once it has 10 months of history. Prices are
Yahoo dividend-adjusted closes, so dividends count for the funds and for
SPY alike. The backtest starts January 2008, the first month most of the
universe existed.

Also runs the same rule with the bitcoin trust left out, because that one
fund carries a large share of the result and the card says so.

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
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH = os.path.join(REPO_ROOT, "data", "all_asset_trend.json")

CLASSES = {
    "intl": "International stocks", "us": "US stocks", "tsy": "Treasuries", "corp": "Corporate bonds",
    "intlbond": "International bonds", "cmdty": "Commodities", "btc": "Bitcoin trust", "fx": "Currencies",
}
UNIVERSE = {
    "EEM": ("Emerging markets", "intl"), "AAXJ": ("Asia ex-Japan", "intl"), "VGK": ("Europe", "intl"), "ILF": ("Latin America", "intl"),
    "QQQ": ("Nasdaq 100", "us"), "MDY": ("S&P 400 mid caps", "us"), "RSP": ("S&P 500 equal weight", "us"), "IJR": ("S&P 600 small caps", "us"),
    "IEF": ("Treasuries 7-10 yr", "tsy"), "TLH": ("Treasuries 10-20 yr", "tsy"), "TLT": ("Treasuries 20+ yr", "tsy"),
    "LQD": ("Investment-grade corporates", "corp"), "HYG": ("High-yield corporates", "corp"),
    "BWX": ("International Treasuries", "intlbond"), "IGOV": ("International Treasuries, iShares", "intlbond"), "BNDX": ("International bonds, hedged", "intlbond"),
    "USO": ("Crude oil", "cmdty"), "UGA": ("Gasoline", "cmdty"), "GLD": ("Gold", "cmdty"), "SLV": ("Silver", "cmdty"),
    "GBTC": ("Bitcoin trust", "btc"),
    "FXF": ("Swiss franc", "fx"), "UUP": ("US dollar", "fx"),
}
BENCH, CASH = "SPY", "SHY"
LOOK, TREND, TOP_N, COST = 126, 210, 7, 0.001
START = "2007-12-01"          # first signal at the end of Dec 2007, first trade 2008-01-02
UA = {"User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                     "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")}


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def fetch_adjusted(sym: str) -> dict:
    """{YYYY-MM-DD: dividend-adjusted close} from Yahoo, or {} on failure."""
    url = (f"https://query2.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}"
           f"?period1=940000000&period2={int(time.time())}&interval=1d&events=div,split")
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


class Market:
    """Forward-filled daily prices on SPY's calendar, with prefix sums for moving averages."""

    def __init__(self, raw: dict):
        self.dates = [d for d in sorted(raw[BENCH]) if d >= "2003-01-01"]
        self.N = len(self.dates)
        self.px, self.first, self.csum = {}, {}, {}
        for s, series in raw.items():
            arr, last = [], None
            for d in self.dates:
                v = series.get(d)
                if v:
                    last = v
                arr.append(last)
            self.px[s] = arr
            self.first[s] = next((i for i in range(self.N) if arr[i]), self.N)
            cs = [0.0] * (self.N + 1)
            for i in range(self.N):
                cs[i + 1] = cs[i] + (arr[i] or 0.0)
            self.csum[s] = cs

    def ret(self, s, i, back):
        return None if i - back < self.first[s] else self.px[s][i] / self.px[s][i - back] - 1

    def sma(self, s, i, n):
        return None if i - n + 1 < self.first[s] else (self.csum[s][i + 1] - self.csum[s][i - n + 1]) / n

    def score(self, s, i):
        """(momentum, risk_on) at close i, or None if the fund is too young."""
        m, a = self.ret(s, i, LOOK), self.sma(s, i, TREND)
        if m is None or a is None:
            return None
        return m, (m > 0 and self.px[s][i] > a)


def run(mk: Market, universe: list[str]):
    """Daily equity curve plus the list of rebalances. Signal at month-end close, fill next close."""
    N, dates, px = mk.N, mk.dates, mk.px
    month_end = {i for i in range(N - 1) if dates[i][:7] != dates[i + 1][:7]}
    i0 = next(i for i in range(N) if dates[i] >= START)
    hold, equity, pending = {}, [1.0] * N, None
    start, turnover, trades, rebalances = None, 0.0, 0, []
    for i in range(1, N):
        tot = 0.0
        for s in list(hold):
            if px[s][i] and px[s][i - 1]:
                hold[s] *= px[s][i] / px[s][i - 1]
            tot += hold[s]
        equity[i] = tot if hold else equity[i - 1]
        if pending is not None:
            value = equity[i]
            target = {s: value * w for s, w in pending["w"].items()}
            moved = sum(abs(target.get(s, 0.0) - hold.get(s, 0.0)) for s in set(target) | set(hold)) / 2
            turnover += moved / value
            if moved > 1e-9:
                trades += 1
            value -= moved * COST
            scale = value / sum(target.values())
            hold = {s: v * scale for s, v in target.items()}
            equity[i] = value
            if start is None:
                start = i
            rebalances.append({"d": dates[i], "p": pending["picks"], "cash": pending["w"].get(CASH, 0.0)})
            pending = None
        if i in month_end and i >= i0:
            scored = []
            for s in universe:
                sc = mk.score(s, i)
                if sc is not None and sc[1]:
                    scored.append((sc[0], s))
            scored.sort(reverse=True)
            picks = [s for _, s in scored[:TOP_N]]
            w = {s: 1 / TOP_N for s in picks}
            if len(picks) < TOP_N:
                w[CASH] = (TOP_N - len(picks)) / TOP_N
            pending = {"w": w, "picks": picks}
    return equity, start, turnover, trades, rebalances


def main() -> int:
    syms = list(UNIVERSE) + [BENCH, CASH]
    with ThreadPoolExecutor(6) as ex:
        raw = dict(zip(syms, ex.map(fetch_adjusted, syms)))
    missing = [s for s, v in raw.items() if not v]
    if missing:
        warn(f"all-asset trend: no data for {missing}; leaving the file unchanged")
        return 0
    mk = Market(raw)
    dates, N, spy = mk.dates, mk.N, mk.px[BENCH]
    equity, start, turnover, trades, rebalances = run(mk, list(UNIVERSE))
    if start is None:
        warn("all-asset trend: not enough history; leaving the file unchanged")
        return 0
    eq_x, start_x, _, _, _ = run(mk, [s for s in UNIVERSE if s != "GBTC"])
    last = N - 1
    years_total = (date.fromisoformat(dates[last]) - date.fromisoformat(dates[start])).days / 365.25

    def cagr(series, a, b):
        yrs = (date.fromisoformat(dates[b]) - date.fromisoformat(dates[a])).days / 365.25
        return (series[b] / series[a]) ** (1 / yrs) - 1 if yrs > 0 else 0.0

    def maxdd(series, a, b):
        return maxdd_when(series, a, b)[0]

    def maxdd_when(series, a, b):
        """(worst drop, peak date, trough date) between a and b."""
        peak, peak_d, dd, span = series[a], dates[a], 0.0, (dates[a], dates[a])
        for k in range(a, b + 1):
            v = series[k]
            if v > peak:
                peak, peak_d = v, dates[k]
            if v / peak - 1 < dd:
                dd, span = v / peak - 1, (peak_d, dates[k])
        return dd, span[0], span[1]

    def vol_sharpe(series, a, b):
        dr = [series[k] / series[k - 1] - 1 for k in range(a + 1, b + 1)]
        m = sum(dr) / len(dr)
        sd = math.sqrt(sum((x - m) ** 2 for x in dr) / len(dr)) * math.sqrt(252)
        cash_cagr = cagr(mk.px[CASH], a, b)
        return sd, (cagr(series, a, b) - cash_cagr) / sd if sd else 0.0

    def first_on_or_after(d):
        return next(k for k in range(N) if dates[k] >= d)

    def last_on_or_before(d):
        return max(k for k in range(N) if dates[k] <= d)

    def year_rows(series, a):
        rows = []
        for y in sorted({d[:4] for d in dates[a:]}):
            ia = max(a, first_on_or_after(y + "-01-01"))
            ib = last_on_or_before(y + "-12-31")
            base = ia - 1 if ia > a else ia
            rows.append((y, series[ib] / series[base] - 1))
        return rows

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

    yr_rule, yr_spy = year_rows(equity, start), year_rows(spy, start)
    years = [{"year": y, "rule": round(r, 4), "spy": round(s, 4), "partial": y in (dates[start][:4], dates[-1][:4])}
             for (y, r), (_, s) in zip(yr_rule, yr_spy)]
    yr_x = dict(year_rows(eq_x, start_x))

    crashes = []
    for label, a, b in (("Financial crisis, 2008 to 2009", "2008-01-02", "2009-03-31"), ("COVID, 2020", "2020-02-03", "2020-04-30"),
                        ("Rate shock, 2022", "2022-01-03", "2022-12-30")):
        ia, ib = max(start, first_on_or_after(a)), last_on_or_before(b)
        crashes.append({"label": label, "from": dates[ia], "to": dates[ib], "rule": round(maxdd(equity, ia, ib), 4), "spy": round(maxdd(spy, ia, ib), 4)})
    periods = []
    for label, a, b in (("2008 to 2012", dates[start], "2012-12-31"), ("2013 to 2019", "2013-01-02", "2019-12-31"), ("2020 to today", "2020-01-02", dates[-1])):
        ia, ib = max(start, first_on_or_after(a)), last_on_or_before(b)
        periods.append({"label": label, "from": dates[ia], "to": dates[ib], "rule": round(cagr(equity, ia, ib), 4), "spy": round(cagr(spy, ia, ib), 4)})

    # today's picture: what the rule would pick if the month ended today
    ranking = []
    for s in UNIVERSE:
        sc = mk.score(s, last)
        name, cls = UNIVERSE[s]
        if sc is None:
            ranking.append({"sym": s, "name": name, "cls": cls, "mom": None, "on": False})
        else:
            ranking.append({"sym": s, "name": name, "cls": cls, "mom": round(sc[0], 4), "on": bool(sc[1])})
    ranking.sort(key=lambda r: (r["mom"] is None, -(r["mom"] or 0)))
    n_pick = 0
    for r in ranking:
        r["pick"] = bool(r["on"] and n_pick < TOP_N)
        n_pick += r["pick"]
    nxt = date.fromisoformat(dates[-1]).replace(day=1)
    nxt = nxt.replace(year=nxt.year + 1, month=1) if nxt.month == 12 else nxt.replace(month=nxt.month + 1)
    while nxt.weekday() >= 5:
        nxt += timedelta(days=1)

    cur = rebalances[-1]
    cur_scores = {}
    sig_i = max(k for k in range(N) if dates[k] < cur["d"])        # the month-end close the current picks were scored on
    for s in cur["p"]:
        sc = mk.score(s, sig_i)
        cur_scores[s] = round(sc[0], 4) if sc else None

    r_cagr, b_cagr = cagr(equity, start, last), cagr(spy, start, last)
    final_ratio = equity[last] / equity[start]
    if not (0.3 < final_ratio < 500) or abs(r_cagr) > 0.6:
        warn(f"all-asset trend: result looks wrong (x{final_ratio:.1f}); leaving the file unchanged")
        return 0

    n_full = sum(1 for r in rebalances if len(r["p"]) == TOP_N)
    r_dd, r_dd_from, r_dd_to = maxdd_when(equity, start, last)
    b_dd, b_dd_from, b_dd_to = maxdd_when(spy, start, last)
    payload = {
        "generatedAt": int(time.time()),
        "rule": {"lookbackDays": LOOK, "trendDays": TREND, "topN": TOP_N, "rebalance": "monthly", "costPct": COST * 100, "cash": CASH, "benchmark": BENCH},
        "window": {"start": dates[start], "end": dates[-1], "years": round(years_total, 2)},
        "names": {s: v[0] for s, v in UNIVERSE.items()}, "classOf": {s: v[1] for s, v in UNIVERSE.items()}, "classes": CLASSES,
        "stats": {
            "ruleCagr": round(r_cagr, 5), "spyCagr": round(b_cagr, 5),
            "ruleMaxDd": round(r_dd, 4), "spyMaxDd": round(b_dd, 4),
            "ruleMaxDdFrom": r_dd_from, "ruleMaxDdTo": r_dd_to, "spyMaxDdFrom": b_dd_from, "spyMaxDdTo": b_dd_to,
            "ruleVol": round(r_vol, 4), "spyVol": round(b_vol, 4), "ruleSharpe": round(r_sh, 3), "spySharpe": round(b_sh, 3),
            "ruleFinal": round(final_ratio, 3), "spyFinal": round(spy[last] / spy[start], 3),
            "win3y": round(wins3 / tot3, 3) if tot3 else None, "win5y": round(wins5 / tot5, 3) if tot5 else None,
            "worstRel3y": round(worst_rel3, 4),
            "yearsBeat": sum(1 for y in years if y["rule"] > y["spy"]), "yearsTotal": len(years),
            "ruleNegYears": [y["year"] for y in years if y["rule"] < 0], "spyNegYears": [y["year"] for y in years if y["spy"] < 0],
            "tradesPerYear": round(trades / years_total, 1), "turnoverPerYear": round(turnover / years_total, 3),
            "monthsTotal": len(rebalances), "monthsFull": n_full, "monthsAllCash": sum(1 for r in rebalances if not r["p"]),
            "avgPositions": round(sum(len(r["p"]) for r in rebalances) / len(rebalances), 2),
            "exBtcCagr": round(cagr(eq_x, start_x, last), 5), "exBtcMaxDd": round(maxdd(eq_x, start_x, last), 4),
            "exBtcNegYears": [y for y, r in yr_x.items() if r < 0],
        },
        "periods": periods, "crashes": crashes, "years": years,
        "equity": {"d": dates[start:], "e": [round(equity[k] / equity[start], 4) for k in range(start, N)],
                   "b": [round(spy[k] / spy[start], 4) for k in range(start, N)]},
        "holdings": {"since": cur["d"], "picks": [{"sym": s, "name": UNIVERSE[s][0], "cls": UNIVERSE[s][1], "mom": cur_scores[s]} for s in cur["p"]],
                     "cash": round(cur["cash"], 4)},
        "preview": {"asOf": dates[-1], "ranking": ranking, "nextRebalance": nxt.isoformat()},
        "rebalances": [{"d": r["d"], "p": r["p"]} for r in rebalances],
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"Updated all_asset_trend.json: {dates[start]} to {dates[-1]}, rule {r_cagr*100:.1f}%/yr vs SPY {b_cagr*100:.1f}%, "
          f"worst drop {payload['stats']['ruleMaxDd']*100:.0f}% vs {payload['stats']['spyMaxDd']*100:.0f}%, losing years "
          f"{payload['stats']['ruleNegYears']}; without GBTC {payload['stats']['exBtcCagr']*100:.1f}%/yr; holding {cur['p'] or 'cash'} "
          f"since {cur['d']}; next rebalance {nxt}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 — never fail the nightly workflow
        warn(f"backtest-all-asset-trend.py failed ({e}); keeping the existing file")
        sys.exit(0)
