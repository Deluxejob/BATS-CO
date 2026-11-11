#!/usr/bin/env python3
"""
Backtest the "Both Gates 2x" rule shown on market-signals.html.

The rule:
    Hold a 2x leveraged index fund (SSO for the S&P 500, QLD for the
    Nasdaq-100) when BOTH
        close > SMA200(close)            (trend gate)
      AND
        NFCI < SMA50(NFCI)               (credit gate: conditions easing)
    Otherwise sit in T-bills (3-month Treasury yield).

Conventions (identical to the in-page JavaScript on the card):
    - The signal at day t's close sets day t+1's position.
    - NFCI is dated to the Friday it covers but published the following
      Wednesday, so each reading is shifted forward NFCI_LAG_DAYS (5)
      before it is used. --lag 0 shows how much that matters.
    - The 2x fund is simulated as 2x the index's daily move minus a 0.9%
      expense ratio and the T-bill rate on the borrowed half. The real
      SSO and QLD have done slightly better than this since 2006 because
      the index closes exclude dividends.
    - T-bill yield = 10-year yield (data/yields_history.csv) minus the
      10y-3m spread (data/t10y3m.csv).

Data: data/spx.csv, data/ndx.csv, data/nfci.csv, data/yields_history.csv,
data/t10y3m.csv — all refreshed nightly by update-data.yml.

Usage:
    python scripts/backtest-both-gates.py            # both indexes, 1990-now
    python scripts/backtest-both-gates.py --lag 0    # no publication delay
    python scripts/backtest-both-gates.py --grid     # MA / NFCI-SMA / leverage sensitivity
"""
import argparse
import csv
import datetime as dt
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
START = '1990-01-02'
FUND_ER = 0.009


def load(name, col=1):
    out = {}
    with open(os.path.join(DATA, name), newline='') as fh:
        r = csv.reader(fh)
        next(r)
        for row in r:
            try:
                out[row[0]] = float(row[col])
            except (ValueError, IndexError):
                pass
    return out


def sma(vals, n):
    out = [None] * len(vals)
    s = 0.0
    ok = 0
    for i, v in enumerate(vals):
        if v is None:
            s = 0.0
            ok = 0
            continue
        s += v
        ok += 1
        if ok > n:
            s -= vals[i - n]
            ok = n
        if ok == n:
            out[i] = s / n
    return out


def ffill(series_sorted, dates):
    out = [None] * len(dates)
    i = 0
    cur = None
    for k, d in enumerate(dates):
        while i < len(series_sorted) and series_sorted[i][0] <= d:
            cur = series_sorted[i][1]
            i += 1
        out[k] = cur
    return out


def add_days(d, n):
    return (dt.date.fromisoformat(d) + dt.timedelta(days=n)).isoformat()


def backtest(px, nfci, tbill, ma_n=200, nf_n=50, lev=2.0, lag=5, start=START):
    dates = sorted(d for d in px if d >= '1989-01-01')
    close = [px[d] for d in dates]
    ma = sma(close, ma_n)
    nf_pub = sorted((add_days(d, lag), v) for d, v in nfci.items())
    nf_daily = ffill(nf_pub, dates)
    nf_sma = sma(nf_daily, nf_n)
    tb = ffill(sorted(tbill.items()), dates)
    tb = [v if v is not None else 0.03 for v in tb]
    inv = [None] * len(dates)
    for i in range(len(dates)):
        if ma[i] is None or nf_daily[i] is None or nf_sma[i] is None:
            continue
        inv[i] = close[i] > ma[i] and nf_daily[i] < nf_sma[i]
    s0 = next(i for i, d in enumerate(dates) if d >= start)
    while inv[s0] is None:
        s0 += 1
    w = b = 1.0
    pk = bpk = 1.0
    dd = bdd = 0.0
    rets = []
    in_days = switches = 0
    years = {}
    byears = {}
    for i in range(s0 + 1, len(dates)):
        r = close[i] / close[i - 1] - 1
        t = tb[i] / 252
        pos = inv[i - 1]
        dr = lev * r - (lev - 1) * t - FUND_ER / 252 if pos else t
        w *= 1 + dr
        b *= 1 + r
        rets.append(dr)
        pk = max(pk, w)
        dd = min(dd, w / pk - 1)
        bpk = max(bpk, b)
        bdd = min(bdd, b / bpk - 1)
        in_days += 1 if pos else 0
        switches += 1 if inv[i] != inv[i - 1] else 0
        y = dates[i][:4]
        years[y] = years.get(y, 1.0) * (1 + dr)
        byears[y] = byears.get(y, 1.0) * (1 + r)
    n = len(rets) / 252
    mu = sum(rets) / len(rets)
    sd = math.sqrt(sum((x - mu) ** 2 for x in rets) / len(rets)) * math.sqrt(252)
    cagr = w ** (1 / n) - 1
    return dict(cagr=cagr, bh_cagr=b ** (1 / n) - 1, dd=dd, bh_dd=bdd, sharpe=(cagr - 0.02) / sd if sd else 0,
                vol=sd, years=n, in_market=in_days / len(rets), switches=switches / n,
                worst_year=min(years.items(), key=lambda kv: kv[1]), yearly=years, bh_yearly=byears,
                first=dates[s0], last=dates[-1], inv=inv, dates=dates)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lag', type=int, default=5, help='NFCI publication delay in days (default 5)')
    ap.add_argument('--grid', action='store_true', help='print the parameter sensitivity grid')
    ap.add_argument('--years', action='store_true', help='print calendar-year returns')
    args = ap.parse_args()

    spx, ndx, nfci = load('spx.csv'), load('ndx.csv'), load('nfci.csv')
    y10, spread = load('yields_history.csv', 2), load('t10y3m.csv', 1)
    tbill = {d: max(0.0, y10[d] - spread[d]) / 100 for d in y10 if d in spread}

    print('Both Gates 2x: SMA%d trend AND NFCI < SMA50 (lag %dd) -> 2x fund, else T-bills' % (200, args.lag))
    print('%-12s %7s %8s %7s %8s %7s %7s %6s %8s %s' % ('index', 'CAGR', 'B&H', 'maxDD', 'B&H DD', 'Sharpe', 'in mkt', 'sw/yr', 'worst yr', 'span'))
    for px, nm in ((spx, 'S&P 500'), (ndx, 'Nasdaq-100')):
        r = backtest(px, nfci, tbill, lag=args.lag)
        print('%-12s %6.1f%% %7.1f%% %6.0f%% %7.0f%% %7.2f %6.0f%% %6.1f %4.0f%% %s  %s..%s' % (
            nm, r['cagr'] * 100, r['bh_cagr'] * 100, r['dd'] * 100, r['bh_dd'] * 100, r['sharpe'],
            r['in_market'] * 100, r['switches'], (r['worst_year'][1] - 1) * 100, r['worst_year'][0], r['first'], r['last']))
        state = 'IN (2x)' if r['inv'][-1] else 'OUT (T-bills)'
        print('%-12s today %s: %s' % ('', r['last'], state))
        if args.years:
            print('   year   rule    B&H')
            for y in sorted(r['yearly']):
                print('   %s %6.0f%% %6.0f%%' % (y, (r['yearly'][y] - 1) * 100, (r['bh_yearly'][y] - 1) * 100))

    if args.grid:
        print('\nSensitivity, S&P 500: CAGR / maxDD / Sharpe')
        for ma_n in (100, 150, 200, 250):
            for nf_n in (30, 50, 70):
                r = backtest(spx, nfci, tbill, ma_n=ma_n, nf_n=nf_n, lag=args.lag)
                print('  MA %3d  NFCI-SMA %2d:  %5.1f%%  %5.0f%%  %.2f' % (ma_n, nf_n, r['cagr'] * 100, r['dd'] * 100, r['sharpe']))
        print('Leverage, S&P 500, MA200/NFCI-SMA50:')
        for lev in (1.0, 1.5, 2.0, 3.0):
            r = backtest(spx, nfci, tbill, lev=lev, lag=args.lag)
            print('  %.1fx: %5.1f%%  %5.0f%%  %.2f' % (lev, r['cagr'] * 100, r['dd'] * 100, r['sharpe']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
