#!/usr/bin/env python3
"""
Generate data/bats_moments.json — pre-computed BATS readings + forward
returns for a curated list of well-known market moments. Rendered on
the home page under the "Does the BATS work?" section as a real-world
validation exercise: what did the indicator say at moments people
actually remember, and what happened next?

Runs as part of the daily update workflow so as new price data comes
in, the forward-return windows for recent moments fill in.

Safe on failure: if any CSV is missing or parsing goes sideways, the
existing JSON is left untouched.
"""

from __future__ import annotations
import csv
import json
import os
import sys
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

OUT_PATH = os.path.join(DATA_DIR, 'bats_moments' + MC['out_suffix'] + '.json')


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
    """10Y-2Y in percentage points. Inverted → low BATS, steep → high BATS."""
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
    A-D across 11 SPDR sector ETFs). Negative reading → broad selling → low
    BATS; positive → broad buying → high BATS. Clamped at plus/minus 25."""
    if o is None: return None
    CLAMP = 25.0
    c = max(-CLAMP, min(CLAMP, o))
    s = 50 + (c / CLAMP) * 50
    return clamp(s, 2, 98)


# --- Wilder's 14-day RSI (matches app.js) ---
def rsi_wilder(closes, period=14):
    if len(closes) < period + 1: return None
    sumG = sumL = 0.0
    for i in range(1, period + 1):
        chg = closes[i] - closes[i - 1]
        if chg > 0: sumG += chg
        else:       sumL += -chg
    avgG = sumG / period
    avgL = sumL / period
    for i in range(period + 1, len(closes)):
        chg = closes[i] - closes[i - 1]
        g = chg if chg > 0 else 0
        l = -chg if chg < 0 else 0
        avgG = (avgG * (period - 1) + g) / period
        avgL = (avgL * (period - 1) + l) / period
    if avgL == 0: return 100
    return 100 - 100 / (1 + avgG / avgL)


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
    # Yahoo ^VIX / ^VXN both ship as Date,Close (col 1).
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
    """yields_history.csv: Date,Y2,Y10,Spread10Y2Y — column 3 is the spread in pp."""
    rows = _read_csv('yields_history.csv')
    if not rows: return None
    out = {}
    for row in rows[1:]:
        try: out[row[0]] = float(row[3])
        except: pass
    return out


def load_sector_osc():
    """sector_osc.csv: date,advances,declines,ra_net,ema5,ema10,oscillator.
    Column 6 is the MED10 oscillator we score."""
    rows = _read_csv('sector_osc.csv')
    if not rows: return None
    out = {}
    for row in rows[1:]:
        try: out[row[0]] = float(row[6])
        except: pass
    return out


# --- Snap-to-nearest-earlier-date helpers ---
def snap_le(sorted_keys, target):
    i = bisect_right(sorted_keys, target) - 1
    return sorted_keys[i] if i >= 0 else None


# --- Indicator computation on a specific date ---
def ma200_dist(dates, prices, date):
    if date not in prices: return None
    idx = dates.index(date)
    if idx < 199: return None
    window = [prices[dates[i]] for i in range(idx - 199, idx + 1)]
    ma = sum(window) / 200
    return (prices[date] / ma - 1) * 100

def return_20d(dates, prices, date):
    if date not in prices: return None
    idx = dates.index(date)
    if idx < 20: return None
    return (prices[date] / prices[dates[idx - 20]] - 1) * 100

def rsi_at(dates, prices, date, period=14):
    if date not in prices: return None
    idx = dates.index(date)
    lookback = period + 40
    start = max(0, idx - lookback)
    closes = [prices[dates[i]] for i in range(start, idx + 1)]
    return rsi_wilder(closes, period)


# --- Forward-return computation from SPX ---
def forward_return(dates, prices, date, days):
    if date not in prices: return None
    idx = dates.index(date)
    fwd_idx = idx + days
    if fwd_idx >= len(dates): return None
    return (prices[dates[fwd_idx]] / prices[date] - 1) * 100


# --- Curated moments ---
MOMENTS = [
    dict(target='2007-10-09', event='Pre-GFC all-time high',
         context='S&P 500 hit its cyclical peak. Housing bubble already leaking.'),
    dict(target='2008-11-21', event='GFC panic acceleration',
         context='SPX closed at 800 after a week of collapse; "worst since 1987."'),
    dict(target='2009-03-09', event='GFC bottom',
         context='S&P closed at 676. Financial crisis panic in full effect.'),
    dict(target='2011-08-08', event='S&P US downgrade / debt ceiling',
         context='S&P downgraded US credit; -6.7% single-day crash.'),
    dict(target='2016-02-11', event='Oil crash / deflation bottom',
         context='SPX 1829 low; energy sector wipeout, deflation fears peaked.'),
    dict(target='2018-12-24', event='Powell put / trade-war bottom',
         context='Christmas Eve low; Fed pivoted, market rallied.'),
    dict(target='2019-08-14', event='2s10s yield curve inversion',
         context='First 2s/10s inversion of the cycle; SPX dropped 3% intraday.'),
    dict(target='2020-02-19', event='Pre-COVID all-time high',
         context='Peak before the COVID crash — SPX at 3386.'),
    dict(target='2020-03-23', event='COVID crash bottom',
         context='Fed unlimited-QE announcement day; SPX bottomed at 2237.'),
    dict(target='2022-01-03', event='Post-COVID all-time high',
         context='Peak before the 2022 bear market — SPX at 4796.'),
    dict(target='2022-06-17', event='2022 first bear-market low',
         context='SPX 3675; first flush of the year. Not the ultimate low.'),
    dict(target='2022-10-12', event='2022 final bear-market bottom',
         context='SPX 3577 — the actual low of the 2022 cycle.'),
    dict(target='2023-03-13', event='SVB banking crisis',
         context='SVB collapsed the prior weekend; regional-bank contagion fear.'),
    dict(target='2023-10-27', event='Rate-panic bottom',
         context='10Y hit 5%; SPX flushed to 4117 before the year-end rally began.'),
    dict(target='2025-04-08', event='Liberation Day tariff bottom',
         context='SPX 4983; day before Trump announced 90-day tariff pause.'),
]


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
        warn(f'Missing data files: {missing}. Leaving bats_moments.json unchanged.')
        return 0

    spx_dates = sorted(spx.keys())
    spy_dates = sorted(spy.keys())
    rsp_dates = sorted(rsp.keys())
    hyg_dates = sorted(hyg.keys())
    lqd_dates = sorted(lqd.keys())
    vix_dates = sorted(vix.keys())
    aaii_dates = sorted(aaii.keys())
    naaim_dates = sorted(naaim.keys())
    yields_dates = sorted(yields.keys())
    sector_dates = sorted(sector_osc.keys())

    out_moments = []
    for m in MOMENTS:
        target = m['target']
        d_spx  = snap_le(spx_dates, target)
        d_spy  = snap_le(spy_dates, target)
        d_rsp  = snap_le(rsp_dates, target)
        d_hyg  = snap_le(hyg_dates, target)
        d_lqd  = snap_le(lqd_dates, target)
        d_vix  = snap_le(vix_dates, target)
        d_aaii = snap_le(aaii_dates, target)
        d_naaim = snap_le(naaim_dates, target)
        d_yields = snap_le(yields_dates, target)
        d_sector = snap_le(sector_dates, target)

        v_vix    = vix.get(d_vix)       if d_vix    else None
        v_aaii   = aaii.get(d_aaii)     if d_aaii   else None
        v_naaim  = naaim.get(d_naaim)   if d_naaim  else None
        v_rsi    = rsi_at(spy_dates, spy, d_spy) if d_spy else None
        v_ma     = ma200_dist(spx_dates, spx, d_spx) if d_spx else None
        v_spread = yields.get(d_yields) if d_yields else None
        v_sector = sector_osc.get(d_sector) if d_sector else None

        spy20 = return_20d(spy_dates, spy, d_spy) if d_spy else None
        rsp20 = return_20d(rsp_dates, rsp, d_rsp) if d_rsp else None
        hyg20 = return_20d(hyg_dates, hyg, d_hyg) if d_hyg else None
        lqd20 = return_20d(lqd_dates, lqd, d_lqd) if d_lqd else None

        breadth = (rsp20 - spy20) if (spy20 is not None and rsp20 is not None) else None
        junk    = (hyg20 - lqd20) if (hyg20 is not None and lqd20 is not None) else None

        components = {
            'vix':        dict(raw=v_vix,    score=score_vix(v_vix),                 weight=WEIGHTS['vix']),
            'breadth':    dict(raw=breadth,  score=score_breadth(breadth),           weight=WEIGHTS['breadth']),
            'rsi':        dict(raw=v_rsi,    score=score_rsi(v_rsi),                 weight=WEIGHTS['rsi']),
            'ma200':      dict(raw=v_ma,     score=score_ma200(v_ma),                weight=WEIGHTS['ma200']),
            'aaii':       dict(raw=v_aaii,   score=score_aaii(v_aaii),               weight=WEIGHTS['aaii']),
            'naaim':      dict(raw=v_naaim,  score=score_naaim(v_naaim),             weight=WEIGHTS['naaim']),
            'junk':       dict(raw=junk,     score=score_junk(junk),                 weight=WEIGHTS['junk']),
            'spread':     dict(raw=v_spread, score=score_spread(v_spread),           weight=WEIGHTS['spread']),
            'sector_osc': dict(raw=v_sector, score=score_sector_osc(v_sector),       weight=WEIGHTS['sector_osc']),
        }

        # Weighted blend
        w_sum = sum(c['weight'] for c in components.values() if c['score'] is not None)
        blend = (sum(c['score'] * c['weight'] for c in components.values() if c['score'] is not None) / w_sum) if w_sum > 0 else None

        # Forward SPX returns (using SPX total-price CSV; not TR)
        fwd_1m  = forward_return(spx_dates, spx, d_spx, 21)  if d_spx else None
        fwd_3m  = forward_return(spx_dates, spx, d_spx, 63)  if d_spx else None
        fwd_6m  = forward_return(spx_dates, spx, d_spx, 126) if d_spx else None
        fwd_12m = forward_return(spx_dates, spx, d_spx, 252) if d_spx else None

        spx_price = spx.get(d_spx) if d_spx else None

        out_moments.append({
            'date':        m['target'],
            'asOf':        d_spx,
            'event':       m['event'],
            'context':     m['context'],
            'spxClose':    round(spx_price, 2) if spx_price is not None else None,
            'batsScore':   round(blend, 1) if blend is not None else None,
            'bucketLabel': bucket_for(blend)['label'] if blend is not None else None,
            'bucketColor': bucket_for(blend)['color'] if blend is not None else None,
            'action':      bucket_for(blend)['action'] if blend is not None else None,
            'components': {
                k: dict(
                    raw=(round(v['raw'], 2)   if v['raw']   is not None else None),
                    score=(round(v['score'], 1) if v['score'] is not None else None),
                    weight=v['weight'],
                )
                for k, v in components.items()
            },
            'forward': dict(
                spx_1m =round(fwd_1m,  2) if fwd_1m  is not None else None,
                spx_3m =round(fwd_3m,  2) if fwd_3m  is not None else None,
                spx_6m =round(fwd_6m,  2) if fwd_6m  is not None else None,
                spx_12m=round(fwd_12m, 2) if fwd_12m is not None else None,
            ),
        })

    latest_spx_date = spx_dates[-1]
    payload = dict(
        source='Computed from data/*.csv using the same scoring functions as app.js',
        generatedAt=None,   # can't use time inside script if we want deterministic file, but ok:
        latestSpxDate=latest_spx_date,
        moments=out_moments,
        methodology=dict(
            weights=WEIGHTS,
            buckets=[dict(label=b['label'], min=b['min'], action=b['action']) for b in BUCKETS],
            forwardReturns='SPX price returns (no dividends). 1m=21 trading days, 3m=63, 6m=126, 12m=252.',
        ),
    )
    import time
    payload['generatedAt'] = int(time.time())

    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    print(f'Wrote {OUT_PATH}: {len(out_moments)} moments through {latest_spx_date}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
