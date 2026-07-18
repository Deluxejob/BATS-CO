"""Compute the daily BATS Sector Oscillator and write it to
data/sector_osc.csv.

The oscillator is a McClellan-style breadth indicator built on the
11 SPDR sector ETFs we already track daily:

  advances(d)  = # of sectors whose close(d)  > close(d-1)
  declines(d)  = # of sectors whose close(d)  < close(d-1)
  RA net(d)    = (advances - declines) / (advances + declines) * 100
  EMA-5 (RA)   = 5-period EMA of RA net
  EMA-10 (RA)  = 10-period EMA of RA net
  oscillator   = EMA-5 - EMA-10          (negative = broad selling,
                                          positive = broad buying)

Faster smoothing than the classic 19/39 McClellan because 11 sectors
gives us a smaller universe with less inherent noise. See
scratchpad/preview_sector_osc_variants.py for the parameter sweep
that led to MED10.

Output CSV columns:
  date, advances, declines, ra_net, ema5, ema10, oscillator

Run daily from the update-data workflow after the sector CSVs have
been refreshed for the day.
"""
import csv
import os
from collections import defaultdict

DATA = os.path.join(os.path.dirname(__file__), "..", "data")
SECTORS_DIR = os.path.join(DATA, "sectors")
OUT_PATH    = os.path.join(DATA, "sector_osc.csv")

SECTORS = ['xlk','xlf','xle','xlv','xli','xly','xlp','xlu','xlb','xlre','xlc']

EMA_FAST = 5
EMA_SLOW = 10


def load_sector(sym):
    """Read data/sectors/<sym>.csv -> list of (date, close)."""
    p = os.path.join(SECTORS_DIR, f"{sym}.csv")
    rows = []
    with open(p, newline='', encoding='utf-8') as f:
        rdr = csv.reader(f)
        next(rdr, None)  # header
        for r in rdr:
            if len(r) < 2:
                continue
            try:
                rows.append((r[0], float(r[1])))
            except ValueError:
                continue
    return rows


def ema(values, span):
    """Classic EMA seeded with the first value."""
    if not values:
        return []
    k = 2.0 / (span + 1)
    out = [values[0]]
    for v in values[1:]:
        out.append(out[-1] + k * (v - out[-1]))
    return out


def main() -> int:
    # Merge all sector series by date
    by_date = defaultdict(dict)
    for s in SECTORS:
        for d, c in load_sector(s):
            by_date[d][s] = c

    dates = sorted(by_date.keys())
    if len(dates) < EMA_SLOW + 2:
        print(f"WARN: only {len(dates)} rows of sector data — not enough for the oscillator")
        return 0

    # Walk forward day-by-day to compute A/D counts against yesterday's close.
    prev_closes = {}
    ra_series = []
    ad_rows = []  # (date, advances, declines, ra_net)
    for d in dates:
        a = dc = 0
        today = by_date[d]
        for s in SECTORS:
            t = today.get(s)
            p = prev_closes.get(s)
            if t is None or p is None:
                continue
            if t > p:
                a += 1
            elif t < p:
                dc += 1
        total = a + dc
        ra = ((a - dc) / total * 100) if total else 0.0
        ra_series.append(ra)
        ad_rows.append((d, a, dc, ra))
        # Update prev only for sectors that had data today so we don't
        # mis-count a missing sector as unchanged
        for s, v in today.items():
            prev_closes[s] = v

    fast = ema(ra_series, EMA_FAST)
    slow = ema(ra_series, EMA_SLOW)
    osc = [f - s for f, s in zip(fast, slow)]

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['date', 'advances', 'declines', 'ra_net', 'ema5', 'ema10', 'oscillator'])
        for (d, a, dc, ra), ef, es, o in zip(ad_rows, fast, slow, osc):
            w.writerow([d, a, dc, f"{ra:.4f}", f"{ef:.4f}", f"{es:.4f}", f"{o:.4f}"])

    latest = ad_rows[-1]
    print(f"wrote {OUT_PATH}: {len(ad_rows)} rows, "
          f"latest={latest[0]} A={latest[1]} D={latest[2]} osc={osc[-1]:+.2f}")
    return 0


if __name__ == "__main__":
    import sys
    try:
        sys.exit(main())
    except Exception as e:
        # Tolerant failure — don't kill the rest of the daily workflow
        print(f"WARN: sector-osc build failed: {e}")
        sys.exit(0)
