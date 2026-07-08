#!/usr/bin/env python3
"""
Fetch the U-Michigan Consumer Sentiment Index monthly series from FRED
(series id UMCSENT) and refresh data/umcsent.csv. Runs as part of the
daily update workflow. If the fetch fails, the existing CSV is left
untouched.

Column layout on disk: Date,Sentiment (month = first day of the month).
"""

from __future__ import annotations
import csv
import io
import os
import sys
import urllib.request
import urllib.error

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH = os.path.join(REPO_ROOT, "data", "umcsent.csv")

FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=UMCSENT"


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def fetch() -> str | None:
    req = urllib.request.Request(FRED_URL, headers={
        "User-Agent": "Mozilla/5.0 (BATS.CO daily update bot)",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError) as e:
        warn(f"FRED UMCSENT fetch failed: {e}")
        return None


def main() -> int:
    text = fetch()
    if text is None:
        return 0  # leave existing CSV as-is

    reader = csv.reader(io.StringIO(text))
    header = next(reader, None)
    if not header or header[0].lower() not in ("observation_date", "date"):
        warn(f"Unexpected header: {header!r}. Leaving {OUT_PATH} unchanged.")
        return 0

    rows: list[tuple[str, float]] = []
    for row in reader:
        if len(row) < 2:
            continue
        date, val = row[0], row[1]
        if not val or val == ".":
            continue  # empty months (start-of-series holes)
        try:
            rows.append((date, float(val)))
        except ValueError:
            continue

    if len(rows) < 300:
        warn(f"Suspiciously few rows ({len(rows)}); leaving {OUT_PATH} unchanged.")
        return 0

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Date", "Sentiment"])
        for date, val in rows:
            w.writerow([date, val])

    print(f"Updated {OUT_PATH}: {len(rows)} monthly readings ({rows[0][0]} to {rows[-1][0]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
