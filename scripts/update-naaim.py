#!/usr/bin/env python3
"""
Refresh data/naaim.csv from the NAAIM Exposure Index page at naaim.org.

The download URL includes a Wednesday date and shifts weekly, so we scrape
the page for the current `.xlsx` link, fetch it, parse with openpyxl, and
overwrite the CSV.

Runs safely: on any failure the existing CSV is left unchanged.
"""

from __future__ import annotations
import csv
import os
import re
import sys
import tempfile
import urllib.error
import urllib.request

try:
    import openpyxl  # type: ignore
except ImportError:
    print("::warning::openpyxl not installed; skipping NAAIM refresh")
    sys.exit(0)

INDEX_URL = "https://www.naaim.org/programs/naaim-exposure-index/"
UA = "Mozilla/5.0"

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH = os.path.join(REPO_ROOT, "data", "naaim.csv")


def find_xlsx_url() -> str | None:
    try:
        req = urllib.request.Request(INDEX_URL, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            html = r.read().decode("utf-8", errors="ignore")
    except urllib.error.URLError as e:
        print(f"::warning::Couldn't reach naaim.org index page: {e}")
        return None
    m = re.search(
        r'href="(https?://[^"]*naaim\.org/[^"]*USE_Data[^"]*\.xlsx)"',
        html,
        flags=re.IGNORECASE,
    )
    if not m:
        print("::warning::No USE_Data*.xlsx link found on naaim.org page")
        return None
    return m.group(1)


def fetch_xlsx(url: str) -> str | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        if len(data) < 20_000:
            print(f"::warning::NAAIM XLSX suspiciously small ({len(data)} bytes)")
            return None
        f = tempfile.NamedTemporaryFile(delete=False, suffix=".xlsx")
        f.write(data)
        f.close()
        return f.name
    except urllib.error.URLError as e:
        print(f"::warning::Failed to fetch NAAIM XLSX: {e}")
        return None


def parse_xlsx(path: str) -> list[list[str]] | None:
    """Return [(date, naaim_number), ...] as strings, sorted by date."""
    try:
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    except Exception as e:  # noqa: BLE001
        print(f"::warning::openpyxl could not open NAAIM XLSX: {e}")
        return None
    sh = wb.active
    seen: set[str] = set()
    rows: list[tuple[str, float]] = []
    for row in sh.iter_rows(min_row=2, values_only=True):
        if not row:
            continue
        dt = row[0]
        val = row[8] if len(row) > 8 else None
        if not hasattr(dt, "strftime"):
            continue
        if not isinstance(val, (int, float)):
            continue
        d = dt.strftime("%Y-%m-%d")
        if d in seen:
            continue
        seen.add(d)
        rows.append((d, float(val)))
    rows.sort()
    return rows or None


def main() -> int:
    url = find_xlsx_url()
    if not url:
        return 0

    xlsx = fetch_xlsx(url)
    if not xlsx:
        return 0

    rows = parse_xlsx(xlsx)
    try:
        os.unlink(xlsx)
    except OSError:
        pass
    if not rows:
        print("::warning::NAAIM parse produced no rows; leaving CSV unchanged")
        return 0
    if len(rows) < 100:
        print(f"::warning::Suspiciously few NAAIM rows ({len(rows)}); leaving unchanged")
        return 0

    with open(OUT_PATH, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date", "NAAIM"])
        w.writerows(rows)
    print(f"Updated {OUT_PATH} ({len(rows)} rows, latest {rows[-1][0]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
