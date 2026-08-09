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
import json
import os
import sys
import urllib.parse
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

# Two fetch paths depending on whether we have a FRED API key:
#
# 1) If FRED_API_KEY env var is set (set as a GitHub Actions secret on the
#    workflow), use api.stlouisfed.org — the real FRED API. Full history for
#    every series, no anonymous rate caps. Preferred.
#
# 2) Otherwise, fall back to fredgraph.csv. That works for everything BUT
#    the BofA-branded credit-spread series (BAMLH0A0HYM2, BAMLC0A0CM),
#    which FRED restricts to the last ~3 years for anonymous callers. The
#    non-BofA series (T10Y2Y, T10Y3M, ICSA, UNRATE, USREC) come through
#    with full history on either path.
FRED_API_KEY = os.environ.get("FRED_API_KEY", "").strip()
FRED_API_URL = "https://api.stlouisfed.org/fred/series/observations"
FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={}&cosd=1900-01-01"


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def fetch_via_api(series_id: str) -> list[tuple[str, str]]:
    """Fetch full history via the authenticated FRED API. Empty on failure.

    Explicitly sets every "start of time" param so nothing about our request
    is what's limiting the returned range:
      - observation_start: earliest observation to include
      - realtime_start:    earliest data-vintage to consider (FRED tracks
                           revisions; without this, defaults to today which
                           for some series clips historical data)
      - limit:             max rows returned per call (FRED cap = 100000,
                           safely above ~30 years of daily data)
    Also logs the payload's `count` so we can see what FRED is actually
    willing to send us for series we suspect are truncated.
    """
    params = {
        "series_id":            series_id,
        "api_key":              FRED_API_KEY,
        "file_type":            "json",
        "observation_start":    "1900-01-01",
        "limit":                "100000",
    }
    url = FRED_API_URL + "?" + urllib.parse.urlencode(params)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            payload = json.loads(r.read().decode("utf-8", errors="ignore"))
    except Exception as exc:
        warn(f"FRED API {series_id} fetch failed: {exc}")
        return []
    obs = payload.get("observations") or []
    count = payload.get("count", "?")
    obs_start = payload.get("observation_start", "?")
    print(f"  {series_id}: FRED API returned count={count}, obs_start={obs_start}, len(observations)={len(obs)}")
    rows: list[tuple[str, str]] = []
    for o in obs:
        date = (o.get("date") or "").strip()
        val  = (o.get("value") or "").strip()
        if not date or val in ("", ".", "NA"):
            continue
        try:
            float(val)
        except ValueError:
            continue
        rows.append((date, val))
    rows.sort(key=lambda x: x[0])
    return rows


def fetch_via_csv(series_id: str) -> list[tuple[str, str]]:
    """Anonymous fredgraph.csv fallback — full history on most series but
    truncated to ~3 years for the BofA credit-spread series."""
    url = FRED_CSV_URL.format(series_id)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
        with urllib.request.urlopen(req, timeout=45) as r:
            text = r.read().decode("utf-8", errors="ignore")
    except Exception as exc:
        warn(f"FRED CSV {series_id} fetch failed: {exc}")
        return []
    rows: list[tuple[str, str]] = []
    lines = text.strip().splitlines()
    if not lines:
        warn(f"FRED CSV {series_id}: empty response")
        return []
    for line in lines[1:]:
        parts = line.split(",")
        if len(parts) < 2:
            continue
        date, val = parts[0].strip(), parts[1].strip()
        if val in ("", ".", "NA"):
            continue
        try:
            float(val)
        except ValueError:
            continue
        rows.append((date, val))
    rows.sort(key=lambda x: x[0])
    return rows


def fetch_fred_series(series_id: str) -> list[tuple[str, str]]:
    """Return [(YYYY-MM-DD, value_str)] sorted by date. Empty on failure.
    Prefers the API path when a key is available; falls back to CSV."""
    if FRED_API_KEY:
        return fetch_via_api(series_id)
    return fetch_via_csv(series_id)


def write_series(rows: list[tuple[str, str]], filename: str, value_col: str) -> None:
    out_path = os.path.join(DATA_DIR, filename)
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date", value_col])
        for date, val in rows:
            w.writerow([date, val])


def main() -> int:
    print(f"Risk Watch: fetch path = {'FRED API (authenticated)' if FRED_API_KEY else 'fredgraph.csv (anonymous, ~3yr cap on BofA series)'}")
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
