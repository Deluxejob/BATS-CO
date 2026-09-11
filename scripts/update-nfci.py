#!/usr/bin/env python3
"""
Fetch the Chicago Fed National Financial Conditions Index (NFCI) and
its adjusted variant (ANFCI) from FRED. Writes data/nfci.csv:

    Date,NFCI,ANFCI

The NFCI is a weekly synthesis of ~105 measures of US financial activity.
Positive values = tighter-than-average conditions (stress). Negative =
looser (accommodative). Published Wednesday afternoons for the previous
Friday's data. Same 1971-to-present history for both series.

Two fetch paths, same as update-risk-watch.py:
  1) FRED_API_KEY set  -> api.stlouisfed.org (authenticated, reliable)
  2) otherwise         -> fredgraph.csv (anonymous)
If the API path returns nothing we still try the CSV path.

This step must NEVER fail the workflow. It runs mid-pipeline, ahead of
the "Commit and push" step; a non-zero exit here would throw away every
other dataset fetched that night (that is exactly what happened 2026-09-08
through 09-11). On any failure we warn, leave the existing data/nfci.csv
in place, and exit 0. The Two-Gate card already shows a stale note when
the reading is more than 10 days old.
"""
from __future__ import annotations
import csv
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH  = os.path.join(REPO_ROOT, "data", "nfci.csv")

FRED_API_KEY = os.environ.get("FRED_API_KEY", "").strip()
FRED_API_URL = "https://api.stlouisfed.org/fred/series/observations"
FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={}&cosd=1900-01-01"

# FRED sits behind Cloudflare and has been observed rejecting unfamiliar
# User-Agents from datacenter IPs (GitHub runners). curl/8.0 is what the
# Risk Watch step sends and it has never been blocked.
HEADERS = {"User-Agent": "curl/8.0"}

ATTEMPTS = 3


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def _parse_float(val: str):
    val = (val or "").strip()
    if val in ("", ".", "NA"):
        return None
    try:
        return float(val)
    except ValueError:
        return None


def fetch_via_api(series_id: str) -> dict[str, float]:
    params = {
        "series_id":         series_id,
        "api_key":           FRED_API_KEY,
        "file_type":         "json",
        "observation_start": "1900-01-01",
        "limit":             "100000",
    }
    url = FRED_API_URL + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as r:
        payload = json.loads(r.read().decode("utf-8", errors="ignore"))
    out: dict[str, float] = {}
    for o in payload.get("observations") or []:
        d = (o.get("date") or "").strip()
        v = _parse_float(o.get("value"))
        if d and v is not None:
            out[d] = v
    return out


def fetch_via_csv(series_id: str) -> dict[str, float]:
    url = FRED_CSV_URL.format(series_id)
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=45) as r:
        text = r.read().decode("utf-8", errors="ignore")
    out: dict[str, float] = {}
    reader = csv.reader(io.StringIO(text))
    next(reader, None)  # header
    for row in reader:
        if len(row) < 2:
            continue
        d = (row[0] or "").strip()
        v = _parse_float(row[1])
        if d and v is not None:
            out[d] = v
    return out


def fetch_with_retry(fn, series_id: str, label: str) -> dict[str, float]:
    for attempt in range(1, ATTEMPTS + 1):
        try:
            data = fn(series_id)
            if data:
                return data
            warn(f"{label} {series_id}: empty response (attempt {attempt}/{ATTEMPTS})")
        except Exception as exc:
            warn(f"{label} {series_id}: {exc} (attempt {attempt}/{ATTEMPTS})")
        if attempt < ATTEMPTS:
            time.sleep(2 * attempt)
    return {}


def fetch_series(series_id: str) -> dict[str, float]:
    data: dict[str, float] = {}
    if FRED_API_KEY:
        data = fetch_with_retry(fetch_via_api, series_id, "FRED API")
    if not data:
        data = fetch_with_retry(fetch_via_csv, series_id, "FRED CSV")
    return data


def main() -> int:
    print(f"NFCI: fetch path = {'FRED API (authenticated) with CSV fallback' if FRED_API_KEY else 'fredgraph.csv (anonymous)'}")
    nfci  = fetch_series("NFCI")
    anfci = fetch_series("ANFCI")

    if not nfci:
        warn("NFCI unavailable after retries; leaving existing data/nfci.csv untouched.")
        return 0
    if not anfci:
        warn("ANFCI unavailable; writing NFCI-only rows (ANFCI column left blank).")

    dates = sorted(set(nfci) | set(anfci))
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8", newline="\n") as f:
        w = csv.writer(f)
        w.writerow(["Date", "NFCI", "ANFCI"])
        for d in dates:
            n = nfci.get(d)
            a = anfci.get(d)
            w.writerow([
                d,
                "" if n is None else f"{n:.4f}",
                "" if a is None else f"{a:.4f}",
            ])
    print(f"Wrote {OUT_PATH}: {len(dates):,} weekly readings ({dates[0]} to {dates[-1]}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
