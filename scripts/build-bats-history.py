#!/usr/bin/env python3
"""
Generate data/bats_history.json — one BATS reading per SPX trading day,
going back as far as the data supports. Rendered on the home page as a
"where has the BATS been?" line chart that contextualizes the current
gauge.

Runs as part of the daily update workflow. Uses the exact same scoring
functions and weights as build-bats-moments.py / app.js so the numbers
match what the live gauge shows.

Safe on failure: if any CSV is missing or parsing goes sideways, the
existing JSON is left untouched.
"""

from __future__ import annotations
import csv
import json
import os
import sys
import time
from bisect import bisect_right

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
DATA_DIR = os.path.join(REPO_ROOT, 'data')
# ---------------------------------------------------------------------------
# Market selection — same BATS logic can be applied to either the S&P 500 or
# the Nasdaq 100 by swapping four data files. Pass --market=nasdaq to build
# the Nasdaq variant; anything else (or absent) builds the S&P 500 variant.
# ---------------------------------------------------------------------------
MARKETS = {
    'sp500':  dict(vol='vix.csv', index='spx.csv', cap='spy.csv', equal='rsp.csv',
                   label='S&P 500',   out_suffix=''),
    'nasdaq': dict(vol='vxn.csv', index='ndx.csv', cap='qqq.csv', equal='qqew.csv',
                   label='Nasdaq 100', out_suffix='_ndx'),
}
MARKET = 'sp500'
for _arg in sys.argv[1:]:
    if _arg.startswith('--market='):
        _v = _arg.split('=', 1)[1].strip().lower()
        if _v in MARKETS:
            MARKET = _v
        else:
            print(f'::warning::unknown --market={_v}, defaulting to sp500')
MC = MARKETS[MARKET]

OUT_PATH = os.path.join(DATA_DIR, 'bats_history' + MC['out_suffix'] + '.json')

# Earliest history date to compute. Matches the pre-GFC-high moment on
# the home page, and it's when we have all-components coverage.
START_DATE = '2007-10-01'


def warn(msg: str) -> None:
    print(f'::warning::{msg}')


# --- Component weights (must match COMPONENTS in app.js) ---
WEIGHTS = dict(vix=25, breadth=25, rsi=10, ma200=10,
               aaii=10, naaim=5, junk=10, spread=5, sector_osc=10)

# --- Buckets (must match BUCKETS in app.js) ---
BUCKETS = [
    dict(label='Extremely Oversold', min=0,  color='var(--s-ext)', action='Aggressive Buy'),
    dict(label='Very Oversold',      min=15, color='var(--s0)',    action='Strong Buy'),
    dict(label='Oversold',           min=18, color='var(--s1)',    action='Consider Buying'),
    dict(label='Slightly Bearish',   min=32, color='var(--s2)',    action='Be Careful'),
    dict(label='Neutral',            min=45, color='var(--s3)',    action='No Real Trend'),
    dict(label='Slightly Bullish',   min=57, color='var(--s4)',    action='Hold'),
    dict(label='Bullish',            min=65, color='var(--s5)',    action='Hold, But Be Careful'),
    dict(label='Extended',           min=72, color='var(--s6)',    action='Trim / Rebalance'),
]


def bucket_for(score):
    for b in reversed(BUCKETS):
        if score >= b['min']:
            return b
    return BUCKETS[0]


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


# --- Scoring functions ported from app.js ---
def score_vix(v):
    if v is None: return None
    if   v <= 12: s = 92 - (v - 8)  * 1.5
    elif v <= 15: s = 86 - (v - 12) * 6.33
    elif v <= 20: s = 67 - (v - 15) * 4.8
    elif v <= 25: s = 43 - (v - 20) * 3.0
    elif v <= 35: s = 28 - (v - 25) * 1.4
    elif v <= 45: s = 14 - (v - 35) * 0.9
    else:         s = 5  - (v - 45) * 0.1
    return clamp(s, 2, 98)

def score_rsi(v):
    if v is None: return None
    if   v <= 15: s = 5
    elif v <= 30: s = 5  + (v - 15) * (25 - 5)  / 15
    elif v <= 50: s = 25 + (v - 30) * (50 - 25) / 20
    elif v <= 70: s = 50 + (v - 50) * (75 - 50) / 20
    elif v <= 85: s = 75 + (v - 70) * (95 - 75) / 15
    else:         s = 95
    return clamp(s, 2, 98)

def score_ma200(d):
    if d is None: return None
    if   d <= -15: s = 5
    elif d <=  -5: s = 5  + (d + 15) * (30 - 5)  / 10
    elif d <=   5: s = 30 + (d +  5) * (50 - 30) / 10
    elif d <=  10: s = 50 + (d -  5) * (70 - 50) / 5
    elif d <=  15: s = 70 + (d - 10) * (90 - 70) / 5
    else:          s = 95
    return clamp(s, 2, 98)

def score_aaii(bbs):
    if bbs is None: return None
    if   bbs <= -30: s = 5
    elif bbs <= -15: s = 5  + (bbs + 30) * 20 / 15
    elif bbs <=   0: s = 25 + (bbs + 15) * 25 / 15
    elif bbs <=  15: s = 50 + (bbs)      * 20 / 15
    elif bbs <=  30: s = 70 + (bbs - 15) * 20 / 15
    else:            s = 95
    return clamp(s, 2, 98)

def score_naaim(v):
    if v is None: return None
    if   v <=  10: s = 5
    elif v <=  35: s = 5  + (v - 10) * (25 - 5)  / 25
    elif v <=  60: s = 25 + (v - 35) * (50 - 25) / 25
    elif v <=  85: s = 50 + (v - 60) * (75 - 50) / 25
    elif v <= 100: s = 75 + (v - 85) * (90 - 75) / 15
    else:          s = 95
    return clamp(s, 2, 98)

def score_breadth(sp):  return clamp(50 + sp * 10, 5, 95) if sp is not None else None
def score_junk(sp):     return clamp(50 + sp * 10, 5, 95) if sp is not None else None

def score_spread(sp):
    if sp is None: return None
    if   sp <= -1.5: s = 5
    elif sp <=  0:   s = 5  + (sp + 1.5) * (40 - 5)  / 1.5
    elif sp <=  0.5: s = 40 + sp         * (55 - 40) / 0.5
    elif sp <=  1.5: s = 55 + (sp - 0.5) * (75 - 55) / 1.0
    elif sp <=  2.5: s = 75 + (sp - 1.5) * (95 - 75) / 1.0
    else:            s = 95
    return clamp(s, 2, 98)


def score_sector_osc(o):
    """MED10 sector-breadth oscillator (EMA-5 minus EMA-10 of ratio-adjusted
    A-D across 11 SPDR sector ETFs). Clamped at plus/minus 25."""
    if o is None: return None
    CLAMP = 25.0
    c = max(-CLAMP, min(CLAMP, o))
    s = 50 + (c / CLAMP) * 50
    return clamp(s, 2, 98)


# --- Loaders ---
def _read_csv(fname):
    path = os.path.join(DATA_DIR, fname)
    if not os.path.exists(path):
        return None
    with open(path, newline='') as f:
        return list(csv.reader(f))

def load_close(fname, close_col=1):
    rows = _read_csv(fname)
    if not rows: return None
    out = {}
    for row in rows[1:]:
        try: out[row[0]] = float(row[close_col])
        except: pass
    return out

def load_vix(fname='vix.csv'):
    rows = _read_csv(fname)
    if not rows: return None
    out = {}
    for row in rows[1:]:
        try: out[row[0]] = float(row[1])
        except: pass
    return out

def load_aaii():
    rows = _read_csv('aaii.csv')
    if not rows: return None
    out = {}
    for row in rows[1:]:
        try: out[row[0]] = float(row[4])
        except: pass
    return out

def load_naaim():
    rows = _read_csv('naaim.csv')
    if not rows: return None
    out = {}
    for row in rows[1:]:
        try: out[row[0]] = float(row[1])
        except: pass
    return out

def load_yields():
    rows = _read_csv('yields_history.csv')
    if not rows: return None
    out = {}
    for row in rows[1:]:
        try: out[row[0]] = float(row[3])
        except: pass
    return out


def load_sector_osc():
    """sector_osc.csv: date,advances,declines,ra_net,ema5,ema10,oscillator."""
    rows = _read_csv('sector_osc.csv')
    if not rows: return None
    out = {}
    for row in rows[1:]:
        try: out[row[0]] = float(row[6])
        except: pass
    return out


def snap_le_idx(sorted_keys, target):
    """Return index of largest key <= target, or -1 if none."""
    return bisect_right(sorted_keys, target) - 1


# --- Precomputed rolling series (efficient for full-history iteration) ---

def build_ma200_dist(dates, prices):
    """distance-from-200-day-MA % for every date where we have 200 prior days."""
    out = {}
    n = len(dates)
    if n < 200: return out
    window_sum = sum(prices[dates[i]] for i in range(200))
    for i in range(199, n):
        if i > 199:
            window_sum += prices[dates[i]] - prices[dates[i - 200]]
        ma = window_sum / 200
        out[dates[i]] = (prices[dates[i]] / ma - 1) * 100
    return out


def build_rsi_series(dates, prices, period=14):
    """Wilder's 14-day RSI for every date after the seed window."""
    out = {}
    n = len(dates)
    if n < period + 1: return out
    sumG = sumL = 0.0
    for i in range(1, period + 1):
        chg = prices[dates[i]] - prices[dates[i - 1]]
        if chg > 0: sumG += chg
        else:       sumL += -chg
    avgG = sumG / period
    avgL = sumL / period
    if avgL == 0:
        out[dates[period]] = 100.0
    else:
        out[dates[period]] = 100 - 100 / (1 + avgG / avgL)
    for i in range(period + 1, n):
        chg = prices[dates[i]] - prices[dates[i - 1]]
        g = chg if chg > 0 else 0
        l = -chg if chg < 0 else 0
        avgG = (avgG * (period - 1) + g) / period
        avgL = (avgL * (period - 1) + l) / period
        if avgL == 0:
            out[dates[i]] = 100.0
        else:
            out[dates[i]] = 100 - 100 / (1 + avgG / avgL)
    return out


def build_20d_return(dates, prices):
    """20-trading-day return % for every date that has 20 prior days."""
    out = {}
    n = len(dates)
    for i in range(20, n):
        out[dates[i]] = (prices[dates[i]] / prices[dates[i - 20]] - 1) * 100
    return out


def main():
    vix   = load_vix(MC['vol'])
    spx   = load_close(MC['index'])
    spy   = load_close(MC['cap'])
    rsp   = load_close(MC['equal'])
    hyg   = load_close('hyg.csv')
    lqd   = load_close('lqd.csv')
    aaii  = load_aaii()
    naaim = load_naaim()
    yields = load_yields()
    sector_osc = load_sector_osc()

    required = dict(vix=vix, spx=spx, spy=spy, rsp=rsp,
                    hyg=hyg, lqd=lqd, aaii=aaii, naaim=naaim, yields=yields,
                    sector_osc=sector_osc)
    missing = [k for k, v in required.items() if not v]
    if missing:
        warn(f'Missing data files: {missing}. Leaving bats_history.json unchanged.')
        return 0

    spx_dates = sorted(spx.keys())
    spy_dates = sorted(spy.keys())
    rsp_dates = sorted(rsp.keys())
    hyg_dates = sorted(hyg.keys())
    lqd_dates = sorted(lqd.keys())
    aaii_dates = sorted(aaii.keys())
    naaim_dates = sorted(naaim.keys())
    yields_dates = sorted(yields.keys())
    sector_dates = sorted(sector_osc.keys())

    # Precompute per-date series for speed
    ma200 = build_ma200_dist(spx_dates, spx)
    rsi   = build_rsi_series(spy_dates, spy)
    spy20 = build_20d_return(spy_dates, spy)
    rsp20 = build_20d_return(rsp_dates, rsp)
    hyg20 = build_20d_return(hyg_dates, hyg)
    lqd20 = build_20d_return(lqd_dates, lqd)

    history = []
    for d in spx_dates:
        if d < START_DATE:
            continue

        v_vix = vix.get(d)
        # Weekly-ish series: use most recent reading on or before d
        i = snap_le_idx(aaii_dates, d)
        v_aaii = aaii[aaii_dates[i]] if i >= 0 else None
        i = snap_le_idx(naaim_dates, d)
        v_naaim = naaim[naaim_dates[i]] if i >= 0 else None
        i = snap_le_idx(yields_dates, d)
        v_spread = yields[yields_dates[i]] if i >= 0 else None
        i = snap_le_idx(sector_dates, d)
        v_sector = sector_osc[sector_dates[i]] if i >= 0 else None

        v_rsi = rsi.get(d)
        v_ma  = ma200.get(d)

        s_spy20 = spy20.get(d)
        s_rsp20 = rsp20.get(d)
        s_hyg20 = hyg20.get(d)
        s_lqd20 = lqd20.get(d)
        breadth = (s_rsp20 - s_spy20) if (s_spy20 is not None and s_rsp20 is not None) else None
        junk    = (s_hyg20 - s_lqd20) if (s_hyg20 is not None and s_lqd20 is not None) else None

        scores = dict(
            vix=score_vix(v_vix),
            breadth=score_breadth(breadth),
            rsi=score_rsi(v_rsi),
            ma200=score_ma200(v_ma),
            aaii=score_aaii(v_aaii),
            naaim=score_naaim(v_naaim),
            junk=score_junk(junk),
            spread=score_spread(v_spread),
            sector_osc=score_sector_osc(v_sector),
        )

        w_sum = 0
        blend = 0.0
        for k, s in scores.items():
            if s is None:
                continue
            w = WEIGHTS[k]
            blend += s * w
            w_sum += w
        if w_sum == 0:
            continue
        score = blend / w_sum

        # Compact 2-element row keeps the JSON small.
        history.append([d, round(score, 1)])

    latest_spx_date = spx_dates[-1]
    payload = dict(
        source='Computed from data/*.csv using the same scoring functions as app.js',
        generatedAt=int(time.time()),
        latestSpxDate=latest_spx_date,
        startDate=START_DATE,
        weights=WEIGHTS,
        buckets=[dict(label=b['label'], min=b['min'], color=b['color']) for b in BUCKETS],
        history=history,
    )

    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False)
    print(f'Wrote {OUT_PATH}: {len(history)} rows through {latest_spx_date}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
