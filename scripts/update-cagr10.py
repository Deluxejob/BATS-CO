#!/usr/bin/env python3
"""
Build data/spx_cagr10.csv — the S&P 500's trailing 10-year annualised total
return (dividends reinvested), one row per month, for windows ending
1936-01 onward ("rolling 10-year windows since 1926").

Two inputs are stitched into one monthly total-return index:
  data/shiller_tr_monthly.csv  Robert Shiller's monthly S&P price + dividend
                               data (ie_data.xls) turned into a total-return
                               index, 1871-01 .. 2023-09. Static seed file.
  data/sp500tr.csv             Daily S&P 500 Total Return index (^SP500TR)
                               from Yahoo, refreshed nightly. Its last close
                               of each month extends the seed from 2023-10 on.
The current month uses the latest close, so the last row moves daily.

risk-watch.html shows the latest value and its percentile against every
row in the file. Safe on failure: any problem leaves the existing CSV alone
and exits 0 — a non-zero exit would skip the nightly commit.
"""

from __future__ import annotations
import csv
import os
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SEED_PATH = os.path.join(REPO_ROOT, "data", "shiller_tr_monthly.csv")
TR_PATH = os.path.join(REPO_ROOT, "data", "sp500tr.csv")
OUT_PATH = os.path.join(REPO_ROOT, "data", "spx_cagr10.csv")
FIRST_WINDOW_END = "1936-01"   # 10 years after 1926-01


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def read_rows(path: str) -> list[tuple[str, float]]:
    out = []
    with open(path, encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        next(reader, None)
        for row in reader:
            if len(row) < 2:
                continue
            try:
                out.append((row[0], float(row[1])))
            except ValueError:
                continue
    return out


def main() -> int:
    try:
        seed = read_rows(SEED_PATH)
        daily = read_rows(TR_PATH)
    except Exception as exc:
        warn(f"cagr10: could not read inputs: {exc}")
        return 0
    if len(seed) < 1200 or len(daily) < 100:
        warn("cagr10: inputs look too short; leaving CSV unchanged")
        return 0

    # Monthly index: {YYYY-MM: TR}. Seed first, then Yahoo's last close of
    # each later month, rescaled so the two series meet at the seed's end.
    monthly: dict[str, float] = {d[:7]: v for d, v in seed}
    seed_end = max(monthly)
    last_close: dict[str, float] = {}
    for d, v in daily:
        last_close[d[:7]] = v          # rows are date-ascending, so the last wins
    if seed_end not in last_close:
        warn(f"cagr10: sp500tr.csv has no data for {seed_end}; cannot splice")
        return 0
    scale = monthly[seed_end] / last_close[seed_end]
    for ym in sorted(last_close):
        if ym > seed_end:
            monthly[ym] = last_close[ym] * scale

    months = sorted(monthly)
    idx = {ym: i for i, ym in enumerate(months)}
    rows = []
    for ym in months:
        if ym < FIRST_WINDOW_END:
            continue
        y, m = int(ym[:4]), int(ym[5:7])
        start = f"{y - 10:04d}-{m:02d}"
        if start not in idx:
            continue
        cagr = (monthly[ym] / monthly[start]) ** 0.1 - 1
        rows.append((ym + "-01", cagr))

    if len(rows) < 1000:
        warn("cagr10: suspiciously few rows computed; leaving CSV unchanged")
        return 0

    with open(OUT_PATH, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date", "CAGR10"])
        for d, v in rows:
            w.writerow([d, f"{v * 100:.2f}"])
    print(f"cagr10: wrote {len(rows)} rows, latest {rows[-1][0]} = {rows[-1][1] * 100:.2f}%/yr")
    return 0


if __name__ == "__main__":
    sys.exit(main())
