#!/usr/bin/env python3
"""
Append current-year Treasury 2Y and 10Y yields to data/yields_history.csv.

The full history (1990–present, 9,000+ daily rows) was bootstrapped by
looping years 1990–2026 on Treasury.gov. This script keeps the file
current by fetching just the current calendar year and merging new rows
in by date (existing rows for the year are refreshed with today's values,
new dates get appended).

Safe on failure: if the fetch fails or the response looks wrong, the
existing yields_history.csv is left untouched.
"""

from __future__ import annotations
import csv
import io
import os
import sys
import time
import urllib.request

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH = os.path.join(REPO_ROOT, "data", "yields_history.csv")


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def fetch_current_year() -> list[tuple[str, float, float]]:
    year = time.gmtime().tm_year
    url = (
        f"https://home.treasury.gov/resource-center/data-chart-center/"
        f"interest-rates/daily-treasury-rates.csv/{year}/all"
        f"?type=daily_treasury_yield_curve&field_tdr_date_value={year}&page&_format=csv"
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode("utf-8", errors="ignore")
    except Exception as exc:
        warn(f"Treasury.gov fetch failed: {exc}")
        return []

    reader = csv.reader(io.StringIO(body))
    header = next(reader, None)
    if not header:
        warn("Treasury.gov response empty")
        return []
    idx = {c.strip('"').strip(): i for i, c in enumerate(header)}
    if "Date" not in idx or "2 Yr" not in idx or "10 Yr" not in idx:
        warn(f"Treasury.gov response missing expected columns: {header}")
        return []

    rows: list[tuple[str, float, float]] = []
    for row in reader:
        if len(row) <= max(idx["Date"], idx["2 Yr"], idx["10 Yr"]):
            continue
        d = row[idx["Date"]]
        try:
            mo, dd, yy = d.split("/")
            iso = f"{yy}-{int(mo):02d}-{int(dd):02d}"
        except Exception:
            continue
        try:
            y2 = float(row[idx["2 Yr"]])
            y10 = float(row[idx["10 Yr"]])
        except Exception:
            continue
        rows.append((iso, y2, y10))
    return rows


def load_existing() -> dict[str, tuple[float, float]]:
    out: dict[str, tuple[float, float]] = {}
    if not os.path.exists(OUT_PATH):
        return out
    with open(OUT_PATH, encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        next(reader, None)  # header
        for row in reader:
            if len(row) < 3:
                continue
            try:
                out[row[0]] = (float(row[1]), float(row[2]))
            except Exception:
                continue
    return out


def main() -> int:
    fresh = fetch_current_year()
    if not fresh:
        return 0
    existing = load_existing()

    added = 0
    updated = 0
    for iso, y2, y10 in fresh:
        prev = existing.get(iso)
        if prev is None:
            existing[iso] = (y2, y10)
            added += 1
        elif prev != (y2, y10):
            existing[iso] = (y2, y10)
            updated += 1

    if added == 0 and updated == 0:
        print(f"Yields history already current ({len(existing)} rows, latest {max(existing)})")
        return 0

    with open(OUT_PATH, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date", "Y2", "Y10", "Spread10Y2Y"])
        for d in sorted(existing):
            y2, y10 = existing[d]
            w.writerow([d, f"{y2:.2f}", f"{y10:.2f}", f"{(y10 - y2):.2f}"])

    print(f"Yields history: +{added} new, {updated} revised, {len(existing)} total, latest {max(existing)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
