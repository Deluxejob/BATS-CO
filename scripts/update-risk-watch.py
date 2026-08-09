#!/usr/bin/env python3
"""
Fetch every data series that feeds the Risk Watch page in one script,
each series to its own CSV under data/. Runs from the daily workflow.

Series pulled from FRED:
  BAMLH0A0HYM2  -> data/hy_oas.csv           US high-yield OAS (bps)
  BAMLC0A0CM    -> data/ig_oas.csv           US investment-grade OAS (bps)
  T10Y2Y        -> data/t10y2y.csv           10Y-2Y Treasury spread (%)
  T10Y3M        -> data/t10y3m.csv           10Y-3M Treasury spread (%)
  ICSA          -> data/jobless_claims.csv   Initial jobless claims (thousands)
  UNRATE        -> data/unrate.csv           Unemployment rate (%)
  USREC         -> data/nber_recession.csv   NBER recession indicator (0/1)

Each series is fetched independently; a failure on one leaves the other
six CSVs unchanged. Same curl-style User-Agent trick as the Buffett
indicator fetch — FRED silently rejects browser-style Mozilla UAs.
"""

from __future__ import annotations
import csv
import os
import sys
import urllib.request

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR  = os.path.join(REPO_ROOT, "data")

# (fred_id, out_filename, value_column_name)
SERIES = [
    ("BAMLH0A0HYM2", "hy_oas.csv",         "OAS"),
    ("BAMLC0A0CM",   "ig_oas.csv",         "OAS"),
    ("T10Y2Y",       "t10y2y.csv",         "Spread"),
    ("T10Y3M",       "t10y3m.csv",         "Spread"),
    ("ICSA",         "jobless_claims.csv", "Claims"),
    ("UNRATE",       "unrate.csv",         "Rate"),
    ("USREC",        "nber_recession.csv", "IsRecession"),
]

FRED_URL_FMT = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={}"


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def fetch_fred_series(series_id: str) -> list[tuple[str, str]]:
    """Return [(YYYY-MM-DD, value_str)] sorted by date. Empty on failure."""
    url = FRED_URL_FMT.format(series_id)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
        with urllib.request.urlopen(req, timeout=45) as r:
            text = r.read().decode("utf-8", errors="ignore")
    except Exception as exc:
        warn(f"FRED {series_id} fetch failed: {exc}")
        return []

    rows: list[tuple[str, str]] = []
    lines = text.strip().splitlines()
    if not lines:
        warn(f"FRED {series_id}: empty response")
        return []
    for line in lines[1:]:   # skip header
        parts = line.split(",")
        if len(parts) < 2:
            continue
        date, val = parts[0].strip(), parts[1].strip()
        if val in ("", ".", "NA"):
            continue
        # Sanity-check the value parses as float, but keep the original
        # string so we don't drift precision on repeated round-trips.
        try:
            float(val)
        except ValueError:
            continue
        rows.append((date, val))
    rows.sort(key=lambda x: x[0])
    return rows


def write_series(rows: list[tuple[str, str]], filename: str, value_col: str) -> None:
    out_path = os.path.join(DATA_DIR, filename)
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date", value_col])
        for date, val in rows:
            w.writerow([date, val])


def main() -> int:
    ok_count = 0
    for series_id, filename, value_col in SERIES:
        rows = fetch_fred_series(series_id)
        if not rows:
            continue   # warning already printed; leave existing CSV alone
        write_series(rows, filename, value_col)
        latest_date, latest_val = rows[-1]
        print(f"{series_id:15} -> {filename:22} {len(rows):>5} rows, latest {latest_date} = {latest_val}")
        ok_count += 1
    if ok_count == 0:
        warn("Risk Watch: no series were successfully fetched")
        return 1
    print(f"Risk Watch: {ok_count}/{len(SERIES)} series updated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
